import { Platform } from 'react-native';
import { createNotificationChannels } from './channels';
import { registerBackgroundPushTask } from './backgroundPushTask';
import { registerForegroundServiceRunner } from './foregroundService';
import { registerNotificationTapHandlers } from './tapRouter';

export { requestNotificationPermission } from './channels';
export { decryptPushBlob, PUSH_PLACEHOLDER_BODY, PUSH_PLACEHOLDER_TITLE, type DecryptedPushNotification } from './pushDecrypt';
export { setActivePushIdentityPublicKey } from './pushIdentity';
export {
  getPushRegistrationStatus,
  registerPushWithDesktop,
  type PushRegistrarVerbs,
  type PushRegistrationStatus,
} from './pushRegistration';
export { startLocalNotifier } from './localNotifier';
export { startConnectedForegroundService, stopConnectedForegroundService } from './foregroundService';

let initialized = false;

/**
 * One-shot notification bootstrap, called from index.js at bundle-entry
 * scope (so the notifee background handler and the expo background task
 * are registered outside React, including in headless killed-app task
 * launches) and defensively from the root layout. Android-only for now:
 * the whole display stack (notifee channels, the FCM data-message task,
 * the foreground service) is Android; the iOS Notification Service
 * Extension is a later phase.
 */
export function initializeNotifications(): void {
  if (initialized) return;
  initialized = true;
  if (Platform.OS !== 'android') return;
  registerForegroundServiceRunner();
  registerNotificationTapHandlers();
  registerBackgroundPushTask();
  void createNotificationChannels().catch(() => {
    // Channel creation failing (no notification permission model applies
    // to channels, so this is exotic) must never block boot.
  });
}
