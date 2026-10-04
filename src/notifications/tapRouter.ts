import { Platform } from 'react-native';
import notifee, { EventType, type Notification } from '@notifee/react-native';
import * as Notifications from 'expo-notifications';
import { publishPendingNavigation } from '@/navigation/pendingNavigation';
import { decryptPushBlob, extractBlobFromTaskData } from './pushDecrypt';

/**
 * Notification tap routing: a tap opens the task screen on the lens the user
 * last chose for that task (terminal when there is none), for every category.
 * Registered once at boot, outside React, so a press is caught on every path:
 * the listeners for an app already running (foreground, or a process FCM
 * started headlessly), and a one-time read for the press that launched a
 * killed process, which on both platforms arrives only that way.
 *
 * The two platforms get there differently, because they carry the task
 * identity differently:
 *
 * - ANDROID reads it straight off the notification. Every notification this app
 *   DISPLAYS (local notifier, foreground service, decrypted push) is posted by
 *   notifee with { taskId, projectId, sessionId } already in its data, because
 *   the blob was decrypted before display.
 * - iOS carries only the sealed blob. The Notification Service Extension
 *   (targets/nse/) rewrites the title and body before the OS renders the alert,
 *   but deliberately never touches `userInfo`, so no task identity is stored in
 *   the OS-visible object. We decrypt it HERE, on tap, when the app is running
 *   and the push key is reachable.
 *
 * Decrypting on tap is what keeps taskId out of the OS-visible payload. Putting
 * a plaintext routing id in `data` would be the easy version and is exactly
 * what e2e-notification-privacy.md forbids: anything rendered before on-device
 * decryption is ciphertext plus a generic placeholder, never task identity.
 *
 * THIS MODULE NEVER NAVIGATES. It publishes a resolved target to the shared
 * pending-navigation slot, which `PendingNavigationRunner` consumes from inside
 * the mounted navigator. Do not "simplify" this back into a `router.push` call
 * here: that is what crashed iOS on a cold-start tap in 0.6.3 build 13, and the
 * mechanism (which is not obvious from our own source) is documented in
 * `src/navigation/pendingNavigation.ts`.
 */

function openTask(taskId: string, projectId: string, sessionId: string): void {
  publishPendingNavigation({ kind: 'open-task', taskId, projectId, sessionId });
}

/**
 * The Android twin of the iOS identifier latch below: one press routes once.
 * A press that launches the app can be reported twice - by the background
 * listener when FCM had already started the process headlessly, and by
 * getInitialNotification, which reports whatever press opened the activity -
 * and routing both would be a wasted second navigation. Keyed on notifee's
 * notification id, which is unique per displayed notification: no task
 * notification sets an id of its own (only the connection notification does,
 * and it carries no task), so a reposted alert is a new id and still routes.
 * Latched only once a press resolves to a task, so a press that routes
 * nothing (the connection notification, the decrypt placeholder) never
 * occupies the slot. Per process: the state dies with it, as the reports do.
 */
let lastRoutedPressNotificationId: string | null = null;

function openTaskFromNotification(notification: Notification | undefined): void {
  if (!notification) return;
  const data = notification.data;
  if (!data) return;
  const taskId = typeof data.taskId === 'string' ? data.taskId : null;
  if (!taskId) return;
  const notificationId = notification.id;
  if (typeof notificationId === 'string' && notificationId.length > 0) {
    if (notificationId === lastRoutedPressNotificationId) return;
    lastRoutedPressNotificationId = notificationId;
  }
  const projectId = typeof data.projectId === 'string' ? data.projectId : '';
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
  openTask(taskId, projectId, sessionId);
}

/**
 * ONE TAP MUST ROUTE ONCE. The warm listener and the cold-start read are two
 * independent deliveries of the same event, and expo-notifications can surface
 * a single tap through both: its own useLastNotificationResponse hook reads the
 * cached response AND subscribes to the listener, then de-duplicates the two by
 * comparing `notification.request.identifier` (`determineNextResponse`), and its
 * CHANGELOG records a fixed iOS bug where the response listener emitted
 * duplicate events. Routing both used to open the same task screen twice,
 * costing the user two back presses to leave it. The runner now NAVIGATES, so a
 * second route for the task already on top replaces it rather than stacking,
 * but the latch still keeps one tap to one routing (and one decrypt on iOS).
 *
 * Guarded on a string identifier rather than blind equality so that a payload
 * without one still routes: dropping a real tap is worse than a rare double.
 *
 * NOTE this is a LAST-ATTEMPTED latch, not last-routed: it is written before
 * the decrypt below, so re-running this function with the same response routes
 * nowhere. That is why the pending slot holds the RESOLVED target published by
 * openTask rather than the raw response - re-running the decrypt after mount
 * would be swallowed here.
 *
 * THIS ASSUMES THE DESKTOP NEVER COLLAPSES NOTIFICATIONS. iOS reuses the
 * request identifier when a push carries `apns-collapse-id`, so a sender that
 * collapsed per session would give two genuine taps the same identifier and
 * this latch would swallow the second - a tap that does nothing, which is a
 * worse failure than the double it prevents. Checked at the source rather than
 * assumed: the desktop's sendExpoPush (mobile-bridge/push/expo-push-client.ts)
 * emits only to/title/body/data.blob/priority/channelId/mutableContent, with no
 * collapse id of any kind, so every delivered push gets its own identifier. Add
 * a collapse id there and this guard has to become time-windowed.
 */
let lastRoutedNotificationIdentifier: string | null = null;

/**
 * The iOS half: pull the sealed blob out of the tapped notification, decrypt it,
 * and route from the plaintext. Every failure (no blob, no key, tampered blob,
 * stale sentAt) resolves to no navigation at all, which lands the user on Home -
 * the same safe fallback the Android path uses when a notification carries no
 * taskId. Nothing here is ever logged.
 */
export async function routeFromPushResponse(response: Notifications.NotificationResponse | null): Promise<void> {
  if (!response) return;
  const notificationIdentifier: unknown = response.notification.request.identifier;
  if (typeof notificationIdentifier === 'string' && notificationIdentifier.length > 0) {
    if (notificationIdentifier === lastRoutedNotificationIdentifier) return;
    lastRoutedNotificationIdentifier = notificationIdentifier;
  }
  const blob = extractBlobFromTaskData(response.notification.request.content.data);
  if (blob === null) return;
  const decrypted = await decryptPushBlob(blob);
  if (!decrypted) return;
  openTask(decrypted.data.taskId, decrypted.data.projectId, decrypted.data.sessionId);
}

let handlersRegistered = false;

export function registerNotificationTapHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;

  if (Platform.OS === 'android') {
    notifee.onForegroundEvent((event) => {
      if (event.type === EventType.PRESS) openTaskFromNotification(event.detail.notification);
    });
    notifee.onBackgroundEvent(async (event) => {
      if (event.type === EventType.PRESS) openTaskFromNotification(event.detail.notification);
    });
    // A press that LAUNCHED A KILLED PROCESS reaches neither listener: notifee
    // reports it only through getInitialNotification (the iOS deprecation of
    // that API does not apply here). Without this read, a tap on an alert for
    // an app the OS had killed opened the Agents feed and dropped the task,
    // measured on a release build 2026-10-03. It worked only when FCM had
    // happened to start the process headlessly first.
    void notifee
      .getInitialNotification()
      .then((initial) => {
        if (initial) openTaskFromNotification(initial.notification);
      })
      .catch(() => {
        // No launching press, or the module is unavailable; nothing to route.
      });
    return;
  }

  // A warm tap (app already running) arrives on the listener; a cold-start tap
  // happened before the listener existed, so it has to be read back once.
  //
  // `getLastNotificationResponseAsync` is DEPRECATED as of expo-notifications
  // 57.0.15 in favour of a synchronous `getLastNotificationResponse()`. Kept
  // deliberately: the async form's rejection path is already handled and
  // covered by a test, and switching to the sync form buys nothing today. The
  // package also added `clearLastNotificationResponse()`, which looks like a
  // replacement for the identifier latch above and is not - the latch also
  // guards the warm listener's own duplicate deliveries, which clearing the
  // cached response does not address. Revisit both at the next SDK bump.
  Notifications.addNotificationResponseReceivedListener((response) => {
    void routeFromPushResponse(response);
  });
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => routeFromPushResponse(response))
    .catch(() => {
      // No cold-start response, or the module is unavailable; nothing to route.
    });
}
