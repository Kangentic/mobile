import { AppState } from 'react-native';
import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import notifee from '@notifee/react-native';
import { ANDROID_NOTIFICATION_PRESENTATION, NEEDS_ATTENTION_CHANNEL_ID, channelIdForCategory } from './channels';
import { PUSH_PLACEHOLDER_BODY, PUSH_PLACEHOLDER_TITLE, decryptPushBlob, extractBlobFromTaskData } from './pushDecrypt';

// Re-exported from its new home in pushDecrypt.ts (the iOS tap router needs it
// too, and that path must not import notifee). Kept here so this module's own
// import path stays valid for callers and tests - not dead code.
export { extractBlobFromTaskData };

/**
 * The killed-app remote-push path: the desktop's Expo push arrives as an
 * FCM data message whose data.blob is the sealed envelope, expo-task-manager
 * boots this bundle headlessly, and this task decrypts and posts the rich
 * local notification via notifee. Any failure anywhere degrades to the
 * generic placeholder (e2e-notification-privacy.md) - the user still gets
 * nudged, and nothing sensitive is ever shown or logged.
 */

const BACKGROUND_PUSH_TASK_NAME = 'kangentic-background-push';

async function displayDecryptedOrPlaceholder(blob: string | null): Promise<void> {
  const decrypted = blob === null ? null : await decryptPushBlob(blob);
  if (decrypted) {
    await notifee.displayNotification({
      title: decrypted.title,
      body: decrypted.body,
      data: decrypted.data,
      android: {
        ...ANDROID_NOTIFICATION_PRESENTATION,
        channelId: channelIdForCategory(decrypted.category),
        pressAction: { id: 'default', launchActivity: 'default' },
      },
    });
    return;
  }
  await notifee.displayNotification({
    title: PUSH_PLACEHOLDER_TITLE,
    body: PUSH_PLACEHOLDER_BODY,
    android: {
      ...ANDROID_NOTIFICATION_PRESENTATION,
      channelId: NEEDS_ATTENTION_CHANNEL_ID,
      pressAction: { id: 'default', launchActivity: 'default' },
    },
  });
}

let taskRegistered = false;

export function registerBackgroundPushTask(): void {
  if (taskRegistered) return;
  taskRegistered = true;
  TaskManager.defineTask<Notifications.NotificationTaskPayload>(BACKGROUND_PUSH_TASK_NAME, async ({ data, error }) => {
    if (error || !data) return;
    // Notification-response payloads (action taps) are the tap router's
    // job; this task only handles incoming data messages.
    if ('actionIdentifier' in data) return;
    // Nothing fires over the top of the UI. The desktop already skips devices
    // with a live bridge session, but that is coarse: a relay hiccup, a
    // reconnect, or the five-minute BACKGROUND_KEEPALIVE_MAX_MS ceiling landing
    // while the user is actually looking at the app all get a push through.
    //
    // POLARITY IS LOAD-BEARING: suppress only when PROVABLY active, never
    // `!== 'background'` the way localNotifier does. This task runs headlessly
    // in a killed-app launch where there is no Activity at all and
    // AppState.currentState can read null or 'unknown'; treating those as
    // "not background" would silently kill the killed-app push path, which is
    // the entire reason this task exists.
    if (AppState.currentState === 'active') return;
    try {
      await displayDecryptedOrPlaceholder(extractBlobFromTaskData(data.data));
    } catch {
      // A notifee failure here has no further fallback; swallowing keeps
      // the headless task from crash-looping.
    }
  });
  void Notifications.registerTaskAsync(BACKGROUND_PUSH_TASK_NAME).catch(() => {
    // Without FCM credentials (no google-services.json) registration can
    // fail; remote push is simply unavailable, never a boot failure.
  });
}
