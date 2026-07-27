/**
 * The Android "stay connected" foreground-service notification: the ongoing
 * notification presented while the process keeps the relay socket alive in
 * the background.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import notifee from '@notifee/react-native';
import { brandTokens } from '@/components/theme/tokens';
import {
  registerForegroundServiceRunner,
  startConnectedForegroundService,
  stopConnectedForegroundService,
} from '@/notifications/foregroundService';

// AndroidImportance and AuthorizationStatus are unused here, but foregroundService.ts
// reaches channels.ts (for ANDROID_NOTIFICATION_PRESENTATION), which imports both at
// module scope. Omitting them only works while nothing evaluates them at import time.
vi.mock('@notifee/react-native', () => ({
  default: {
    displayNotification: vi.fn(async () => 'notification-id'),
    registerForegroundService: vi.fn(),
    stopForegroundService: vi.fn(async () => undefined),
  },
  AndroidForegroundServiceType: { FOREGROUND_SERVICE_TYPE_DATA_SYNC: 1 },
  AndroidImportance: { DEFAULT: 3, HIGH: 4, LOW: 2 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
}));

const displayNotification = vi.mocked(notifee.displayNotification);
const stopForegroundService = vi.mocked(notifee.stopForegroundService);

describe('foregroundService', () => {
  beforeEach(() => {
    displayNotification.mockClear();
    stopForegroundService.mockClear();
  });

  it('displays the connection notification with the branded small icon and color', async () => {
    await startConnectedForegroundService();

    expect(displayNotification).toHaveBeenCalledTimes(1);
    const notification = displayNotification.mock.calls[0][0];
    expect(notification.title).toBe('Connected to your desktop');
    expect(notification.android?.channelId).toBe('connection');
    expect(notification.android?.asForegroundService).toBe(true);
    // Notifee defaults smallIcon to ic_launcher (a full-colour asset the OS
    // strips to a silhouette) unless set explicitly - see channels.ts.
    expect(notification.android?.smallIcon).toBe('notification_icon');
    expect(notification.android?.color).toBe(brandTokens.rust);
  });

  it('registers the long-running task once, however many times it is called', () => {
    registerForegroundServiceRunner();
    registerForegroundServiceRunner();

    expect(vi.mocked(notifee.registerForegroundService)).toHaveBeenCalledTimes(1);
  });

  it('stops the service on stopConnectedForegroundService', async () => {
    await stopConnectedForegroundService();

    expect(stopForegroundService).toHaveBeenCalledTimes(1);
  });
});
