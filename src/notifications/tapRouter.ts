import { Platform } from 'react-native';
import notifee, { EventType, type EventDetail } from '@notifee/react-native';
import * as Notifications from 'expo-notifications';
import { router } from 'expo-router';
import { decryptPushBlob, extractBlobFromTaskData } from './pushDecrypt';

/**
 * Notification tap routing: a tap opens the task screen in chat mode.
 * Registered once at boot, outside React - the background handler in
 * particular must exist before notifee replays a cold-start press event, which
 * is why this uses the expo-router `router` singleton rather than a hook.
 *
 * The two platforms get there differently, because they carry the task
 * identity differently:
 *
 * - ANDROID reads it straight off the notification. Every notification this app
 *   DISPLAYS (local notifier, foreground service, decrypted push) is posted by
 *   notifee with { taskId, projectId, sessionId } already in its data, because
 *   the blob was decrypted before display.
 * - iOS has no Notification Service Extension yet, so nothing decrypts before
 *   the OS renders the alert and the tapped notification carries only the
 *   sealed blob. We decrypt it HERE, on tap, when the app is running and the
 *   push key is reachable.
 *
 * Decrypting on tap is what keeps taskId out of the OS-visible payload. Putting
 * a plaintext routing id in `data` would be the easy version and is exactly
 * what e2e-notification-privacy.md forbids: anything rendered before on-device
 * decryption is ciphertext plus a generic placeholder, never task identity.
 */

function openTask(taskId: string, projectId: string, sessionId: string): void {
  try {
    router.push({
      pathname: '/task/[taskId]',
      params: { taskId, projectId, sessionId, mode: 'chat' },
    });
  } catch {
    // The root navigator may not be mounted yet on a cold-start press;
    // the app still opens to Home, which is a safe landing.
  }
}

function openTaskFromNotification(detail: EventDetail): void {
  const data = detail.notification?.data;
  if (!data) return;
  const taskId = typeof data.taskId === 'string' ? data.taskId : null;
  if (!taskId) return;
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
 * duplicate events. Routing both would `router.push` the same task screen twice,
 * costing the user two back presses to leave it.
 *
 * Guarded on a string identifier rather than blind equality so that a payload
 * without one still routes: dropping a real tap is worse than a rare double.
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
      if (event.type === EventType.PRESS) openTaskFromNotification(event.detail);
    });
    notifee.onBackgroundEvent(async (event) => {
      if (event.type === EventType.PRESS) openTaskFromNotification(event.detail);
    });
    return;
  }

  // A warm tap (app already running) arrives on the listener; a cold-start tap
  // happened before the listener existed, so it has to be read back once.
  Notifications.addNotificationResponseReceivedListener((response) => {
    void routeFromPushResponse(response);
  });
  void Notifications.getLastNotificationResponseAsync()
    .then((response) => routeFromPushResponse(response))
    .catch(() => {
      // No cold-start response, or the module is unavailable; nothing to route.
    });
}
