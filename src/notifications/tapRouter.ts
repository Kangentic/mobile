import notifee, { EventType, type EventDetail } from '@notifee/react-native';
import { router } from 'expo-router';

/**
 * Notification tap routing: every notification this app displays (local
 * notifier, foreground service, decrypted push) carries
 * { taskId, projectId, sessionId } in its notifee data, and a tap opens
 * the task screen in chat mode. Registered once at boot, outside React -
 * the background handler in particular must exist before notifee replays
 * a cold-start press event, which is why this uses the expo-router
 * `router` singleton rather than a hook.
 */

function openTaskFromNotification(detail: EventDetail): void {
  const data = detail.notification?.data;
  if (!data) return;
  const taskId = typeof data.taskId === 'string' ? data.taskId : null;
  if (!taskId) return;
  const projectId = typeof data.projectId === 'string' ? data.projectId : '';
  const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
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

let handlersRegistered = false;

export function registerNotificationTapHandlers(): void {
  if (handlersRegistered) return;
  handlersRegistered = true;
  notifee.onForegroundEvent((event) => {
    if (event.type === EventType.PRESS) openTaskFromNotification(event.detail);
  });
  notifee.onBackgroundEvent(async (event) => {
    if (event.type === EventType.PRESS) openTaskFromNotification(event.detail);
  });
}
