/**
 * Last known POST_NOTIFICATIONS state, held apart from channels.ts so it can be
 * read without importing notifee.
 *
 * Two constraints force this split. The reader that matters is
 * connectionManager's background-keepalive gate, which (a) runs on the AppState
 * 'background' transition and cannot await - putting a promise in front of the
 * foreground-service start is what produces
 * ForegroundServiceDidNotStartInTimeException, since Android gives
 * startForegroundService() only seconds to reach startForeground() - and (b)
 * must not import notifee statically, because notifee throws at import time
 * when its native module is absent and connectionManager is reachable from the
 * Jest component tier through actions.ts.
 *
 * So: channels.ts owns every notifee call and writes here; this module is plain
 * state with no imports at all. Same reasoning that keeps categoryCopy.ts
 * notifee-free for the pure decrypt path.
 */

/**
 * What the OS last told us, kept as three states rather than a boolean because
 * the two platforms differ in what they can express - see the comment on
 * notificationPermissionStatus below.
 */
export type NotificationPermissionStatus = 'granted' | 'denied' | 'not-determined';

let lastKnownPermissionStatus: NotificationPermissionStatus | null = null;

/**
 * Synchronous read of the cached permission state. `null` means nothing has
 * looked yet; initializeNotifications seeds this at boot, so the window is tiny.
 *
 * THE TWO PLATFORMS DIFFER, and the difference is why this is not a boolean.
 * iOS reports NOT_DETERMINED, so 'not-determined' there genuinely means "nobody
 * has ever been asked". Android has no such status - notifee reports only DENIED
 * or AUTHORIZED - so a permission that was never requested reads back as
 * 'denied', identical to one the user refused, and 'not-determined' never occurs.
 *
 * So an Android caller that needs "the user turned us down" must still pair this
 * with settingsStore's persisted hasRequestedNotificationPermission, which is the
 * only record that the app ever asked. An iOS caller can read never-asked
 * directly from here, and MUST prefer that: iOS Keychain items survive app
 * deletion, so the persisted flag can outlive the authorization it describes.
 */
export function notificationPermissionStatus(): NotificationPermissionStatus | null {
  return lastKnownPermissionStatus;
}

/**
 * Derived "can we post a notification right now" view, kept because the
 * background-keepalive gate in connectionManager is Android-only and reads it
 * that way. 'not-determined' maps to false: we cannot post until asked.
 *
 * `null` still means nothing has looked yet, and callers gating behaviour on
 * this must treat only an explicit `false` as denial - an unread cache has to
 * behave as it did before the cache existed.
 */
export function notificationPermissionGranted(): boolean | null {
  if (lastKnownPermissionStatus === null) return null;
  return lastKnownPermissionStatus === 'granted';
}

/** Written by channels.ts after any notifee permission read or request. */
export function setNotificationPermissionStatus(status: NotificationPermissionStatus): void {
  lastKnownPermissionStatus = status;
}
