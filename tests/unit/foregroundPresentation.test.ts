/**
 * iOS foreground presentation (protocol 0.26.0): a push that arrives while the
 * app is open stays hidden, as it always has, EXCEPT a Notify me push, which the
 * user asked for and the desktop sends to a connected phone on purpose. Every
 * failure keeps it hidden; nothing here ever presents a placeholder over the app.
 * Android has no handler at all, so only its receive task ever draws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Notifications from 'expo-notifications';

const platformMock = vi.hoisted(() => ({ OS: 'ios' as string }));
const expoNotificationsMock = vi.hoisted(() => ({ setNotificationHandler: vi.fn() }));
const decryptPushBlobMock = vi.hoisted(() => vi.fn());

vi.mock('react-native', () => ({ Platform: platformMock }));
vi.mock('expo-notifications', () => expoNotificationsMock);
vi.mock('@/notifications/pushDecrypt', () => ({
  decryptPushBlob: decryptPushBlobMock,
  extractBlobFromTaskData: (data: unknown) =>
    typeof data === 'object' && data !== null && typeof (data as { blob?: unknown }).blob === 'string' ? (data as { blob: string }).blob : null,
}));

type ForegroundPresentationModule = typeof import('@/notifications/foregroundPresentation');

async function loadModule(): Promise<ForegroundPresentationModule> {
  return import('@/notifications/foregroundPresentation');
}

function incoming(data: unknown): Notifications.Notification {
  return { date: 0, request: { identifier: 'notification-1', content: { data }, trigger: null } } as unknown as Notifications.Notification;
}

function decrypted(authored: boolean): { authored: boolean } {
  return { authored };
}

/** expo-notifications presents everything once a handler passes this (SingleNotificationHandlerTask.swift). */
const NATIVE_HANDLER_TIMEOUT_MS = 3000;

describe('foregroundBehaviorFor', () => {
  beforeEach(() => {
    vi.resetModules();
    decryptPushBlobMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('answers hidden before the native timeout when the decrypt never finishes', async () => {
    // From expo-notifications 58, a handler that misses the native deadline gets
    // the alert presented for it, so silence here would show the push.
    const { foregroundBehaviorFor } = await loadModule();
    vi.useFakeTimers();
    decryptPushBlobMock.mockReturnValue(new Promise(() => {}));

    let behavior: Notifications.NotificationBehavior | undefined;
    void foregroundBehaviorFor(incoming({ blob: 'sealed-blob' })).then((answer) => {
      behavior = answer;
    });
    await vi.advanceTimersByTimeAsync(NATIVE_HANDLER_TIMEOUT_MS - 1);

    expect(behavior).toEqual({ shouldShowBanner: false, shouldShowList: false, shouldPlaySound: false, shouldSetBadge: false });
  });

  it('leaves no deadline timer behind once the decrypt has answered', async () => {
    const { foregroundBehaviorFor } = await loadModule();
    vi.useFakeTimers();
    decryptPushBlobMock.mockResolvedValue(decrypted(true));

    await foregroundBehaviorFor(incoming({ blob: 'sealed-blob' }));

    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a Notify me push as a banner while the app is open', async () => {
    decryptPushBlobMock.mockResolvedValue(decrypted(true));
    const { foregroundBehaviorFor } = await loadModule();

    const behavior = await foregroundBehaviorFor(incoming({ blob: 'sealed-blob' }));

    expect(decryptPushBlobMock).toHaveBeenCalledWith('sealed-blob');
    expect(behavior).toMatchObject({ shouldShowBanner: true, shouldShowList: true });
  });

  it('keeps every other push hidden while the app is open, as before', async () => {
    decryptPushBlobMock.mockResolvedValue(decrypted(false));
    const { foregroundBehaviorFor } = await loadModule();

    expect(await foregroundBehaviorFor(incoming({ blob: 'sealed-blob' }))).toMatchObject({ shouldShowBanner: false, shouldShowList: false });
  });

  it.each<[string, () => void, unknown]>([
    ['no blob at all', () => decryptPushBlobMock.mockResolvedValue(decrypted(true)), {}],
    ['an envelope that does not open', () => decryptPushBlobMock.mockResolvedValue(null), { blob: 'sealed-blob' }],
    ['a decrypt that throws', () => decryptPushBlobMock.mockRejectedValue(new Error('keychain locked')), { blob: 'sealed-blob' }],
  ])('keeps the push hidden for %s', async (_label, arrange, data) => {
    arrange();
    const { foregroundBehaviorFor } = await loadModule();

    expect(await foregroundBehaviorFor(incoming(data))).toEqual({
      shouldShowBanner: false,
      shouldShowList: false,
      shouldPlaySound: false,
      shouldSetBadge: false,
    });
  });
});

describe('registerForegroundPresentation', () => {
  beforeEach(() => {
    vi.resetModules();
    expoNotificationsMock.setNotificationHandler.mockClear();
  });

  it('installs the handler once on iOS', async () => {
    platformMock.OS = 'ios';
    const { registerForegroundPresentation, foregroundBehaviorFor } = await loadModule();

    registerForegroundPresentation();
    registerForegroundPresentation();

    expect(expoNotificationsMock.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(expoNotificationsMock.setNotificationHandler).toHaveBeenCalledWith({ handleNotification: foregroundBehaviorFor });
  });

  it('removes the default handler on Android, which would draw every foreground push a second time', async () => {
    // expo-notifications 58 installs a show-everything handler when it is imported,
    // and Android's foreground path has no empty-content check, so leaving it in
    // place posts a blank notification beside the one the headless task draws
    // (ExpoHandlingDelegate.handleNotification). Null rather than a hidden handler:
    // it also removes the native listener that owns the 3 second timer.
    platformMock.OS = 'android';
    const { registerForegroundPresentation } = await loadModule();

    registerForegroundPresentation();
    registerForegroundPresentation();

    expect(expoNotificationsMock.setNotificationHandler).toHaveBeenCalledTimes(1);
    expect(expoNotificationsMock.setNotificationHandler).toHaveBeenCalledWith(null);
  });
});
