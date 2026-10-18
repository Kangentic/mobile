import { AppState, Platform } from 'react-native';
import notifee from '@notifee/react-native';
import * as Notifications from 'expo-notifications';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { CONNECTION_CHANNEL_ID, CONNECTION_NOTIFICATION_ID } from './categoryCopy';
import { decryptPushBlob, extractBlobFromTaskData } from './pushDecrypt';
import { readPostedAt, routingFromNotificationData, routingNamesAnything } from './notificationRouting';
import {
  getOpenNotificationSurfaces,
  publishNotificationDismissed,
  subscribeToDisplayedNotifications,
  subscribeToOpenedNotificationSurfaces,
  type DisplayedNotificationNote,
} from './notificationSignals';
import { judgeNotification, observeAtFirstSight, type JudgedNotification, type StalenessContext } from './notificationStaleness';

/**
 * The stale-notification reconciler: lists what this app has on screen, asks
 * notificationStaleness.ts which of it stopped being true, and cancels that.
 * The rules, and the reasoning behind "never dismiss on unknown", live there;
 * this file only reads, decrypts and cancels.
 *
 * The two platforms differ in what a displayed alert can tell us:
 *
 * - ANDROID: every alert is posted by this app through notifee, so the routing
 *   is in its `data` and the id is ours (deterministic since this module
 *   shipped, see notificationIdForRouting). Read with getDisplayedNotifications,
 *   cancelled with cancelNotification. The keepalive's connection notification
 *   is never touched.
 * - iOS: the OS draws the alert from the APNs request and the extension never
 *   writes task identity into it (targets/nse/), so each presented alert's
 *   sealed blob is decrypted HERE, in memory, the same way the tap router does,
 *   and dismissed by its request identifier. Nothing decrypted is stored
 *   anywhere OS-visible or logged.
 *
 * EVERY FAILURE IS SWALLOWED, SILENTLY. A reconciler that cannot read or cancel
 * leaves the alerts exactly as they were, which is today's behaviour. Nothing
 * here logs (e2e-notification-privacy.md) and nothing reports to Sentry
 * (crash-reporting-scope.md bans this directory).
 */

type TrackedNotification = JudgedNotification & { platformId: string };

let tracked: TrackedNotification[] = [];
/** Alerts noted while a native read was in flight, which that read may predate. */
let notedDuringRead = new Map<string, TrackedNotification>();
let readInFlight = false;

let refreshRequested = false;
let rejudgeRequested = false;
let passScheduled = false;
let passRunning = false;

/**
 * The surfaces the user is looking at, only while the app is in front. A screen
 * stays mounted when the app is backgrounded, and the keepalive's alert for the
 * task on that screen must not be eaten the moment it is posted. 'unknown' is a
 * cold start's first state, when the screen that just mounted IS in front.
 */
function openSurfacesInFront(): StalenessContext['openSurfaces'] {
  const appState = AppState.currentState;
  return appState === 'active' || appState === 'unknown' ? getOpenNotificationSurfaces() : [];
}

function readContext(): StalenessContext {
  const boardState = useBoardStore.getState();
  const activityState = useActivityStore.getState();
  return {
    now: Date.now(),
    projects: boardState.projects,
    boardsByProjectId: boardState.boardsByProjectId,
    bySessionId: activityState.bySessionId,
    endedSessionIds: activityState.endedSessionIds,
    openSurfaces: openSurfacesInFront(),
  };
}

/**
 * Keeps what an earlier pass learned about an alert (its first sight), unless
 * the alert was posted again under the same id: a fixed id now means a repost
 * REPLACES, and the replacement is a new alert that must not inherit the old
 * one's first sight.
 */
function mergeTracked(previous: TrackedNotification | undefined, next: TrackedNotification): TrackedNotification {
  if (previous === undefined || previous.kind !== 'routed' || next.kind !== 'routed') return next;
  if (previous.postedAt !== next.postedAt) return next;
  return {
    ...next,
    firstSeenSwimlaneId: previous.firstSeenSwimlaneId ?? next.firstSeenSwimlaneId,
    firstSeenPromptId: previous.firstSeenPromptId ?? next.firstSeenPromptId,
  };
}

async function readAndroidDisplayed(previousById: ReadonlyMap<string, TrackedNotification>): Promise<TrackedNotification[]> {
  const displayed = await notifee.getDisplayedNotifications();
  const result: TrackedNotification[] = [];
  for (const item of displayed) {
    const platformId = item.id ?? item.notification.id;
    if (typeof platformId !== 'string' || platformId.length === 0) continue;
    const notification = item.notification;
    // The keepalive's notification, by its fixed id and by its channel. Not by
    // its foreground-service flag: tests/unit/foregroundServiceStartConfinement
    // keeps that word in foregroundService.ts alone, as the one start path. A
    // cancel would not reach it anyway (notifee's cancels skip foreground
    // service notifications); this keeps it out of judging altogether.
    if (platformId === CONNECTION_NOTIFICATION_ID || notification.android?.channelId === CONNECTION_CHANNEL_ID) continue;
    const postedAt = readPostedAt(notification.data, item.date);
    const routing = routingFromNotificationData(notification.data);
    const next: TrackedNotification =
      routing === null || !routingNamesAnything(routing)
        ? { platformId, kind: 'android-placeholder', postedAt }
        : { platformId, kind: 'routed', routing, postedAt, firstSeenSwimlaneId: null, firstSeenPromptId: null };
    result.push(mergeTracked(previousById.get(platformId), next));
  }
  return result;
}

/**
 * expo-notifications reports an iOS alert's date in SECONDS
 * (`notification.date.timeIntervalSince1970` in its NotificationRecords.swift),
 * despite the shared `date: number` type. Normalised by magnitude rather than
 * by platform so a future fix upstream cannot silently turn it into a date in
 * the year 50000: 1e12 ms is 2001, and 1e12 s is far in the future.
 */
function epochMsFromPresentedDate(date: unknown): number | null {
  if (typeof date !== 'number' || !Number.isFinite(date) || date <= 0) return null;
  return date < 1e12 ? date * 1000 : date;
}

async function readIosPresented(previousById: ReadonlyMap<string, TrackedNotification>): Promise<TrackedNotification[]> {
  const presented = await Notifications.getPresentedNotificationsAsync();
  const result: TrackedNotification[] = [];
  for (const notification of presented) {
    const platformId: unknown = notification.request.identifier;
    if (typeof platformId !== 'string' || platformId.length === 0) continue;
    // An iOS identifier names one delivered push for its whole life, so a
    // decrypt already done is reused. One that could not be opened is retried:
    // the key may simply not have been readable the last time.
    const previous = previousById.get(platformId);
    if (previous !== undefined && previous.kind === 'routed') {
      result.push(previous);
      continue;
    }
    const blob = extractBlobFromTaskData(notification.request.content.data);
    // Not ours, or not sealed: nothing to judge it by.
    if (blob === null) continue;
    const postedAt = epochMsFromPresentedDate(notification.date);
    const decrypted = await decryptPushBlob(blob);
    const routing = decrypted === null ? null : routingFromNotificationData(decrypted.data);
    result.push(
      routing === null
        ? { platformId, kind: 'ios-undecryptable', postedAt }
        : { platformId, kind: 'routed', routing, postedAt, firstSeenSwimlaneId: null, firstSeenPromptId: null },
    );
  }
  return result;
}

/** The only native read: replaces the tracked list with what is actually on screen. */
async function refreshTracked(): Promise<void> {
  readInFlight = true;
  notedDuringRead = new Map();
  try {
    const previousById = new Map(tracked.map((record) => [record.platformId, record]));
    const read = Platform.OS === 'android' ? await readAndroidDisplayed(previousById) : await readIosPresented(previousById);
    const readIds = new Set(read.map((record) => record.platformId));
    // An alert posted while the read was in flight may be missing from it, and
    // one the read did catch keeps what its note knew (the prompt at post).
    const merged = read.map((record) => {
      const noted = notedDuringRead.get(record.platformId);
      return noted === undefined ? record : mergeTracked(noted, record);
    });
    const notedLate = [...notedDuringRead.values()].filter((record) => !readIds.has(record.platformId));
    tracked = [...merged, ...notedLate];
  } catch {
    // The list could not be read: keep judging what is already tracked.
  } finally {
    readInFlight = false;
    notedDuringRead = new Map();
  }
}

async function cancelPlatformNotification(record: TrackedNotification): Promise<void> {
  if (Platform.OS === 'android') {
    await notifee.cancelNotification(record.platformId);
    return;
  }
  await Notifications.dismissNotificationAsync(record.platformId);
}

/** Judges the tracked list against the stores, with no native read; cancels what is stale. */
async function rejudgeTracked(): Promise<void> {
  if (tracked.length === 0) return;
  const context = readContext();
  const kept: TrackedNotification[] = [];
  const dismissed: TrackedNotification[] = [];
  for (const record of tracked) {
    let current = record;
    if (current.kind === 'routed' && (current.firstSeenSwimlaneId === null || current.firstSeenPromptId === null)) {
      const sight = observeAtFirstSight(current, context);
      current = {
        ...current,
        firstSeenSwimlaneId: current.firstSeenSwimlaneId ?? sight.swimlaneId,
        firstSeenPromptId: current.firstSeenPromptId ?? sight.promptId,
      };
    }
    if (judgeNotification(current, context) === 'dismiss') {
      dismissed.push(current);
    } else {
      kept.push(current);
    }
  }
  tracked = kept;
  if (dismissed.length === 0) return;
  await Promise.allSettled(dismissed.map((record) => cancelPlatformNotification(record)));
  for (const record of dismissed) {
    if (record.kind === 'routed') publishNotificationDismissed(record.routing);
  }
}

async function runPasses(): Promise<void> {
  if (passRunning) return;
  passRunning = true;
  try {
    while (refreshRequested || rejudgeRequested) {
      const shouldRefresh = refreshRequested;
      refreshRequested = false;
      rejudgeRequested = false;
      if (shouldRefresh) await refreshTracked();
      await rejudgeTracked();
    }
  } catch {
    // Swallowed: see the file header.
  } finally {
    passRunning = false;
  }
}

/**
 * Asks for a pass, coalesced: any number of requests in one tick make one pass
 * (a bootstrap's burst of board snapshots, a foreground that also opens a
 * screen, cost one native read), and a request during a pass makes one more
 * after it. Deferred a microtask rather than run in place because a zustand
 * subscriber runs INSIDE the store write: a board snapshot's listener fires
 * before storeFeed has pruned the sessions that board stopped naming, so the
 * deferral also lets the snapshot and its prune be judged together, once.
 */
function requestPass(options: { refresh: boolean }): void {
  if (options.refresh) refreshRequested = true;
  rejudgeRequested = true;
  if (passScheduled || passRunning) return;
  passScheduled = true;
  queueMicrotask(() => {
    passScheduled = false;
    void runPasses();
  });
}

function onNotificationDisplayed(note: DisplayedNotificationNote): void {
  // notifee resolves the id it posted under; a bridge that resolved nothing
  // leaves the next native read to find the alert instead.
  if (typeof note.platformId !== 'string' || note.platformId.length === 0) return;
  const record: TrackedNotification =
    note.routing === null || !routingNamesAnything(note.routing)
      ? { platformId: note.platformId, kind: 'android-placeholder', postedAt: note.postedAt }
      : {
          platformId: note.platformId,
          kind: 'routed',
          routing: note.routing,
          postedAt: note.postedAt,
          firstSeenSwimlaneId: null,
          firstSeenPromptId: note.promptIdAtPost,
        };
  tracked = [...tracked.filter((existing) => existing.platformId !== note.platformId), record];
  if (readInFlight) notedDuringRead.set(note.platformId, record);
  requestPass({ refresh: false });
}

let stopActiveReconciler: (() => void) | null = null;

/**
 * Starts the reconciler; returns the stop. Idempotent. Runs for the life of the
 * process, foreground and background alike, which is what makes it the live
 * cancel during the Android keepalive: the activity subscription below is
 * always on, so an answer at the desk clears the phone's alert while the app is
 * still in the background.
 *
 * The native list is read only when something may have appeared that this
 * process did not post: a foreground, the first board after start (a cold start
 * fires no 'active' event), and a surface opening. Everything else re-judges the
 * list already held, which costs a few lookups and no bridge call.
 */
export function startNotificationReconciler(): () => void {
  if (stopActiveReconciler !== null) return stopActiveReconciler;

  const appStateSubscription = AppState.addEventListener('change', (status) => {
    if (status === 'active') requestPass({ refresh: true });
  });

  let readSinceStart = false;
  let previousBoards = useBoardStore.getState().boardsByProjectId;
  let previousProjects = useBoardStore.getState().projects;
  const unsubscribeBoard = useBoardStore.subscribe((state) => {
    if (state.boardsByProjectId === previousBoards && state.projects === previousProjects) return;
    previousBoards = state.boardsByProjectId;
    previousProjects = state.projects;
    const refresh = !readSinceStart;
    readSinceStart = true;
    if (!refresh && tracked.length === 0) return;
    requestPass({ refresh });
  });

  let previousBySessionId = useActivityStore.getState().bySessionId;
  let previousEndedSessionIds = useActivityStore.getState().endedSessionIds;
  const unsubscribeActivity = useActivityStore.subscribe((state) => {
    if (state.bySessionId === previousBySessionId && state.endedSessionIds === previousEndedSessionIds) return;
    previousBySessionId = state.bySessionId;
    previousEndedSessionIds = state.endedSessionIds;
    if (tracked.length === 0) return;
    requestPass({ refresh: false });
  });

  const unsubscribeSurfaces = subscribeToOpenedNotificationSurfaces(() => requestPass({ refresh: true }));
  const unsubscribeDisplayed = subscribeToDisplayedNotifications(onNotificationDisplayed);

  const stop = (): void => {
    appStateSubscription.remove();
    unsubscribeBoard();
    unsubscribeActivity();
    unsubscribeSurfaces();
    unsubscribeDisplayed();
    tracked = [];
    stopActiveReconciler = null;
  };
  stopActiveReconciler = stop;
  return stop;
}
