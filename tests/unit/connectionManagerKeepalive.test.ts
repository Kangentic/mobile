/**
 * connectionManager's Android background keepalive, and the hard ceiling on it.
 *
 * Backgrounding with backgroundNotificationsMode 'foreground-service' keeps the
 * relay socket and Noise session alive under a notifee dataSync foreground
 * service. Android 15+ gives that service a cumulative 6h/24h budget and kills
 * the process when it overruns, and notifee 9.1.8 exposes no Service.onTimeout
 * hook to catch the signal - so a JS-side ceiling is the only bound that exists
 * in this stack. Unbounded, the service also kept the Java heap growing until it
 * hit its 256MB limit and the app froze in GC thrash on resume.
 *
 * The harness is lifted from connectionManagerBootstrapRetry.test.ts, which
 * already reaches a REAL established session (real SessionManager KK handshake
 * over the loopback transport) with Platform.OS 'android'. That file forces
 * backgroundNotificationsMode to 'off' in every beforeEach, which is why it only
 * ever exercises the closeConnection() branch - this file takes the other one.
 *
 * The ceiling is asserted as a LITERAL here, deliberately not imported from
 * connectionManager. Importing the constant would make the test track whatever
 * the constant says, so raising the ceiling back to hours would keep it green -
 * which is precisely the regression this file exists to catch.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState, type AppStateStatus } from 'react-native';
import type { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { useSettingsStore } from '@/state/settingsStore';
import { useChannelStore } from '@/state/channelStore';
// Safe to import statically: permissionCache has no imports at all, which is
// the whole point of it being separate from channels.ts.
import { notificationPermissionGranted, setNotificationPermissionGranted } from '@/notifications/permissionCache';
import { flushMicrotasks, waitUntil } from '../helpers/async';

/** Must match BACKGROUND_KEEPALIVE_MAX_MS. Held separately on purpose - see the file header. */
const EXPECTED_KEEPALIVE_CEILING_MS = 5 * 60_000;

/**
 * A promise this file resolves by hand, for pinning the notification-permission
 * in-flight guard: the guard only matters in the window where the first
 * requestPermission() call has not settled yet, and vitest's normal awaits give
 * no way to hold a call open on demand.
 */
function createDeferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolveDeferred!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolveDeferred = resolve;
  });
  return { promise, resolve: resolveDeferred };
}

const mockRunBootstrap = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: mockRunBootstrap }));

// With the mode off 'off', onEstablished fires its push-registration import.
// Unmocked, that pulls expo-notifications' native module into this node run.
const pushRegistrationMocks = vi.hoisted(() => ({
  registerPushWithDesktop: vi.fn(async () => undefined),
  unregisterPushWithDesktop: vi.fn(async () => undefined),
}));
vi.mock('@/notifications/pushRegistration', () => pushRegistrationMocks);

// The union of the notifee surface the keepalive path touches:
// foregroundService.ts (displayNotification / stopForegroundService), its
// channels.ts import (createChannels, AndroidImportance, AuthorizationStatus at
// module scope) and localNotifier.ts (displayNotification).
const notifeeMocks = vi.hoisted(() => ({
  displayNotification: vi.fn(async () => 'notification-id'),
  registerForegroundService: vi.fn(),
  stopForegroundService: vi.fn(async () => undefined),
  createChannels: vi.fn(async () => undefined),
  requestPermission: vi.fn(async () => ({ authorizationStatus: 1 })),
  getNotificationSettings: vi.fn(async () => ({ authorizationStatus: 1 })),
  openNotificationSettings: vi.fn(async () => undefined),
}));
vi.mock('@notifee/react-native', () => ({
  default: notifeeMocks,
  AndroidForegroundServiceType: { FOREGROUND_SERVICE_TYPE_DATA_SYNC: 1 },
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
}));

const mockDesktopSeam = vi.hoisted(() => ({ stub: null as unknown }));

vi.mock('@/connection/mockDesktop', async () => {
  const { createLoopbackPair } = await import('@/devsupport/loopbackTransport');
  const { StubSessionInitiator: RealStubSessionInitiator } = await import('@/devsupport/stubDesktopPeer');
  const { generateX25519KeyPair } = await import('@kangentic/protocol');
  return {
    createMockDesktop: () => {
      const [phoneTransport, desktopTransport] = createLoopbackPair();
      const identity = generateX25519KeyPair();
      const desktopStatic = generateX25519KeyPair();
      const stub = new RealStubSessionInitiator(desktopTransport, {
        desktopStatic,
        phoneStaticPublicKey: identity.publicKey,
      });
      mockDesktopSeam.stub = stub;
      return {
        identity,
        desktopStaticPublicKey: desktopStatic.publicKey,
        phoneTransport,
        async start(): Promise<void> {
          await desktopTransport.connect();
          stub.beginHandshake();
        },
        dispose(): void {
          stub.dispose();
          desktopTransport.close();
        },
      };
    },
  };
});

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Platform: { OS: 'android' },
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

/**
 * Establishes a real session and returns the AppState handler the lifecycle
 * just registered. The react-native mock never clears between tests, so
 * addEventListener's calls accumulate - .at(-1) is THIS test's handler.
 *
 * All of this runs on REAL timers, deliberately before any vi.useFakeTimers():
 * the handshake's await chain resolves the ordinary way rather than fighting a
 * fake clock it was never meant to interact with.
 *
 * It also PRE-WARMS the two modules startBackgroundKeepalive reaches through
 * dynamic import. This is load-bearing, and the reason is the same fact that
 * makes the ceiling testable at all: the ceiling timer is armed synchronously
 * inside startBackgroundKeepalive, so the background transition has to happen
 * with the fake clock already engaged or the timer is a real one the fake clock
 * will never fire. Backgrounding under fake timers in turn means the dynamic
 * imports have to be pure microtask work by then - a fake clock cannot drive
 * vite-node's module loading. Warming them here buys exactly that.
 */
async function establishAndWarm(): Promise<(status: AppStateStatus) => void> {
  const { startConnectionLifecycle } = await import('@/connection/connectionManager');
  startConnectionLifecycle();
  await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });

  await import('@/notifications/foregroundService');
  await import('@/notifications/localNotifier');

  const onAppStateChange = vi.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1];
  if (!onAppStateChange) throw new Error('expected an AppState change handler to be registered');
  return onAppStateChange;
}

describe('connectionManager background keepalive ceiling', () => {
  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    // hasRequestedNotificationPermission is set explicitly, not left to the
    // store default: establishAndWarm() fires maybeRequestNotificationPermission
    // as a side effect, which flips this flag partway through the first test and
    // leaves it set for the rest of the file. That made the denied-permission
    // test below depend on declaration order rather than on its own setup, since
    // "denied" means asked AND refused.
    useSettingsStore.setState({
      backgroundNotificationsMode: 'foreground-service',
      hasRequestedNotificationPermission: true,
      hydrated: true,
    });
    mockRunBootstrap.mockReset();
    mockRunBootstrap.mockResolvedValue(undefined);
    mockDesktopSeam.stub = null;
    // Module-level state: without this reset the denied-permission test below
    // would leak into whatever runs after it.
    setNotificationPermissionGranted(true);
    notifeeMocks.displayNotification.mockClear();
    notifeeMocks.stopForegroundService.mockClear();
    notifeeMocks.getNotificationSettings.mockReset();
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    // Also clears the ceiling timer - a survivor would fire into a later test.
    stopConnectionLifecycle();
    vi.useRealTimers();
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useSettingsStore.setState({
      backgroundNotificationsMode: 'off',
      hasRequestedNotificationPermission: false,
      hydrated: false,
    });
    useChannelStore.getState().reset();
  });

  it('tears the channel down once the keepalive hits its ceiling', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      // Non-vacuity checkpoint: prove the foreground service actually posted
      // before any meaningful timer advance. Without it, a harness that quietly
      // took the closeConnection() branch instead would make the straddle below
      // pass for entirely the wrong reason.
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(getActiveConnection()).not.toBeNull();

      // The off-by-one straddle pins the exact ceiling: a merely
      // shorter-than-forever bound would not survive both halves.
      await vi.advanceTimersByTimeAsync(EXPECTED_KEEPALIVE_CEILING_MS - 1);
      expect(getActiveConnection()).not.toBeNull();
      expect(notifeeMocks.stopForegroundService).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1);
      expect(getActiveConnection()).toBeNull();
      // stopBackgroundKeepalive reaches the service through a dynamic import,
      // so the stop lands a microtask after the synchronous teardown above.
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.stopForegroundService).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }

    // The acceptance-criterion path, and now the default one for every user:
    // coming back after the ceiling has fired must reconnect, not sit dead.
    // The handshake needs real timers, hence outside the block above.
    onAppStateChange('active');
    await waitUntil(() => useChannelStore.getState().established, { label: 're-established after the ceiling' });
    expect(getActiveConnection()).not.toBeNull();
  });

  /**
   * The ceiling timer is armed on background and must not survive a foreground.
   * Left live, it would tear down a connection the user is actively looking at
   * - a worse bug than the one the ceiling fixes.
   *
   * Deliberately a BEHAVIOURAL assertion, not a mechanism one. Two independent
   * things stop the stale fire (stopBackgroundKeepalive's clearTimeout, and the
   * captured-generation check inside the handler), and removing either alone
   * leaves this green - verified by mutating each. That is defence in depth
   * working as intended, not a hole in the test; removing BOTH does fail it,
   * which is what makes it non-vacuous. Do not read a pass here as proof that
   * the clearTimeout specifically is still present.
   */
  it('does not tear down a foregrounded connection with a stale ceiling timer', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(EXPECTED_KEEPALIVE_CEILING_MS / 2);
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveConnection()).not.toBeNull();

      // Well past where the armed timer would have fired.
      await vi.advanceTimersByTimeAsync(EXPECTED_KEEPALIVE_CEILING_MS);
      expect(getActiveConnection()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * With POST_NOTIFICATIONS denied the local notifier can display nothing, so a
   * foreground service would spend the dataSync budget and the Java heap to
   * deliver exactly nothing. This is the state the crash reports were all
   * captured in: POST_NOTIFICATIONS not_granted, FOREGROUND_SERVICE_DATA_SYNC
   * granted, and the service demonstrably running.
   */
  it('does not start the keepalive when the notification permission is denied', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    setNotificationPermissionGranted(false);
    onAppStateChange('background');

    expect(notifeeMocks.displayNotification).not.toHaveBeenCalled();
    expect(getActiveConnection()).toBeNull();
  });

  /**
   * The mirror of the test above, and the reason the gate consults the persisted
   * flag instead of the cache alone.
   *
   * Android has no NOT_DETERMINED authorization status - notifee reports plain
   * DENIED - and initializeNotifications seeds the cache at boot, so an install
   * that has never been ASKED caches exactly the same `false` as one that
   * refused. Gating on the cache alone therefore withdrew the keepalive from
   * every install that had not answered the prompt yet, which is all of them
   * until the prompt fires, and all of them forever if it never does.
   */
  it('still starts the keepalive when the permission was never asked for', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    setNotificationPermissionGranted(false);
    useSettingsStore.setState({ hasRequestedNotificationPermission: false });
    onAppStateChange('background');
    // The service posts through a (pre-warmed) dynamic import, so it lands a
    // microtask after the synchronous gate decision.
    await flushMicrotasks();

    expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
    expect(getActiveConnection()).not.toBeNull();
  });

  /**
   * startConnectionLifecycle runs before hydrate() resolves, so an early
   * background reads the in-memory 'foreground-service' default rather than the
   * persisted value - and would start a service a 'push-only' user turned off.
   */
  it('does not start the keepalive before settings have hydrated', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    useSettingsStore.setState({ hydrated: false });
    onAppStateChange('background');

    expect(notifeeMocks.displayNotification).not.toHaveBeenCalled();
    expect(getActiveConnection()).toBeNull();
  });

  /**
   * The AppState 'active' handler refreshes the cached permission from the
   * OS (Android only), which is how a permission revoked from system
   * settings while the app was backgrounded becomes visible to the
   * background-keepalive gate again. Without it, a user who revoked
   * POST_NOTIFICATIONS while away would background right back into a
   * foreground service that can display nothing.
   */
  it('refreshes the permission cache on foreground and withholds the keepalive once it reads back denied', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    // The cache holds true from beforeEach; only a real refresh on 'active'
    // can flip it, since backgrounding alone reads whatever is already cached.
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 });
    onAppStateChange('active');
    await waitUntil(() => notificationPermissionGranted() === false, {
      label: 'permission cache refreshed to denied',
    });

    onAppStateChange('background');

    expect(notifeeMocks.displayNotification).not.toHaveBeenCalled();
    expect(getActiveConnection()).toBeNull();
  });
});

/**
 * POST_NOTIFICATIONS had no production caller at all before this: the request
 * function was written, exported and unit-tested, but nothing in the app ever
 * invoked it, so every install ran with notifications undeliverable - local
 * alerts and remote push alike. The crash reports bear that out, showing
 * POST_NOTIFICATIONS not_granted on a device paired for over ten days.
 */
describe('connectionManager notification permission prompt', () => {
  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    useSettingsStore.setState({
      backgroundNotificationsMode: 'foreground-service',
      hasRequestedNotificationPermission: false,
      hydrated: true,
    });
    mockRunBootstrap.mockReset();
    mockRunBootstrap.mockResolvedValue(undefined);
    mockDesktopSeam.stub = null;
    setNotificationPermissionGranted(true);
    notifeeMocks.requestPermission.mockClear();
    notifeeMocks.requestPermission.mockResolvedValue({ authorizationStatus: 1 });
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    stopConnectionLifecycle();
    vi.useRealTimers();
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useSettingsStore.setState({ backgroundNotificationsMode: 'off', hasRequestedNotificationPermission: false, hydrated: false });
    useChannelStore.getState().reset();
  });

  it('asks once on the first establishment and not again on a re-establish', async () => {
    const { startConnectionLifecycle, getActiveConnection } = await import('@/connection/connectionManager');

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => useSettingsStore.getState().hasRequestedNotificationPermission, { label: 'permission requested' });
    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);

    // onEstablished re-fires on every reconnect. Without the persisted flag
    // this would re-prompt roughly every time the channel came back.
    const activeConnection = getActiveConnection();
    if (!activeConnection) throw new Error('expected an active connection after establishment');
    activeConnection.controller.session.reset();
    (mockDesktopSeam.stub as StubSessionInitiator).beginHandshake();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 2, { label: 're-established' });

    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);
  });

  /**
   * The race this guard exists for: the open system dialog pauses the
   * activity, Android reports a background transition, the channel closes
   * and reconnects on answering the dialog, and that second onEstablished
   * can land before markNotificationPermissionRequested() has finished
   * persisting the first answer. Only notificationPermissionPromptInFlight
   * stops a second requestPermission() call in that window - the persisted
   * flag alone cannot, because it has not been written yet.
   */
  it('does not call requestPermission a second time while the first call is still pending', async () => {
    const { startConnectionLifecycle, getActiveConnection } = await import('@/connection/connectionManager');

    const firstPermissionRequest = createDeferred<{ authorizationStatus: number }>();
    notifeeMocks.requestPermission.mockImplementation(() => firstPermissionRequest.promise);

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => notifeeMocks.requestPermission.mock.calls.length === 1, {
      label: 'first permission request issued',
    });
    // Still pending: the persisted flag cannot be what suppresses a second
    // call below, because it has not been written yet.
    expect(useSettingsStore.getState().hasRequestedNotificationPermission).toBe(false);

    const activeConnection = getActiveConnection();
    if (!activeConnection) throw new Error('expected an active connection after establishment');
    activeConnection.controller.session.reset();
    (mockDesktopSeam.stub as StubSessionInitiator).beginHandshake();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 2, { label: 're-established' });

    // The second onEstablished fired while the first request was still
    // pending; only the in-flight guard can have stopped a second call here.
    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);

    firstPermissionRequest.resolve({ authorizationStatus: 1 });
    await waitUntil(() => useSettingsStore.getState().hasRequestedNotificationPermission, {
      label: 'permission requested',
    });
    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);
  });

  /**
   * "A prompt that never appeared is worse than one offered again": a
   * rejected requestPermission() must leave hasRequestedNotificationPermission
   * unset, so the next establishment retries instead of the app silently
   * never asking again.
   */
  it('leaves the flag unset when the request rejects, and asks again on the next establishment', async () => {
    const { startConnectionLifecycle, getActiveConnection } = await import('@/connection/connectionManager');

    notifeeMocks.requestPermission.mockRejectedValueOnce(new Error('permission request failed'));

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => notifeeMocks.requestPermission.mock.calls.length === 1, {
      label: 'permission request issued',
    });
    // Let the rejection's .catch()/.finally() run before reading the flag.
    await flushMicrotasks();
    expect(useSettingsStore.getState().hasRequestedNotificationPermission).toBe(false);

    notifeeMocks.requestPermission.mockResolvedValue({ authorizationStatus: 1 });
    const activeConnection = getActiveConnection();
    if (!activeConnection) throw new Error('expected an active connection after establishment');
    activeConnection.controller.session.reset();
    (mockDesktopSeam.stub as StubSessionInitiator).beginHandshake();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 2, { label: 're-established' });
    await waitUntil(() => useSettingsStore.getState().hasRequestedNotificationPermission, {
      label: 'permission requested',
    });

    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(2);
  });

  it('does not ask when notifications are switched off entirely', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    useSettingsStore.setState({ backgroundNotificationsMode: 'off' });

    startConnectionLifecycle();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 1, { label: 'bootstrap ran' });
    await flushMicrotasks();

    expect(notifeeMocks.requestPermission).not.toHaveBeenCalled();
    expect(useSettingsStore.getState().hasRequestedNotificationPermission).toBe(false);
  });

  /**
   * startConnectionLifecycle runs before hydrate() resolves, so an
   * establishment can beat it. Prompting off the pre-hydration default would
   * ask again someone who answered weeks ago.
   */
  it('does not ask before settings have hydrated', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    useSettingsStore.setState({ hydrated: false });

    startConnectionLifecycle();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 1, { label: 'bootstrap ran' });
    await flushMicrotasks();

    expect(notifeeMocks.requestPermission).not.toHaveBeenCalled();
  });
});
