/**
 * connectionManager.ts's connection-trace call sites (`lifecycle-start`,
 * `open-start`, `anchor-loaded`). traceConnection() is a hard no-op whenever
 * the trace flag is unset (connectionTrace.ts's own OFF-path guard, pinned by
 * connectionTrace.test.ts), so none of the OTHER connectionManager*.test.ts
 * files - which never set the flag and never mock this module - actually
 * observe whether these calls fire, fire in order, or carry the right
 * fields. This file mocks '@/devsupport/connectionTrace' directly so the
 * calls are visible regardless of the flag, the same shape as this suite's
 * existing mocks for the push-registration and crash-reporting doors.
 *
 * Scope, deliberately narrow: the first describe covers only the no-anchor
 * path (secure-store reads resolve to null), which reaches `lifecycle-start`,
 * `open-start` and `anchor-loaded` without ever constructing a
 * ChannelController. Reaching `identity-ready` needs a real, fully-populated
 * trust anchor, which runs on into `new ChannelController(...)` and its
 * session/transport event wiring - a stub for that sprawls well past a "mock
 * one leaf module" test (session onEstablished/onRekey/onRemoteClosed,
 * transport.onStateChange, the feed). Left uncovered here rather than built
 * on a fragile partial stub; a dedicated ChannelController-level fixture
 * would be a separate, deliberate piece of work.
 *
 * The second describe is the one exception, and it exists for a single call
 * site that no unanchored path can reach: the `ceiling-timer` trace inside
 * startBackgroundKeepalive's setTimeout, which needs a REAL established
 * session to background. It borrows the minimum of
 * connectionManagerKeepalive.test.ts's harness for that (a loopback mock
 * desktop, a mocked bootstrap, push registration, notifee and the native stop
 * alarm wrapper) rather than growing a fixture of its own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState, type AppStateStatus } from 'react-native';
import { getActiveConnection, startConnectionLifecycle, stopConnectionLifecycle } from '@/connection/connectionManager';
import { setNotificationPermissionStatus } from '@/notifications/permissionCache';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import { waitUntil } from '../helpers/async';

const connectionTraceMocks = vi.hoisted(() => ({
  traceConnection: vi.fn<(event: string, fields?: Record<string, unknown>) => void>(),
  // Deliberately false by default, not true: if connectionManager.ts ever
  // hardcoded `cold: true` at the open-start call site instead of forwarding
  // this function's return value, a default of true would hide it.
  isColdLaunch: vi.fn<() => boolean>(() => false),
  foregroundKickEnabled: vi.fn<() => boolean>(() => true),
  keepaliveCeilingEnabled: vi.fn<() => boolean>(() => true),
  nativeStopAlarmEnabled: vi.fn<() => boolean>(() => true),
  markConnectionTraceForeground: vi.fn<() => void>(),
  // Read by the real SessionManager and CapabilityClient the second describe
  // runs, and by the foreground probe; these are the store-build values.
  connectionTraceEnabled: vi.fn<() => boolean>(() => false),
  retiredReceiveStreamsEnabled: vi.fn<() => boolean>(() => true),
  frameLivenessEnabled: vi.fn<() => boolean>(() => true),
}));
vi.mock('@/devsupport/connectionTrace', () => connectionTraceMocks);

const crashReportingMocks = vi.hoisted(() => ({
  reportHandledError: vi.fn<(site: string, error: unknown) => void>(),
}));
vi.mock('@/observability/crashReporting', () => ({
  reportHandledError: crashReportingMocks.reportHandledError,
}));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Platform: { OS: 'android' },
}));

const secureStoreMocks = vi.hoisted(() => ({
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(async () => null),
}));
vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStoreMocks.getItemAsync,
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

// The mocks below serve only the second describe, which backgrounds a real
// established session. The no-anchor describe never reaches any of them: it
// runs with __DEV__ false, so the mock-desktop branch is dead, and an
// unanchored open returns before bootstrap or push registration.
const mockRunBootstrap = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: mockRunBootstrap }));

// With the background-notifications mode off 'off', onEstablished fires its
// push-registration import. Unmocked, that pulls expo-notifications' native
// module into this node run.
vi.mock('@/notifications/pushRegistration', () => ({
  registerPushWithDesktop: vi.fn(async () => undefined),
  unregisterPushWithDesktop: vi.fn(async () => undefined),
  resetPushRegistrationProcessState: vi.fn(),
}));

// The notifee surface the keepalive path touches: foregroundService.ts, its
// channels.ts import and localNotifier.ts.
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

// The native stop alarm's JS wrapper, whose real module needs expo-modules-core.
// Same specifier the source uses: this file and src/notifications/ both sit two
// directories below the repo root.
vi.mock('../../modules/foreground-service-guard', () => ({
  armForegroundServiceStopAlarm: vi.fn(),
  disarmForegroundServiceStopAlarm: vi.fn(),
}));

// The dev rig's in-process fake desktop, reduced to a loopback pair and the
// stub peer that answers the KK handshake. Only reached when __DEV__ is true
// and EXPO_PUBLIC_KANGENTIC_MOCK is '1'.
vi.mock('@/connection/mockDesktop', async () => {
  const { createLoopbackPair } = await import('@/devsupport/loopbackTransport');
  const { StubSessionInitiator } = await import('@/devsupport/stubDesktopPeer');
  const { generateX25519KeyPair } = await import('@kangentic/protocol');
  return {
    createMockDesktop: () => {
      const [phoneTransport, desktopTransport] = createLoopbackPair();
      const identity = generateX25519KeyPair();
      const desktopStatic = generateX25519KeyPair();
      const stub = new StubSessionInitiator(desktopTransport, {
        desktopStatic,
        phoneStaticPublicKey: identity.publicKey,
      });
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

vi.stubGlobal('__DEV__', false);

describe('connectionManager trace call sites (no-anchor path)', () => {
  beforeEach(() => {
    stopConnectionLifecycle();
    useChannelStore.getState().setPairedState('unknown');
    secureStoreMocks.getItemAsync.mockReset();
    secureStoreMocks.getItemAsync.mockResolvedValue(null);
    connectionTraceMocks.traceConnection.mockClear();
    connectionTraceMocks.isColdLaunch.mockClear();
    connectionTraceMocks.isColdLaunch.mockReturnValue(false);
    crashReportingMocks.reportHandledError.mockClear();
  });

  /**
   * Mutation seen failing: deleting `traceConnection('lifecycle-start');`
   * from startConnectionLifecycle made the event list read
   * `['open-start', 'anchor-loaded']` instead of
   * `['lifecycle-start', 'open-start', 'anchor-loaded']` - "expected
   * [ 'open-start', 'anchor-loaded' ] to deeply equal
   * [ 'lifecycle-start', 'open-start', 'anchor-loaded' ]".
   */
  it('fires lifecycle-start, open-start, then anchor-loaded, in that order, on a no-anchor open', async () => {
    startConnectionLifecycle();

    await vi.waitFor(() => expect(useChannelStore.getState().pairedState).toBe('unpaired'));

    const events = connectionTraceMocks.traceConnection.mock.calls.map(([event]) => event);
    expect(events).toEqual(['lifecycle-start', 'open-start', 'anchor-loaded']);
  });

  /**
   * open-start's `cold` field must be READ from isColdLaunch(), not a
   * hardcoded literal - the default mock above returns false specifically so
   * a hardcoded `cold: true` cannot pass this test by accident.
   *
   * Mutation seen failing: changing
   * `traceConnection('open-start', { cold: isColdLaunch() });` to
   * `traceConnection('open-start', { cold: true });` made the asserted field
   * read `{ cold: true }` instead of `{ cold: false }` - "expected
   * { cold: true } to deeply equal { cold: false }".
   */
  it('open-start carries cold from isColdLaunch(), not a hardcoded value', async () => {
    connectionTraceMocks.isColdLaunch.mockReturnValue(false);

    startConnectionLifecycle();

    await vi.waitFor(() => expect(useChannelStore.getState().pairedState).toBe('unpaired'));

    const openStartCall = connectionTraceMocks.traceConnection.mock.calls.find(([event]) => event === 'open-start');
    expect(openStartCall?.[1]).toEqual({ cold: false });
  });

  /**
   * anchor-loaded must fire even when the anchor turns out to be null - i.e.
   * it has to run BEFORE the `if (!anchor) return;` early return, not after
   * it, since a trace call placed after that return would never execute on
   * the (very common - a fresh unpaired install) no-anchor path.
   *
   * Mutation seen failing: moving the anchor-loaded traceConnection call to
   * after `if (!anchor) { ...; return; }` made it never fire on this path -
   * "expected [ 'lifecycle-start', 'open-start' ] to deeply equal
   * [ 'lifecycle-start', 'open-start', 'anchor-loaded' ]".
   */
  it('anchor-loaded fires with paired=false before the no-anchor early return', async () => {
    startConnectionLifecycle();

    await vi.waitFor(() => expect(useChannelStore.getState().pairedState).toBe('unpaired'));

    const anchorLoadedCall = connectionTraceMocks.traceConnection.mock.calls.find(([event]) => event === 'anchor-loaded');
    expect(anchorLoadedCall).toBeDefined();
    expect(anchorLoadedCall?.[1]).toEqual({ ms: expect.any(Number), paired: false });
  });
});

/** Must match BACKGROUND_KEEPALIVE_MAX_MS. Held as a literal on purpose, like connectionManagerKeepalive.test.ts does. */
const EXPECTED_KEEPALIVE_CEILING_MS = 5 * 60_000;

/**
 * Establishes a real session against the loopback mock desktop and returns the
 * AppState handler the lifecycle just registered (the react-native mock never
 * clears, so `.at(-1)` is THIS test's). Runs on REAL timers, before any fake
 * clock, and pre-warms the two modules startBackgroundKeepalive reaches through
 * dynamic import: a fake clock cannot drive vite-node's module loading, so by
 * the time the test backgrounds under fake timers those imports must be pure
 * microtask work.
 */
async function establishAndWarm(): Promise<(status: AppStateStatus) => void> {
  startConnectionLifecycle();
  await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });

  await import('@/notifications/foregroundService');
  await import('@/notifications/localNotifier');

  const onAppStateChange = vi.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1];
  if (!onAppStateChange) throw new Error('expected an AppState change handler to be registered');
  return onAppStateChange;
}

function ceilingTimerTraceCalls() {
  return connectionTraceMocks.traceConnection.mock.calls.filter(([event]) => event === 'ceiling-timer');
}

describe('connectionManager trace call sites (ceiling timer, established session)', () => {
  beforeEach(() => {
    stopConnectionLifecycle();
    vi.stubGlobal('__DEV__', true);
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    useSettingsStore.setState({
      backgroundNotificationsMode: 'foreground-service',
      hasRequestedNotificationPermission: true,
      hydrated: true,
    });
    setNotificationPermissionStatus('granted');
    mockRunBootstrap.mockReset();
    mockRunBootstrap.mockResolvedValue(undefined);
    notifeeMocks.displayNotification.mockClear();
    notifeeMocks.stopForegroundService.mockClear();
    connectionTraceMocks.traceConnection.mockClear();
    connectionTraceMocks.keepaliveCeilingEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    // Also clears the ceiling timer - a survivor would fire into a later test.
    stopConnectionLifecycle();
    vi.useRealTimers();
    // Re-stubbed rather than unstubbed: the file's own default is `false`, and a
    // bare `__DEV__` throws a ReferenceError once the global is gone.
    vi.stubGlobal('__DEV__', false);
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useSettingsStore.setState({
      backgroundNotificationsMode: 'off',
      hasRequestedNotificationPermission: false,
      hydrated: false,
    });
    useChannelStore.getState().reset();
    connectionTraceMocks.keepaliveCeilingEnabled.mockReturnValue(true);
  });

  /**
   * The CONTROL for the test below, and a check of this harness in its own
   * right: with the ceiling switch at its default (on), backgrounding an
   * established session arms the timer, and it fires the `ceiling-timer` trace
   * at the ceiling. If the harness never reached startBackgroundKeepalive, or
   * the fake clock never reached the timer, the "no trace" assertion below
   * would pass for the wrong reason. The straddle pins that the trace arrives
   * AT the ceiling and not before.
   *
   * It also guards the test below against a rename: if the event string in
   * startBackgroundKeepalive changed, "no `ceiling-timer` trace" would hold
   * trivially there, and only this test would notice.
   *
   * Mutation seen failing: renaming the event in startBackgroundKeepalive from
   * `traceConnection('ceiling-timer', {` to `traceConnection('ceiling-timer-renamed', {`
   * left the trace list empty at the ceiling - "expected [] to have a length of
   * 1 but got +0". The test below stayed green under that rename, which is why
   * this one exists.
   */
  it('emits ceiling-timer at the keepalive ceiling when the ceiling switch is on', async () => {
    const onAppStateChange = await establishAndWarm();

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      // The keepalive branch, not closeConnection(): the connection is kept.
      expect(getActiveConnection()).not.toBeNull();
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(ceilingTimerTraceCalls()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(EXPECTED_KEEPALIVE_CEILING_MS - 1);
      expect(ceilingTimerTraceCalls()).toHaveLength(0);

      await vi.advanceTimersByTimeAsync(1);
      expect(ceilingTimerTraceCalls()).toHaveLength(1);
      expect(ceilingTimerTraceCalls()[0]?.[1]).toEqual({ elapsedMs: expect.any(Number) });
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * connectionManagerKeepalive.test.ts documents that removing the TIMER gate
   * (`if (keepaliveCeilingEnabled())` around the ceiling setTimeout in
   * startBackgroundKeepalive) keeps every test there green: the timer only
   * reaches the stop through enforceKeepaliveCeiling, which has its own gate. So
   * the difference between "no timer is armed" and "a timer is armed and then
   * refused" is observable only here. A probe build with the ceiling off is
   * meant to stand in for a JS thread that never runs the timer, and a timer
   * that is armed and fires, emitting `ceiling-timer` into the very log the
   * device run reads, would make that arm indistinguishable from the ceiling
   * being on until the stop is refused.
   *
   * The fake clock goes in BEFORE backgrounding, so an ungated timer would be a
   * fake one this test can fire. The checkpoint after backgrounding proves the
   * keepalive really started (a posted service and a kept connection), so a
   * background that took the closeConnection() branch cannot pass this for the
   * wrong reason.
   *
   * Mutation seen failing: replacing `if (keepaliveCeilingEnabled()) {` around
   * the ceiling setTimeout in startBackgroundKeepalive with a bare `{` block
   * (the same body, ungated) armed the timer with the switch off, and the
   * trace fired at the ceiling - "expected [ [ 'ceiling-timer', …(1) ] ] to
   * have a length of +0 but got 1". The sibling control above stayed green
   * under it, and connectionManagerKeepalive.test.ts documents that none of its
   * tests can see this mutation either.
   */
  it('arms no ceiling timer, so emits no ceiling-timer trace, when the ceiling switch is off', async () => {
    const onAppStateChange = await establishAndWarm();
    connectionTraceMocks.keepaliveCeilingEnabled.mockReturnValue(false);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveConnection()).not.toBeNull();
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2 * EXPECTED_KEEPALIVE_CEILING_MS);

      expect(ceilingTimerTraceCalls()).toHaveLength(0);
      // Still kept, as the keepalive test pins: nothing retired it either.
      expect(getActiveConnection()).not.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
