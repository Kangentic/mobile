import { isPushCategory, isPushSessionKind, type PushCategory, type PushClearEntry, type PushSessionKind } from '@kangentic/protocol';

/**
 * What a displayed notification is ABOUT, read the same way by every reader:
 * the tap router (where a press goes), the stale-notification reconciler (when
 * an alert stops being true) and the deterministic id below (which alert a
 * repeat replaces).
 *
 * Pure on purpose: no notifee, no expo-notifications, no React. The reconciler
 * and the tap router are notifee-backed, but the local notifier's tests and the
 * screens' component tests must be able to reach this without a native module.
 */

/** The routing identity a notification carries, as both platforms read it. */
export interface NotificationRouting {
  /** Null for an alert that carries none: a local alert posted before the category rode along. */
  category: PushCategory | null;
  taskId: string;
  projectId: string;
  sessionId: string;
  sessionKind: PushSessionKind | null;
}

/**
 * The key a notification's own posting time rides under in notifee `data`
 * (epoch milliseconds as a string, since notifee `data` values are strings).
 * Two readers depend on it: the reconciler, which judges an alert only against
 * state observed AFTER it was posted, and the Android tap latch, which tells a
 * second press on the same alert from a press on the same id posted again.
 */
export const POSTED_AT_DATA_KEY = 'postedAt';

/**
 * The key a decrypted push's own envelope `sentAt` rides under in notifee
 * `data` (epoch milliseconds on the DESKTOP's clock, as a string). Not the same
 * value as `postedAt`, which is the phone's clock at display time: a sealed
 * clear bounds what it removes by the desktop's `sentAt` (clearEntryCovers), so
 * only the desktop's own clock can be compared against it. Absent on everything
 * that is not a decrypted push (a local alert, the placeholder, an alert posted
 * before this key existed), and an absent one is never cleared.
 */
export const SENT_AT_DATA_KEY = 'sentAt';

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the routing off a notification's `data`. Parsed with the protocol's own
 * guards, so a category or session kind this build does not know reads as
 * absent, the way the envelope parser drops it. Null when `data` is not a
 * record at all (the placeholder posts no routing).
 */
export function routingFromNotificationData(data: unknown): NotificationRouting | null {
  if (!isUnknownRecord(data)) return null;
  return {
    category: isPushCategory(data.category) ? data.category : null,
    taskId: typeof data.taskId === 'string' ? data.taskId : '',
    projectId: typeof data.projectId === 'string' ? data.projectId : '',
    sessionId: typeof data.sessionId === 'string' ? data.sessionId : '',
    sessionKind: isPushSessionKind(data.sessionKind) ? data.sessionKind : null,
  };
}

/** Whether a routing names anything at all: a task, a session or a project. */
export function routingNamesAnything(routing: NotificationRouting): boolean {
  return routing.taskId.length > 0 || routing.sessionId.length > 0 || routing.projectId.length > 0;
}

/**
 * The stable notifee id for an alert, so a repeat REPLACES the one already on
 * screen instead of stacking under it, and a cancel is a direct call.
 *
 * Keyed on the category plus the narrowest thing the alert names: its session,
 * else its task, else its project (workflow-complete names only its home
 * project, and spawn-stalled can predate its session). The category is part of
 * the key because one session can owe two different alerts at once ("needs your
 * input" is not replaced by "went idle").
 *
 * Android only, and on-device only: the id is never transmitted, and it holds
 * nothing the notification's own `data` does not already carry. iOS alerts are
 * drawn by the OS from the APNs request and keep their own identifiers; a
 * collapse id there would put a stable per-session identifier in the APNs
 * header, which is why that route was rejected (see tapRouter's iOS latch).
 *
 * Null when there is no category (a legacy alert) or nothing to key on.
 */
export function notificationIdForRouting(routing: NotificationRouting): string | null {
  if (routing.category === null) return null;
  if (routing.sessionId.length > 0) return `kangentic:${routing.category}:session:${routing.sessionId}`;
  if (routing.taskId.length > 0) return `kangentic:${routing.category}:task:${routing.taskId}`;
  if (routing.projectId.length > 0) return `kangentic:${routing.category}:project:${routing.projectId}`;
  return null;
}

/** One posting of an alert, as both Android display paths post it. */
export interface StampedPosting<Data extends object> {
  /** What the alert is about, read back off its data the way every reader reads it. */
  routing: NotificationRouting | null;
  /** Spread into `displayNotification`: the stable id, or nothing, so notifee picks a random one. */
  idField: { id?: string };
  /** The alert's data with this posting's own time stamped in. */
  data: Data & Record<typeof POSTED_AT_DATA_KEY, string>;
}

/**
 * Stamps one posting: its data with the posting time, the routing that data
 * names, and the stable id it posts under. The local notifier and the headless
 * push task both post through this, so a local alert and a remote push for the
 * same event cannot disagree on the id or on where the time rides.
 */
export function stampPosting<Data extends object>(data: Data, postedAt: number): StampedPosting<Data> {
  const routing = routingFromNotificationData(data);
  const stableId = routing === null ? null : notificationIdForRouting(routing);
  return {
    routing,
    idField: stableId === null ? {} : { id: stableId },
    data: { ...data, [POSTED_AT_DATA_KEY]: String(postedAt) },
  };
}

function parseEpochMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || value.length === 0) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric > 0 ? numeric : null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * When an alert was posted, in epoch ms, or null when that cannot be told.
 * Our own `data.postedAt` first; else the platform's displayed date (notifee's
 * `DisplayedNotification.date`, whose shape differs by platform and is parsed
 * defensively: a number, a numeric string, or an ISO string). Null means the
 * reconciler can order nothing against this alert, so it keeps it.
 */
export function readPostedAt(data: unknown, displayedDate: unknown): number | null {
  if (isUnknownRecord(data)) {
    const posted = parseEpochMs(data[POSTED_AT_DATA_KEY]);
    if (posted !== null) return posted;
  }
  return parseEpochMs(displayedDate);
}

/** The desktop `sentAt` a decrypted push stored in its `data`, or null when it carries none. */
export function readSentAt(data: unknown): number | null {
  return isUnknownRecord(data) ? parseEpochMs(data[SENT_AT_DATA_KEY]) : null;
}

/**
 * Whether a sealed clear entry (protocol 0.23.0) removes a displayed alert: its
 * category and all three ids match, AND the alert's own envelope `sentAt` is at
 * or before the entry's `notifiedAt`. The bound is what makes delivery order
 * irrelevant: a normal-priority clear that Doze held back can land after a
 * fresh push for the same session and category, and must not remove it.
 *
 * `sessionKind` is deliberately not compared. The ids alone are unique, the
 * stable Android id (notificationIdForRouting) leaves it out for the same
 * reason, and the iOS extension (targets/nse/NotificationPruning.swift) applies
 * this same rule without parsing it.
 *
 * An alert with no category or no `sentAt` is never covered: a local alert, the
 * placeholder, or an alert posted before `sentAt` was stored. Never dismiss on
 * unknown; the reconciler judges those on the next open instead.
 */
export function clearEntryCovers(entry: PushClearEntry, routing: NotificationRouting, sentAt: number | null): boolean {
  if (routing.category === null || sentAt === null) return false;
  return (
    routing.category === entry.category &&
    routing.projectId === entry.projectId &&
    routing.taskId === entry.taskId &&
    routing.sessionId === entry.sessionId &&
    sentAt <= entry.notifiedAt
  );
}
