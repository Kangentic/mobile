import notifee, { AndroidForegroundServiceType } from '@notifee/react-native';
import { CONNECTION_CHANNEL_ID } from './channels';

/**
 * The Android "stay connected" foreground service: a LOW-importance
 * ongoing notification that lets the process keep the relay socket and
 * Noise session alive while backgrounded (backgroundNotificationsMode
 * 'foreground-service'). The service type is dataSync, matching the
 * manifest declaration in plugins/withAndroidPushService.ts (Android 14+
 * requires the two to agree or startForeground crashes).
 */

const CONNECTION_NOTIFICATION_ID = 'kangentic-connection';

let runnerRegistered = false;
let resolveServiceRunner: (() => void) | null = null;

/**
 * Must run at module/boot scope before the first
 * startConnectedForegroundService call: notifee requires the long-running
 * task to be registered before the service notification is displayed. The
 * returned promise resolving is what actually stops the service, so the
 * resolver is parked until stopConnectedForegroundService.
 */
export function registerForegroundServiceRunner(): void {
  if (runnerRegistered) return;
  runnerRegistered = true;
  notifee.registerForegroundService(
    () =>
      new Promise<void>((resolve) => {
        resolveServiceRunner = resolve;
      }),
  );
}

export async function startConnectedForegroundService(): Promise<void> {
  await notifee.displayNotification({
    id: CONNECTION_NOTIFICATION_ID,
    title: 'Connected to your desktop',
    body: 'Keeping the secure channel alive for instant alerts.',
    android: {
      channelId: CONNECTION_CHANNEL_ID,
      asForegroundService: true,
      ongoing: true,
      foregroundServiceTypes: [AndroidForegroundServiceType.FOREGROUND_SERVICE_TYPE_DATA_SYNC],
      pressAction: { id: 'default', launchActivity: 'default' },
    },
  });
}

export async function stopConnectedForegroundService(): Promise<void> {
  resolveServiceRunner?.();
  resolveServiceRunner = null;
  await notifee.stopForegroundService();
}
