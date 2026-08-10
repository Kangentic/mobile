import notifee, { AndroidImportance, AuthorizationStatus } from '@notifee/react-native';
import { brandTokens } from '@/components/theme/tokens';
import {
  NEEDS_ATTENTION_CHANNEL_ID,
  COMPLETIONS_CHANNEL_ID,
  FAILURES_CHANNEL_ID,
  STALLS_CHANNEL_ID,
  CONNECTION_CHANNEL_ID,
  channelIdForCategory,
  titleForCategory,
} from './categoryCopy';
import { setNotificationPermissionGranted } from './permissionCache';

/**
 * Android notification channels, mirroring the desktop's push channel
 * names (needs-attention / completions / failures / stalls) so local and
 * remote notifications for the same event class land under one
 * user-controllable channel. 'connection' is phone-only: the
 * LOW-importance ongoing foreground-service notification.
 *
 * The category -> channel-id / title mapping itself lives in
 * categoryCopy.ts (no notifee import there); re-exported here so existing
 * callers of this module keep working.
 */

export {
  NEEDS_ATTENTION_CHANNEL_ID,
  COMPLETIONS_CHANNEL_ID,
  FAILURES_CHANNEL_ID,
  STALLS_CHANNEL_ID,
  CONNECTION_CHANNEL_ID,
  channelIdForCategory,
  titleForCategory,
};

/**
 * Notifee defaults `smallIcon` to `ic_launcher` - a full-colour asset the OS
 * strips to its alpha channel, which is what turns the mark into a
 * silhouette - and it does NOT read the FCM/expo-notifications manifest
 * meta-data. Every displayNotification call must set these explicitly.
 * `notification_icon` is the drawable the expo-notifications plugin
 * generates from assets/brand/notification-icon.png (see app.config.ts).
 * The tint is the raw token hex, NOT the plugin's generated
 * `notification_icon_color` resource, which consequently has no reader while
 * Notifee owns every display call.
 *
 * Lives here rather than in categoryCopy.ts because it is Notifee-specific
 * presentation: categoryCopy.ts is deliberately notifee-free so the pure
 * decrypt path can import it.
 */
export const ANDROID_NOTIFICATION_PRESENTATION = {
  smallIcon: 'notification_icon',
  color: brandTokens.rust,
} as const;

let channelsCreated = false;

/** Idempotent; creating an existing channel is a no-op OS-side, but the guard keeps boot paths cheap. */
export async function createNotificationChannels(): Promise<void> {
  if (channelsCreated) return;
  channelsCreated = true;
  await notifee.createChannels([
    {
      id: NEEDS_ATTENTION_CHANNEL_ID,
      name: 'Needs your attention',
      description: 'An agent is waiting on your approval or answer.',
      importance: AndroidImportance.HIGH,
    },
    {
      id: COMPLETIONS_CHANNEL_ID,
      name: 'Completions',
      description: 'An agent finished its turn or a plan was approved.',
      importance: AndroidImportance.DEFAULT,
    },
    {
      id: FAILURES_CHANNEL_ID,
      name: 'Failures',
      description: 'An agent session stopped unexpectedly.',
      importance: AndroidImportance.HIGH,
    },
    {
      id: STALLS_CHANNEL_ID,
      name: 'Slow starts',
      description: 'A task is taking a while to start.',
      importance: AndroidImportance.DEFAULT,
    },
    {
      id: CONNECTION_CHANNEL_ID,
      name: 'Desktop connection',
      description: 'Shown while Kangentic keeps the secure channel to your desktop alive in the background.',
      importance: AndroidImportance.LOW,
    },
  ]);
}

function grantedFromStatus(authorizationStatus: AuthorizationStatus): boolean {
  return authorizationStatus === AuthorizationStatus.AUTHORIZED || authorizationStatus === AuthorizationStatus.PROVISIONAL;
}

/**
 * Refreshes the cached permission state from the OS. Cheap, and called on every
 * foreground: the user can revoke the permission in system settings at any
 * time, and returning to the app is the only moment we get to notice.
 */
export async function refreshNotificationPermission(): Promise<boolean> {
  const settings = await notifee.getNotificationSettings();
  const granted = grantedFromStatus(settings.authorizationStatus);
  setNotificationPermissionGranted(granted);
  return granted;
}

/** Android 13+ runtime notification permission (POST_NOTIFICATIONS), via notifee. */
export async function requestNotificationPermission(): Promise<boolean> {
  const settings = await notifee.requestPermission();
  const granted = grantedFromStatus(settings.authorizationStatus);
  setNotificationPermissionGranted(granted);
  return granted;
}

/**
 * Opens the OS notification settings for this app. The only recovery path once
 * the user has dismissed the runtime prompt twice: Android stops showing it
 * after that, so requestNotificationPermission() silently resolves denied
 * forever and the in-app prompt can never come back.
 */
export async function openSystemNotificationSettings(): Promise<void> {
  await notifee.openNotificationSettings();
}
