/**
 * Notification tap routing, and specifically the iOS half.
 *
 * iOS has no Notification Service Extension yet, so nothing decrypts before the
 * OS renders the alert and the tapped notification carries only the sealed
 * blob. The router decrypts it on tap - which is what keeps taskId out of the
 * OS-visible payload, per e2e-notification-privacy.md. The failure path matters
 * as much as the happy one: a blob that will not decrypt must route NOWHERE
 * rather than guess, leaving the user on Home.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformMock = vi.hoisted(() => ({ OS: 'ios' as 'android' | 'ios' }));
const routerMock = vi.hoisted(() => ({ push: vi.fn() }));
const notifeeMock = vi.hoisted(() => ({ onForegroundEvent: vi.fn(), onBackgroundEvent: vi.fn() }));
const expoNotificationsMock = vi.hoisted(() => ({
  addNotificationResponseReceivedListener: vi.fn(),
  getLastNotificationResponseAsync: vi.fn(async () => null as unknown),
}));
const decryptPushBlobMock = vi.hoisted(() => vi.fn<(blob: string) => Promise<unknown>>());

// pushDecrypt reaches expo-secure-store for the push key, and importActual
// below pulls that in for real; unmocked it drags expo-modules-core into this
// node run and dies on a missing __DEV__.
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

vi.mock('react-native', () => ({ Platform: platformMock }));
vi.mock('expo-router', () => ({ router: routerMock }));
vi.mock('@notifee/react-native', () => ({
  default: notifeeMock,
  EventType: { PRESS: 1 },
}));
vi.mock('expo-notifications', () => expoNotificationsMock);
vi.mock('@/notifications/pushDecrypt', async () => {
  const actual = await vi.importActual<typeof import('@/notifications/pushDecrypt')>('@/notifications/pushDecrypt');
  return { ...actual, decryptPushBlob: decryptPushBlobMock };
});

type TapRouterModule = typeof import('@/notifications/tapRouter');

async function loadModule(): Promise<TapRouterModule> {
  return import('@/notifications/tapRouter');
}

function pushResponse(data: unknown): Parameters<TapRouterModule['routeFromPushResponse']>[0] {
  return { notification: { request: { content: { data } } } } as Parameters<TapRouterModule['routeFromPushResponse']>[0];
}

const DECRYPTED = {
  title: 'Agent needs your input',
  body: 'Ship the release',
  category: 'input-required',
  data: { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1' },
};

describe('tapRouter - iOS push responses', () => {
  beforeEach(() => {
    vi.resetModules();
    platformMock.OS = 'ios';
    routerMock.push.mockClear();
    notifeeMock.onForegroundEvent.mockClear();
    notifeeMock.onBackgroundEvent.mockClear();
    expoNotificationsMock.addNotificationResponseReceivedListener.mockClear();
    expoNotificationsMock.getLastNotificationResponseAsync.mockClear();
    expoNotificationsMock.getLastNotificationResponseAsync.mockResolvedValue(null);
    decryptPushBlobMock.mockReset();
    decryptPushBlobMock.mockResolvedValue(DECRYPTED);
  });

  it('decrypts the tapped blob and opens the task in chat mode', async () => {
    const { routeFromPushResponse } = await loadModule();

    await routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(decryptPushBlobMock).toHaveBeenCalledWith('sealed-blob');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/task/[taskId]',
      params: { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', mode: 'chat' },
    });
  });

  /** Expo wraps the data payload as a JSON string on some delivery paths. */
  it('reads the blob out of the JSON-wrapped payload shape too', async () => {
    const { routeFromPushResponse } = await loadModule();

    await routeFromPushResponse(pushResponse({ body: JSON.stringify({ blob: 'wrapped-blob' }) }));

    expect(decryptPushBlobMock).toHaveBeenCalledWith('wrapped-blob');
    expect(routerMock.push).toHaveBeenCalledTimes(1);
  });

  it('routes nowhere when the blob cannot be decrypted', async () => {
    decryptPushBlobMock.mockResolvedValue(null);
    const { routeFromPushResponse } = await loadModule();

    await routeFromPushResponse(pushResponse({ blob: 'tampered-blob' }));

    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('routes nowhere when the payload carries no blob at all', async () => {
    const { routeFromPushResponse } = await loadModule();

    await routeFromPushResponse(pushResponse({ someOtherKey: 'value' }));

    expect(decryptPushBlobMock).not.toHaveBeenCalled();
    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('routes nowhere for a null response (no cold-start tap)', async () => {
    const { routeFromPushResponse } = await loadModule();

    await routeFromPushResponse(null);

    expect(routerMock.push).not.toHaveBeenCalled();
  });

  /**
   * A cold-start tap happened before any listener existed, so the warm listener
   * alone would drop it. Both paths have to be wired, and neither may reach for
   * notifee, whose events only ever fire for notifications notifee itself
   * displayed - which on iOS is none of them.
   */
  it('registers both the warm listener and the cold-start read, and no notifee handlers', async () => {
    const { registerNotificationTapHandlers } = await loadModule();

    registerNotificationTapHandlers();

    expect(expoNotificationsMock.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
    expect(expoNotificationsMock.getLastNotificationResponseAsync).toHaveBeenCalledTimes(1);
    expect(notifeeMock.onForegroundEvent).not.toHaveBeenCalled();
    expect(notifeeMock.onBackgroundEvent).not.toHaveBeenCalled();
  });

  it('registers the notifee handlers on Android instead, and never the expo listener', async () => {
    platformMock.OS = 'android';
    const { registerNotificationTapHandlers } = await loadModule();

    registerNotificationTapHandlers();

    expect(notifeeMock.onForegroundEvent).toHaveBeenCalledTimes(1);
    expect(notifeeMock.onBackgroundEvent).toHaveBeenCalledTimes(1);
    expect(expoNotificationsMock.addNotificationResponseReceivedListener).not.toHaveBeenCalled();
  });

  it('registers once however many times it is called', async () => {
    const { registerNotificationTapHandlers } = await loadModule();

    registerNotificationTapHandlers();
    registerNotificationTapHandlers();

    expect(expoNotificationsMock.addNotificationResponseReceivedListener).toHaveBeenCalledTimes(1);
  });
});

describe('tapRouter - Android notifee presses', () => {
  beforeEach(() => {
    vi.resetModules();
    platformMock.OS = 'android';
    routerMock.push.mockClear();
    notifeeMock.onForegroundEvent.mockClear();
    notifeeMock.onBackgroundEvent.mockClear();
    decryptPushBlobMock.mockReset();
  });

  /**
   * Android notifications are posted by notifee AFTER decryption, so the ids
   * are already on the notification and nothing is decrypted a second time.
   */
  it('opens the task straight from the notification data, without decrypting', async () => {
    const { registerNotificationTapHandlers } = await loadModule();
    registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({
      type: 1,
      detail: { notification: { data: { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9' } } },
    });

    expect(decryptPushBlobMock).not.toHaveBeenCalled();
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/task/[taskId]',
      params: { taskId: 'task-9', projectId: 'project-9', sessionId: 'sess-9', mode: 'chat' },
    });
  });

  it('ignores a press carrying no taskId', async () => {
    const { registerNotificationTapHandlers } = await loadModule();
    registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({ type: 1, detail: { notification: { data: {} } } });

    expect(routerMock.push).not.toHaveBeenCalled();
  });

  it('ignores non-press events', async () => {
    const { registerNotificationTapHandlers } = await loadModule();
    registerNotificationTapHandlers();

    const onForegroundEvent = notifeeMock.onForegroundEvent.mock.calls[0][0] as (event: unknown) => void;
    onForegroundEvent({ type: 0, detail: { notification: { data: { taskId: 'task-9' } } } });

    expect(routerMock.push).not.toHaveBeenCalled();
  });
});
