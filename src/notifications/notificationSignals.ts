import type { NotificationRouting } from './notificationRouting';

/**
 * The pure meeting point between the stale-notification reconciler and
 * everything that feeds it: the screens (what the user is looking at), the local
 * notifier and the headless push task (what was just posted), and the local
 * notifier again (what was just dismissed, so its cooldown can let the next
 * alert through).
 *
 * WHY A SEPARATE MODULE. The reconciler imports notifee and expo-notifications,
 * and notifee throws at import time without its native module. The screen
 * component suites and the local notifier's unit tests have no such mock, so a
 * static import of the reconciler from any of them would break the suite. This
 * file imports nothing native, and the reconciler subscribes to it instead.
 */

/** A surface the user can be looking at, whose alerts are then redundant. */
export type NotificationSurface =
  | { kind: 'task'; taskId: string }
  | { kind: 'command-terminal'; sessionId: string }
  | { kind: 'project-board'; projectId: string };

function surfaceKey(surface: NotificationSurface): string {
  switch (surface.kind) {
    case 'task':
      return `task:${surface.taskId}`;
    case 'command-terminal':
      return `command-terminal:${surface.sessionId}`;
    case 'project-board':
      return `project-board:${surface.projectId}`;
  }
}

/**
 * Ref-counted, because two mounts can hold one surface at once (a session screen
 * pushed twice for one task, or the outgoing and incoming screen across a
 * replace), and the first release must not close what the second still shows.
 */
const openSurfacesByKey = new Map<string, { surface: NotificationSurface; holders: number }>();
const surfaceOpenedListeners = new Set<(surface: NotificationSurface) => void>();

/**
 * Calls every listener, and a throwing one never reaches the caller: the callers
 * are a screen's focus effect and the two display paths, none of which may fail
 * because the reconciler did.
 */
function notifyEach<Value>(listeners: ReadonlySet<(value: Value) => void>, value: Value): void {
  for (const listener of listeners) {
    try {
      listener(value);
    } catch {
      // Swallowed: see above.
    }
  }
}

/**
 * Marks a surface as open until the returned release runs. The release is
 * idempotent and shaped for a `useFocusEffect` cleanup. Only an OPEN notifies
 * the reconciler: a close can never make an alert stale.
 */
export function openNotificationSurface(surface: NotificationSurface): () => void {
  const key = surfaceKey(surface);
  const held = openSurfacesByKey.get(key);
  if (held) {
    held.holders += 1;
  } else {
    openSurfacesByKey.set(key, { surface, holders: 1 });
  }
  notifyEach(surfaceOpenedListeners, surface);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const current = openSurfacesByKey.get(key);
    if (!current) return;
    current.holders -= 1;
    if (current.holders <= 0) openSurfacesByKey.delete(key);
  };
}

export function getOpenNotificationSurfaces(): NotificationSurface[] {
  return [...openSurfacesByKey.values()].map((held) => held.surface);
}

export function subscribeToOpenedNotificationSurfaces(listener: (surface: NotificationSurface) => void): () => void {
  surfaceOpenedListeners.add(listener);
  return () => {
    surfaceOpenedListeners.delete(listener);
  };
}

/** An alert this process just posted, so it is tracked (and judgeable) at once rather than at the next native read. */
export interface DisplayedNotificationNote {
  /** The notifee id it was posted under. */
  platformId: string;
  /** Null for the placeholder, which carries no routing. */
  routing: NotificationRouting | null;
  postedAt: number;
  /** The prompt the session was awaiting when a local input-required alert was posted, or null. */
  promptIdAtPost: string | null;
}

const displayedListeners = new Set<(note: DisplayedNotificationNote) => void>();

export function noteNotificationDisplayed(note: DisplayedNotificationNote): void {
  notifyEach(displayedListeners, note);
}

export function subscribeToDisplayedNotifications(listener: (note: DisplayedNotificationNote) => void): () => void {
  displayedListeners.add(listener);
  return () => {
    displayedListeners.delete(listener);
  };
}

const dismissalListeners = new Set<(routing: NotificationRouting) => void>();

/** Called by the reconciler for every routed alert it dismissed. */
export function publishNotificationDismissed(routing: NotificationRouting): void {
  notifyEach(dismissalListeners, routing);
}

export function subscribeToNotificationDismissals(listener: (routing: NotificationRouting) => void): () => void {
  dismissalListeners.add(listener);
  return () => {
    dismissalListeners.delete(listener);
  };
}
