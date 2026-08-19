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
import { flushMicrotasks } from '../helpers/async';

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

/**
 * `identifier` is optional because most cases here do not care about it. The
 * de-duplication guard only engages on a non-empty string, so omitting it keeps
 * every single-tap case routing exactly as it reads.
 */
function pushResponse(data: unknown, identifier?: string): Parameters<TapRouterModule['routeFromPushResponse']>[0] {
  return { notification: { request: { identifier, content: { data } } } } as Parameters<
    TapRouterModule['routeFromPushResponse']
  >[0];
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
   * The cold-start read and the warm listener are two independent deliveries of
   * the SAME tap, and expo-notifications can surface one tap through both (its
   * own useLastNotificationResponse de-duplicates by request identifier for
   * exactly this reason). Routing both would push the task screen twice, so the
   * user needs two back presses to leave it.
   */
  it('routes one tap once when both deliveries carry the same notification identifier', async () => {
    const { routeFromPushResponse } = await loadModule();

    await routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-1'));
    await routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-1'));

    expect(routerMock.push).toHaveBeenCalledTimes(1);
    expect(decryptPushBlobMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The other half of the guard: de-duplication must not swallow a genuinely
   * different tap, which is the failure mode that would silently break routing.
   */
  it('still routes a second tap carrying a different notification identifier', async () => {
    const { routeFromPushResponse } = await loadModule();

    await routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-1'));
    await routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }, 'notification-2'));

    expect(routerMock.push).toHaveBeenCalledTimes(2);
  });

  /**
   * The de-dup guard is deliberately keyed on `typeof identifier === 'string'
   * && identifier.length > 0`, not on blind equality against the last-routed
   * value. A payload that carries no identifier at all must still route EVERY
   * time - dropping a real tap is worse than a rare double - so two separate
   * taps that both omit an identifier are two separate routes, not a dedup
   * pair. Blind equality would compare `undefined === undefined` on the
   * second call and silently swallow it.
   */
  it('routes every tap that omits a notification identifier, never deduping them against each other', async () => {
    const { routeFromPushResponse } = await loadModule();

    await routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));
    await routeFromPushResponse(pushResponse({ blob: 'sealed-blob' }));

    expect(routerMock.push).toHaveBeenCalledTimes(2);
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

  /**
   * The test above only proves getLastNotificationResponseAsync was CALLED,
   * not that its resolution actually reaches routeFromPushResponse. A broken
   * `.then((response) => routeFromPushResponse(response))` - a dropped
   * argument, a typo - would leave every cold-start tap silently unrouted
   * while that assertion still passed.
   */
  it('routes a cold-start tap through the getLastNotificationResponseAsync resolution', async () => {
    expoNotificationsMock.getLastNotificationResponseAsync.mockResolvedValue(
      pushResponse({ blob: 'sealed-blob' }, 'cold-start-notification'),
    );
    const { registerNotificationTapHandlers } = await loadModule();

    registerNotificationTapHandlers();
    await vi.waitFor(() => expect(routerMock.push).toHaveBeenCalledTimes(1));

    expect(decryptPushBlobMock).toHaveBeenCalledWith('sealed-blob');
    expect(routerMock.push).toHaveBeenCalledWith({
      pathname: '/task/[taskId]',
      params: { taskId: 'task-1', projectId: 'project-1', sessionId: 'sess-1', mode: 'chat' },
    });
  });

  /**
   * The other failure shape of the same wiring: no cold-start response at all
   * (a fresh install) resolves the module unavailable and getLastNotificationResponseAsync
   * rejects. The `.catch()` after the `.then()` has to swallow it - an
   * unswallowed rejection would surface as an unhandled rejection rather than
   * a quiet "nothing to route".
   */
  it('swallows a rejected cold-start read without throwing or routing', async () => {
    expoNotificationsMock.getLastNotificationResponseAsync.mockRejectedValue(new Error('module unavailable'));
    const { registerNotificationTapHandlers } = await loadModule();

    expect(() => registerNotificationTapHandlers()).not.toThrow();
    // Give the rejected promise's .catch() a turn to run.
    await flushMicrotasks();

    expect(routerMock.push).not.toHaveBeenCalled();
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
