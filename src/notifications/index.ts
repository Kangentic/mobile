import { Platform } from 'react-native';
import { createNotificationChannels, refreshNotificationPermission } from './channels';
import { registerBackgroundPushTask } from './backgroundPushTask';
import { registerForegroundServiceRunner, stopOrphanedForegroundServiceAtBoot } from './foregroundService';
import { registerNotificationTapHandlers } from './tapRouter';
import { startNotificationReconciler } from './notificationReconciler';

export { openSystemNotificationSettings, refreshNotificationPermission, requestNotificationPermission } from './channels';
export {
  notificationPermissionGranted,
  notificationPermissionStatus,
  type NotificationPermissionStatus,
} from './permissionCache';
export { getBackgroundPushTaskStatus, type BackgroundPushTaskStatus } from './backgroundPushTask';
export { decryptPushBlob, PUSH_PLACEHOLDER_BODY, PUSH_PLACEHOLDER_TITLE, type DecryptedPushNotification } from './pushDecrypt';
export { setActivePushIdentityPublicKey } from './pushIdentity';
export {
  getPushRegistrationStatus,
  registerPushWithDesktop,
  unregisterPushWithDesktop,
  type PushRegistrarVerbs,
  type PushRegistrationStatus,
} from './pushRegistration';
export { clearPushRegistration } from './pushKeys';
export { startLocalNotifier } from './localNotifier';
export {
  reassertConnectedForegroundService,
  setConnectedForegroundServiceDesired,
} from './foregroundService';
// NOTE the component that performs tap navigation lives in
// src/navigation/PendingNavigationRunner.tsx and is deliberately NOT re-exported
// here: it pulls in React and expo-router, and this barrel is imported by
// node-env unit tests that cannot parse them. Re-exporting it once made
// tests/unit/notificationsIndex.test.ts die on `SyntaxError: Unexpected token
// 'typeof'`, which is what this note exists to prevent a second time.
//
// That test reaches the barrel through `await import('@/notifications')`, so a
// grep for `from '@/notifications'` will NOT find it and makes this comment look
// stale. It is not. (Same dynamic-import blind spot that
// tests/unit/imperativeRouterConfinement.test.ts exists to cover for the
// router ban.)

let initialized = false;

/**
 * One-shot notification bootstrap, called from index.js at bundle-entry
 * scope (so the notifee background handler and the expo background task
 * are registered outside React, including in headless killed-app task
 * launches) and defensively from the root layout.
 *
 * Split by what is ACTUALLY Android-only rather than gating the lot. This
 * whole function used to return early off Android, which is how iOS ended up
 * with no permission state and no tap routing on top of never being asked for
 * authorization at all. Tap routing is cross-platform (see tapRouter), and the
 * permission cache is what Settings reads to tell an iOS user their
 * notifications are blocked.
 *
 * Still Android-only, by nature: notifee channels (an Android concept) and the
 * foreground service. The receive task registers on both platforms, with a
 * narrower job on iOS (sealed clears only); rich iOS notification CONTENT is
 * the Notification Service Extension's (targets/nse/).
 */
export function initializeNotifications(): void {
  if (initialized) return;
  initialized = true;
  registerNotificationTapHandlers();
  // Cross-platform: clears alerts that stopped being true (an answered prompt,
  // a closed task, a screen the user is now looking at). Started here, at
  // bundle entry, so it runs for the life of the process, which is what lets
  // it cancel during the Android background keepalive too. Inert in a headless
  // launch until something it listens to changes.
  startNotificationReconciler();
  // Seeds the permission cache. Read synchronously by the background-keepalive
  // gate (Android) and by the Settings blocked-notice (both platforms).
  // Refreshed again on every foreground.
  void refreshNotificationPermission().catch(() => {
    // Leaves the cache at null, which the gate treats as "unknown", not
    // "denied" - a failed read must not disable the keepalive.
  });
  // Both platforms: on Android it renders every push and applies sealed
  // clears; on iOS it applies standalone sealed clears ONLY and displays
  // nothing (see registerBackgroundPushTask). Registered here, at bundle
  // entry, because an iOS background launch for a clear never mounts a screen
  // that could do it later.
  registerBackgroundPushTask();
  if (Platform.OS !== 'android') return;
  registerForegroundServiceRunner();
  // Process start, so nothing can have declared a keepalive yet: any dataSync
  // service alive right now was recreated by Android with nothing bounding it,
  // and no in-process flag could ever see it. That is narrower than this comment
  // used to claim: notifee returns START_NOT_STICKY, so it happens only when a
  // start intent was still pending at process death. The long MOBILE-3 orphans
  // lived in processes that never died, and the native stop alarm (see
  // foregroundService.ts) is what bounds those. The sweep also cancels any stop
  // alarm a previous process left armed.
  stopOrphanedForegroundServiceAtBoot();
  void createNotificationChannels().catch(() => {
    // Channel creation failing (no notification permission model applies
    // to channels, so this is exotic) must never block boot.
  });
}
