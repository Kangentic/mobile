import { AppState, type AppStateStatus, type NativeEventSubscription } from 'react-native';
import notifee from '@notifee/react-native';
import type { PushCategory } from '@kangentic/protocol';
import { useActivityStore, type SessionActivityEntry } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useSettingsStore } from '@/state/settingsStore';
import { channelIdForCategory, titleForCategory } from './categoryCopy';
import { ANDROID_NOTIFICATION_PRESENTATION } from './channels';

/**
 * The foreground-service mode's local alerting: while the app is
 * BACKGROUNDED with the secure channel still alive, activity-store
 * transitions become notifee notifications, giving instant local alerts
 * without any push infrastructure. Subscribing to the store (not the wire)
 * means mock, stub, and live modes all behave identically. Fully
 * suppressed while the app is foregrounded - the in-app UI is the surface
 * there - and the desktop suppresses its remote push while this phone's
 * channel is established, so local and remote never double-fire.
 *
 * Reuses the PushCategory vocabulary (titleForCategory / channelIdForCategory
 * from categoryCopy.ts, re-exported by channels.ts for its notifee-backed
 * callers) rather than a separate local kind set, so a remote push
 * and a local alert for the same event class always agree on copy and
 * channel. Only three categories have an activity-store signal to fire
 * from; plan-complete and spawn-stalled are push-only.
 */

/** Matches the desktop's own per-(session, category) push cooldown. */
const LOCAL_NOTIFICATION_COOLDOWN_MS = 30_000;

/**
 * How long a session must stay idle before 'turn-complete' fires.
 *
 * WITHOUT THIS, a conversation is one alert per reply. The category fires on a
 * thinking -> idle transition and every exchange ends in idle, so each reply is
 * its own notification. The 30s cooldown above only collapses replies that land
 * within 30s of each other, which real turns rarely do - a single trivial task
 * was producing 20+ alerts, and several tasks in flight multiplied it.
 *
 * This is also NOT redundant with the desktop's identical debounce. The desktop
 * suppresses remote push for any device with a live bridge session, so while
 * the five-minute background keepalive holds the channel open, THIS notifier is
 * the only thing firing. Fixing one side alone leaves the flood intact for
 * exactly the case that was reported.
 *
 * 45s is a starting value, tuned live: long enough to swallow a
 * question-and-answer exchange, short enough that a genuinely finished session
 * still alerts promptly.
 */
const IDLE_SETTLE_MS = 45_000;

function resolveTaskTitle(entry: SessionActivityEntry): string {
  const boardTask = useBoardStore.getState().boardsByProjectId[entry.projectId]?.tasksById[entry.taskId];
  return boardTask && boardTask.title.length > 0 ? boardTask.title : 'Agent session';
}

/**
 * The categories that fire IMMEDIATELY on a transition. 'turn-complete' is
 * deliberately absent: it is settle-debounced instead, see IDLE_SETTLE_MS and
 * the timer handling in startLocalNotifier.
 */
function categoriesForTransition(entry: SessionActivityEntry, previousEntry: SessionActivityEntry | undefined): PushCategory[] {
  const categories: PushCategory[] = [];
  const enteredPermission = entry.state === 'permission' && previousEntry?.state !== 'permission';
  const promptChanged =
    entry.state === 'permission' && entry.awaitedPromptId !== null && previousEntry?.awaitedPromptId !== entry.awaitedPromptId;
  if (enteredPermission || promptChanged) categories.push('input-required');
  // Only an UNINTENTIONAL end is worth waking someone for. A deliberate Stop,
  // suspend or shutdown is the user's own action taken at the desktop they are
  // sitting at, and this category is 'session-failed', not 'session-stopped'.
  // (The "Session stopped" copy in categoryCopy.ts stays as-is: it describes a
  // crash accurately, and docs/architecture.md enumerates it.)
  const endedUnintentionally = entry.feedStatus === 'ended' && entry.endedIntentionally === false;
  if (endedUnintentionally && previousEntry?.feedStatus !== 'ended') categories.push('session-failed');
  return categories;
}

/**
 * Starts watching the activity store; returns the stop function. The
 * connection manager starts this when it keeps the channel alive on
 * background (foreground-service mode) and stops it on foreground.
 */
export function startLocalNotifier(): () => void {
  const lastFiredAtByKey = new Map<string, number>();
  let appStateStatus: AppStateStatus = AppState.currentState;
  const appStateSubscription: NativeEventSubscription = AppState.addEventListener('change', (status) => {
    appStateStatus = status;
  });

  const fire = (category: PushCategory, entry: SessionActivityEntry): void => {
    // The same per-category toggle that filters remote push must also gate
    // the local alert - otherwise disabling a category in Settings still
    // fires it locally in foreground-service mode.
    if (useSettingsStore.getState().pushCategoriesEnabled[category] === false) return;
    const cooldownKey = `${entry.sessionId}:${category}`;
    const now = Date.now();
    const lastFiredAt = lastFiredAtByKey.get(cooldownKey);
    if (lastFiredAt !== undefined && now - lastFiredAt < LOCAL_NOTIFICATION_COOLDOWN_MS) return;
    lastFiredAtByKey.set(cooldownKey, now);
    void notifee
      .displayNotification({
        title: titleForCategory(category),
        body: resolveTaskTitle(entry),
        data: { taskId: entry.taskId, projectId: entry.projectId, sessionId: entry.sessionId },
        android: {
          ...ANDROID_NOTIFICATION_PRESENTATION,
          channelId: channelIdForCategory(category),
          pressAction: { id: 'default', launchActivity: 'default' },
        },
      })
      .catch(() => {
        // Display failures (channel blocked, permission revoked) are the
        // user's choice; nothing to do.
      });
  };

  const idleSettleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const cancelIdleSettle = (sessionId: string): void => {
    const pendingTimer = idleSettleTimers.get(sessionId);
    if (pendingTimer === undefined) return;
    clearTimeout(pendingTimer);
    idleSettleTimers.delete(sessionId);
  };

  const scheduleIdleSettle = (entry: SessionActivityEntry): void => {
    // First-write-wins, matching the desktop's permission debounce: a repeated
    // arm must not push the deadline out, or a session that keeps flickering
    // never alerts at all.
    if (idleSettleTimers.has(entry.sessionId)) return;
    idleSettleTimers.set(
      entry.sessionId,
      setTimeout(() => {
        idleSettleTimers.delete(entry.sessionId);
        // Re-read at FIRE time rather than trusting the entry captured 45s ago.
        // Cancellation below covers the transitions we observe; this covers a
        // session that changed without one reaching us.
        const currentEntry = useActivityStore.getState().bySessionId[entry.sessionId];
        if (!currentEntry || currentEntry.state !== 'idle') return;
        // The background check belongs HERE, not only at arm time: the app can
        // come forward inside the settle window, and nothing may post over the
        // in-app UI. (stopLocalNotifier also clears these on foreground, so
        // this is the belt to that braces.)
        if (appStateStatus !== 'background') return;
        fire('turn-complete', currentEntry);
      }, IDLE_SETTLE_MS),
    );
  };

  let previousBySessionId = useActivityStore.getState().bySessionId;
  const unsubscribeStore = useActivityStore.subscribe((state) => {
    const currentBySessionId = state.bySessionId;
    if (currentBySessionId === previousBySessionId) return;
    const previous = previousBySessionId;
    previousBySessionId = currentBySessionId;
    for (const entry of Object.values(currentBySessionId)) {
      const previousEntry = previous[entry.sessionId];
      // Arm and cancel on EVERY transition, before the background gate below.
      // A missed cancel is worse than a missed arm: it fires an alert for a
      // session that went straight back to work.
      if (entry.state === 'thinking' || entry.state === 'permission') {
        cancelIdleSettle(entry.sessionId);
      } else if (previousEntry?.state === 'thinking' && entry.state === 'idle') {
        scheduleIdleSettle(entry);
      }
      // Track transitions even while foregrounded, but only notify while
      // backgrounded: the in-app UI is the foreground surface.
      if (appStateStatus !== 'background') continue;
      for (const category of categoriesForTransition(entry, previousEntry)) fire(category, entry);
    }
  });

  return () => {
    appStateSubscription.remove();
    unsubscribeStore();
    for (const pendingTimer of idleSettleTimers.values()) clearTimeout(pendingTimer);
    idleSettleTimers.clear();
    lastFiredAtByKey.clear();
  };
}
