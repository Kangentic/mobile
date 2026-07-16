import * as Notifications from 'expo-notifications';
import * as TaskManager from 'expo-task-manager';
import notifee from '@notifee/react-native';
import { NEEDS_ATTENTION_CHANNEL_ID, channelIdForCategory } from './channels';
import { PUSH_PLACEHOLDER_BODY, PUSH_PLACEHOLDER_TITLE, decryptPushBlob } from './pushDecrypt';

/**
 * The killed-app remote-push path: the desktop's Expo push arrives as an
 * FCM data message whose data.blob is the sealed envelope, expo-task-manager
 * boots this bundle headlessly, and this task decrypts and posts the rich
 * local notification via notifee. Any failure anywhere degrades to the
 * generic placeholder (e2e-notification-privacy.md) - the user still gets
 * nudged, and nothing sensitive is ever shown or logged.
 */

const BACKGROUND_PUSH_TASK_NAME = 'kangentic-background-push';

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The envelope blob can arrive directly as data.blob, or wrapped inside
 * the JSON string expo-notifications surfaces as data.dataString (or the
 * FCM-level `body` key on some delivery paths). Checked in that order.
 */
export function extractBlobFromTaskData(data: unknown): string | null {
  if (!isUnknownRecord(data)) return null;
  if (typeof data.blob === 'string') return data.blob;
  const nestedJson = typeof data.dataString === 'string' ? data.dataString : typeof data.body === 'string' ? data.body : null;
  if (nestedJson === null) return null;
  try {
    const parsed: unknown = JSON.parse(nestedJson);
    if (isUnknownRecord(parsed) && typeof parsed.blob === 'string') return parsed.blob;
  } catch {
    // Malformed JSON: fall through to null and the placeholder path.
  }
  return null;
}

async function displayDecryptedOrPlaceholder(blob: string | null): Promise<void> {
  const decrypted = blob === null ? null : await decryptPushBlob(blob);
  if (decrypted) {
    await notifee.displayNotification({
      title: decrypted.title,
      body: decrypted.body,
      data: decrypted.data,
      android: {
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
