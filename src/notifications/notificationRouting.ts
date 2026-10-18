import { isPushCategory, isPushSessionKind, type PushCategory, type PushSessionKind } from '@kangentic/protocol';

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
