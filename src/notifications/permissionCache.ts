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

let lastKnownPermissionGranted: boolean | null = null;

/**
 * Synchronous read of the cached permission state. `null` means nothing has
 * looked yet, so callers gating behaviour on this should treat only an explicit
 * `false` as denial - an unread cache must behave as it did before the cache
 * existed, never as a denial.
 *
 * `false` does NOT mean the user refused. Android has no NOT_DETERMINED
 * authorization status (notifee reports only DENIED or AUTHORIZED there), so a
 * permission that has simply never been requested reads back identically to one
 * that was. In practice the `null` window is also tiny, because
 * initializeNotifications seeds this at boot. A caller that needs "the user
 * turned us down" - rather than "we cannot post notifications right now" - must
 * pair this with settingsStore's persisted hasRequestedNotificationPermission,
 * which is the only record that the app ever asked. Both current gates (the
 * background keepalive and the Settings blocked-notice) do exactly that.
 */
export function notificationPermissionGranted(): boolean | null {
  return lastKnownPermissionGranted;
}

/** Written by channels.ts after any notifee permission read or request. */
export function setNotificationPermissionGranted(granted: boolean): void {
  lastKnownPermissionGranted = granted;
}
