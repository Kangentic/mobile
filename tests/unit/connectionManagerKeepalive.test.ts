/**
 * connectionManager's Android background keepalive, and the hard ceiling on it.
 *
 * Backgrounding with backgroundNotificationsMode 'foreground-service' keeps the
 * relay socket and Noise session alive under a notifee dataSync foreground
 * service. Android 15+ gives that service a 6h/24h budget and kills the process
 * when it overruns, and notifee 9.1.8 exposes no Service.onTimeout hook to catch
 * the signal. Unbounded, the service also kept the Java heap growing until it
 * hit its 256MB limit and the app froze in GC thrash on resume.
 *
 * This header used to say the app-side ceiling was "the only bound that exists
 * in this stack". Since MOBILE-3 recurred on 0.8.0+13 it is not: every service
 * start also arms a native AlarmManager stop (modules/foreground-service-guard),
 * which holds when the JS thread does not run. The JS ceiling is still the
 * primary bound and the only one that closes the channel. This file pins that
 * the keepalive arms the alarm, and that the ordinary stop cancels it.
 *
 * That counter resets whenever the app is foregrounded, and every keepalive
 * window is preceded by a foreground visit, so overrunning needs ONE unbroken
 * ~6h background stretch in which the service never stopped - not many short
 * ones adding up. Which is why the ceiling is enforced twice here: the timer,
 * and a wall-clock check driven by a desktop rekey. Note what the fake-timer
 * tests below CANNOT cover: whether the real Android timer fires at all. RN
 * services setTimeout from a Choreographer frame callback, and a fake clock
 * always fires. Only the rekey test keeps the timer inert on purpose.
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
import type { CapabilityRequestMessage, CapabilityResponseMessage } from '@kangentic/protocol';
import type { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import type { LoopbackTransport } from '@/devsupport/loopbackTransport';
import { useSettingsStore } from '@/state/settingsStore';
import { useChannelStore } from '@/state/channelStore';
// Safe to import statically: permissionCache has no imports at all, which is
// the whole point of it being separate from channels.ts.
import { notificationPermissionGranted, setNotificationPermissionStatus } from '@/notifications/permissionCache';
import { flushMicrotasks, waitUntil } from '../helpers/async';

/** Must match BACKGROUND_KEEPALIVE_MAX_MS. Held separately on purpose - see the file header. */
const EXPECTED_KEEPALIVE_CEILING_MS = 5 * 60_000;
/** Must match FOREGROUND_PROBE_TIMEOUT_MS, held separately for the same reason. */
const EXPECTED_PROBE_TIMEOUT_MS = 3_000;

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
  resetPushRegistrationProcessState: vi.fn(),
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

/**
 * The native stop alarm under the keepalive, which is the bound that holds when
 * JS does not run. foregroundService.ts reaches it through the JS wrapper,
 * whose real module needs expo-modules-core, so it is mocked here. That is the
 * same specifier the source uses, since this file and
 * src/notifications/foregroundService.ts both sit two directories below the
 * repo root.
 */
const stopAlarmMocks = vi.hoisted(() => ({
  armForegroundServiceStopAlarm: vi.fn<(delayMs: number) => void>(),
  disarmForegroundServiceStopAlarm: vi.fn<() => void>(),
}));
vi.mock('../../modules/foreground-service-guard', () => stopAlarmMocks);

/**
 * The trace-build probe switch that turns the JS ceiling off, stubbed so one
 * test can flip it without a trace build. Everything else in the module stays
 * real, and the default stays true, which is what every store build reads.
 */
const keepaliveProbeMocks = vi.hoisted(() => ({
  keepaliveCeilingEnabled: vi.fn<() => boolean>(() => true),
  // Task #109's frame-liveness switch, flipped by the one test that measures
  // the pre-fix arm.
  frameLivenessEnabled: vi.fn<() => boolean>(() => true),
}));
vi.mock('@/devsupport/connectionTrace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/devsupport/connectionTrace')>()),
  keepaliveCeilingEnabled: keepaliveProbeMocks.keepaliveCeilingEnabled,
  frameLivenessEnabled: keepaliveProbeMocks.frameLivenessEnabled,
}));

const mockDesktopSeam = vi.hoisted(() => ({ stub: null as unknown, phoneTransport: null as unknown }));

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
      mockDesktopSeam.phoneTransport = phoneTransport;
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

/**
 * Mutable so the iOS cases can flip it. connectionManager reads Platform.OS
 * inside the functions under test, never at module scope, so reassigning the
 * field between tests is enough - no module re-import needed.
 */
const platformMock = vi.hoisted(() => ({ OS: 'android' as 'android' | 'ios' }));

// The handled-error door: its real module imports @sentry/react-native, whose
// wrapper reads NativeModules.RNSentry at import time - absent from the
// minimal react-native stub below - so it is stubbed inert here.
vi.mock('@/observability/crashReporting', () => ({ reportHandledError: vi.fn() }));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
  Platform: platformMock,
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
    mockDesktopSeam.phoneTransport = null;
    // Module-level state: without this reset the denied-permission test below
    // would leak into whatever runs after it.
    setNotificationPermissionStatus('granted');
    notifeeMocks.displayNotification.mockClear();
    notifeeMocks.stopForegroundService.mockClear();
    // Restores the resolving implementation, not just the call history: the
    // reassert-retry test below installs a rejecting one, and without this a
    // failure partway through that test would leak a rejecting stop into
    // every later test in this file (and the two describes after it).
    notifeeMocks.stopForegroundService.mockResolvedValue(undefined);
    notifeeMocks.getNotificationSettings.mockReset();
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
    stopAlarmMocks.armForegroundServiceStopAlarm.mockClear();
    stopAlarmMocks.disarmForegroundServiceStopAlarm.mockClear();
    keepaliveProbeMocks.keepaliveCeilingEnabled.mockReturnValue(true);
    keepaliveProbeMocks.frameLivenessEnabled.mockReturnValue(true);
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

  /**
   * MOBILE-3 on 0.8.0+13, at the keepalive level: starting the keepalive arms
   * the native stop alarm before the service can exist, and the ordinary
   * foreground stop cancels it. Every JS bound in this file needs the JS thread
   * to run, and the field failure is that thread not running the stop. So the
   * alarm is the only bound that holds there, and its arming has to ride the
   * one path every keepalive takes.
   *
   * Mutations seen failing: deleting the arm from
   * startConnectedForegroundService fails the first expectation, "expected
   * "vi.fn()" to be called with arguments: [ 600000 ]" (written when the
   * deadline was ten minutes; it is seven now). Deleting the disarm
   * from stopConnectedForegroundService fails with "waitUntil timed out after
   * 2000ms: stop alarm cancelled".
   */
  it('arms the native stop alarm when the keepalive starts, and cancels it on the foreground stop', async () => {
    const onAppStateChange = await establishAndWarm();

    onAppStateChange('background');
    await waitUntil(() => notifeeMocks.displayNotification.mock.calls.length === 1, { label: 'service posted' });

    expect(stopAlarmMocks.armForegroundServiceStopAlarm).toHaveBeenCalledWith(7 * 60_000);
    expect(stopAlarmMocks.armForegroundServiceStopAlarm.mock.invocationCallOrder[0]).toBeLessThan(
      notifeeMocks.displayNotification.mock.invocationCallOrder[0],
    );
    expect(stopAlarmMocks.disarmForegroundServiceStopAlarm).not.toHaveBeenCalled();

    onAppStateChange('active');
    await waitUntil(() => stopAlarmMocks.disarmForegroundServiceStopAlarm.mock.calls.length === 1, {
      label: 'stop alarm cancelled',
    });
    expect(notifeeMocks.stopForegroundService).toHaveBeenCalled();
  });

  /**
   * The trace-build probe that stands in for a JS thread that never runs its
   * stop: with the ceiling switch off, neither the timer nor the wall-clock
   * check retires the keepalive, so only the native alarm (still armed) can.
   * That is the condition the device run in the developer guide sets up, so it
   * has to actually hold.
   *
   * Mutation seen failing: removing the keepaliveCeilingEnabled() gate from
   * enforceKeepaliveCeiling fails this with "expected null not to be null". The
   * transport blip then retires the keepalive. Removing only the timer's gate
   * keeps it green (verified), because the timer reaches the stop only through
   * that same gated check. The timer gate exists so a probe build arms no timer
   * at all, not to make this test pass.
   */
  it('leaves the keepalive to the native alarm when the trace-build ceiling switch is off', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    keepaliveProbeMocks.keepaliveCeilingEnabled.mockReturnValue(false);
    const armedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(armedAtMs);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(stopAlarmMocks.armForegroundServiceStopAlarm).toHaveBeenCalledTimes(1);

      // Both JS halves get their chance: the clock well past the ceiling, the
      // timer advanced past it, and a wake source for the wall-clock check.
      nowSpy.mockReturnValue(armedAtMs + 2 * EXPECTED_KEEPALIVE_CEILING_MS);
      await vi.advanceTimersByTimeAsync(2 * EXPECTED_KEEPALIVE_CEILING_MS);
      phoneTransport.simulateReconnect();
      for (let round = 0; round < 20; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(getActiveConnection()).not.toBeNull();
      expect(notifeeMocks.stopForegroundService).not.toHaveBeenCalled();
      expect(stopAlarmMocks.disarmForegroundServiceStopAlarm).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
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
   * The wall-clock half of the ceiling, and the reason MOBILE-3 outlived the
   * timer half on real devices.
   *
   * RN services every setTimeout from a Choreographer frame callback, so the
   * ceiling timer above is only ever as reliable as frame delivery to a
   * backgrounded phone. Both crash events show what that costs: the app went to
   * background, never came back, and the process was still alive 7h10m and
   * 14h14m later with the dataSync service still running.
   *
   * So this test fakes setTimeout and then NEVER ADVANCES IT. The ceiling timer
   * is armed and cannot fire. Only the wall clock moves, and the only thing that
   * gets JS running again is a desktop rekey - an inbound relay frame, which
   * reaches JS through the bridge's own queue rather than through Choreographer.
   *
   * Date.now is spied separately rather than letting the fake clock own it, the
   * same split localNotifier.test.ts uses and for the same reason: one clock
   * driving both would mean advancing past the ceiling also fires the very timer
   * this test has to keep inert, and the assertion would prove nothing.
   *
   * Dropping enforceKeepaliveCeiling() from the rekey listener makes this fail
   * with a live connection. The ceiling test above stays green either way, which
   * is why this one exists separately.
   */
  it('tears the keepalive down on a desktop rekey when the ceiling timer never fires', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const handshakeRoundsBefore = stub.establishedCount;
    const armedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(armedAtMs);

    // Only the timer functions. Date stays under the spy above, and nothing
    // else in this path needs a fake clock - the loopback transport the rekey
    // travels over is queueMicrotask-driven end to end.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      // Non-vacuity: the service really is up, so there is something to retire.
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(getActiveConnection()).not.toBeNull();

      // Wall clock past the ceiling; the armed timer is never advanced to it.
      nowSpy.mockReturnValue(armedAtMs + EXPECTED_KEEPALIVE_CEILING_MS);
      stub.beginHandshake();
      for (let round = 0; round < 20 && getActiveConnection() !== null; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }

      // The rekey landed, so the teardown below is the rekey's doing and not a
      // handshake that quietly failed and dropped the connection instead.
      expect(stub.establishedCount).toBeGreaterThan(handshakeRoundsBefore);
      expect(getActiveConnection()).toBeNull();
      expect(notifeeMocks.stopForegroundService).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
  });

  /**
   * Task #109: an inbound heartbeat is the same wake source a rekey is. It is
   * what lets the desktop probe presence with one sealed frame instead of a full
   * rekey without losing the keepalive's backstop. Same shape as the rekey test
   * above: the ceiling timer is armed and never advanced, the wall clock moves
   * past it, and the heartbeat is the only thing that runs JS.
   *
   * The phone's own heartbeat reply landing in stub.messages is the
   * non-vacuity check: the heartbeat really opened on the phone, so a teardown
   * that followed it is the wake source's doing.
   *
   * Mutation seen failing: deleting the `queueMicrotask(onKeepaliveWakeSource)`
   * from the heartbeat listener left the connection up.
   */
  it('tears the keepalive down on a desktop heartbeat when the ceiling timer never fires', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const armedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(armedAtMs);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(getActiveConnection()).not.toBeNull();
      const heartbeatsBefore = stub.messages.filter((message) => message.type === 'heartbeat').length;

      nowSpy.mockReturnValue(armedAtMs + EXPECTED_KEEPALIVE_CEILING_MS);
      stub.send({ type: 'heartbeat' });
      for (let round = 0; round < 20 && getActiveConnection() !== null; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(stub.messages.filter((message) => message.type === 'heartbeat').length).toBeGreaterThan(heartbeatsBefore);
      expect(getActiveConnection()).toBeNull();
      expect(notifeeMocks.stopForegroundService).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
  });

  /**
   * The negative twin of the heartbeat test above: only a heartbeat is a wake
   * source, not every inbound frame. onKeepaliveWakeSource writes a trace line
   * and does a dynamic import per call, and a backgrounded phone receives a
   * steady stream of events, so waking on all of them would be a cost with no
   * benefit. Same setup as the heartbeat test (ceiling timer armed and never
   * advanced, wall clock past the ceiling), with an event as the only inbound
   * frame. If the event were a wake source the connection would be torn down
   * exactly as it is for the heartbeat.
   *
   * The phone-side listener counting the event is the non-vacuity check: the
   * event really reached the phone's session while the wall clock was past the
   * ceiling, so a connection still up afterwards is the guard's doing and not
   * an event that never arrived.
   *
   * Mutation seen failing: dropping the `message.type === 'heartbeat'`
   * condition from the heartbeat listener, so every message queues
   * onKeepaliveWakeSource, tore the connection down on the event.
   */
  it('does not tear the keepalive down on a desktop event past the ceiling when the ceiling timer never fires', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const connection = getActiveConnection();
    if (!connection) throw new Error('expected an active connection');
    let eventsReceivedByPhone = 0;
    const unsubscribeEvents = connection.controller.session.onMessage((message) => {
      if (message.type === 'event') eventsReceivedByPhone += 1;
    });
    const armedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(armedAtMs);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(getActiveConnection()).not.toBeNull();

      nowSpy.mockReturnValue(armedAtMs + EXPECTED_KEEPALIVE_CEILING_MS);
      stub.emitEvent({ kind: 'diff', taskId: 'task-9', payload: null });
      for (let round = 0; round < 20 && eventsReceivedByPhone === 0; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      // One more drain: the wake source, were the event one, is deferred a
      // microtask past the listener that counted it.
      for (let round = 0; round < 20; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(eventsReceivedByPhone).toBe(1);
      expect(getActiveConnection()).not.toBeNull();
      expect(notifeeMocks.stopForegroundService).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
      unsubscribeEvents();
    }
  });

  /**
   * The heartbeat listener is attached to the session for one connection
   * attempt and must come off with it, like the probe listener below. It is
   * counted from the test side by wrapping SessionManager.prototype.onMessage
   * BEFORE the connection opens (the listener is attached during open, so an
   * instance spy taken afterwards would miss it): every subscription made over
   * the attempt's life must have been unsubscribed once it is stopped. The
   * heartbeat test above cannot see this, because the session is disposed with
   * the attempt and nothing is delivered to a stale listener afterwards.
   *
   * Mutation seen failing: deleting `unsubscribeHeartbeat();` from
   * teardownThisAttempt left the unsubscribe count one short of the
   * subscription count.
   */
  it('removes the heartbeat listener from the session when the connection is torn down', async () => {
    const { SessionManager } = await import('@/channel/sessionManager');
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    const originalOnMessage = SessionManager.prototype.onMessage;
    let subscriptionsMade = 0;
    let subscriptionsRemoved = 0;
    const onMessageSpy = vi.spyOn(SessionManager.prototype, 'onMessage').mockImplementation(function (
      this: InstanceType<typeof SessionManager>,
      listener,
    ) {
      subscriptionsMade += 1;
      const removeListener = originalOnMessage.call(this, listener);
      return () => {
        subscriptionsRemoved += 1;
        return removeListener();
      };
    });

    try {
      await establishAndWarm();
      // Non-vacuity: the connection attached listeners, and none came off yet.
      expect(subscriptionsMade).toBeGreaterThan(0);
      expect(subscriptionsRemoved).toBe(0);

      stopConnectionLifecycle();

      expect(subscriptionsRemoved).toBe(subscriptionsMade);
    } finally {
      onMessageSpy.mockRestore();
    }
  });

  /**
   * The negative case neither wall-clock test above pins. Both jump Date.now()
   * straight to the ceiling before firing their wake source, so nothing proves
   * enforceKeepaliveCeiling's own guard
   * (`Date.now() - keepaliveStartedAtMs < BACKGROUND_KEEPALIVE_MAX_MS`) still
   * points the right way. Inverting it, or dropping it outright, would tear
   * down every backgrounded connection on the desktop's first rekey - about two
   * minutes in, well short of the five-minute ceiling - and every other test in
   * this file would stay green, since none of them ever rekeys this early.
   */
  it('does not tear the keepalive down on a desktop rekey well before the ceiling', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const handshakeRoundsBefore = stub.establishedCount;
    const armedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(armedAtMs);

    // Same split as the rekey test above: only the timer functions are faked,
    // Date stays under the spy, and the loopback transport the rekey travels
    // over is queueMicrotask-driven end to end.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      // Non-vacuity checkpoint: the service really is up before the rekey below.
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(getActiveConnection()).not.toBeNull();

      // Clearly short of the ceiling, unlike the two tests above.
      nowSpy.mockReturnValue(armedAtMs + EXPECTED_KEEPALIVE_CEILING_MS / 2);
      stub.beginHandshake();
      for (let round = 0; round < 20 && stub.establishedCount === handshakeRoundsBefore; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      // The loop above watches the DESKTOP stub's counter, which is the far
      // side of the loopback from onRekey's queueMicrotask(onKeepaliveWakeSource).
      // One more drain closes that gap so the negatives below cannot pass
      // merely because that microtask was still queued.
      await vi.advanceTimersByTimeAsync(0);

      // The rekey actually landed, so a still-alive connection below is not
      // merely because the wake source never fired.
      expect(stub.establishedCount).toBeGreaterThan(handshakeRoundsBefore);
      expect(getActiveConnection()).not.toBeNull();
      expect(notifeeMocks.stopForegroundService).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
  });

  /**
   * The rekey backstop above has a gap this one closes: it needs the desktop to
   * still be there. Close the laptop and no rekey ever arrives again, while the
   * phone's transport drops and retries on its own backoff forever with the
   * foreground service still up. That is the most likely real shape of MOBILE-3
   * - an overnight stretch with nothing left driving the ceiling but the timer
   * that demonstrably did not fire.
   *
   * simulateReconnect is deliberately the blip path ('reconnecting' then back to
   * 'connected', never through 'closed'), which loopbackTransport's own comment
   * calls out as the one code watching only for 'closed' treats as if nothing
   * happened. Any state change counts as a wake source, so even a blip that
   * recovers gives the wall-clock check its chance.
   *
   * Same fake-timer split as above: setTimeout is faked and never advanced, so
   * the ceiling timer is armed and inert, and only Date.now moves. Dropping the
   * queueMicrotask(onKeepaliveWakeSource) from the transport listener makes this
   * fail with a live connection.
   */
  it('tears the keepalive down on a transport blip when the ceiling timer never fires', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    const armedAtMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(armedAtMs);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(getActiveConnection()).not.toBeNull();

      nowSpy.mockReturnValue(armedAtMs + EXPECTED_KEEPALIVE_CEILING_MS);
      phoneTransport.simulateReconnect();
      for (let round = 0; round < 20 && getActiveConnection() !== null; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }

      expect(getActiveConnection()).toBeNull();
      expect(notifeeMocks.stopForegroundService).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      nowSpy.mockRestore();
    }
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
   * Board task #70. Under the keepalive the 'background' branch keeps the
   * connection, so a foreground finds `activeConnection` non-null and
   * openConnection() returns without dialing. If the socket died while the
   * phone was away, the transport sits mid-backoff with its timer ratcheted
   * towards the cap, and nothing dials until that timer fires. The 'active'
   * branch has to kick the transport itself.
   *
   * A WIRING test, and its comment says so: the kick is unconditional (the
   * transport decides whether a dial is warranted), so the spy fires with or
   * without the simulated drop. The drop only makes the scenario the honest
   * one. The behavioural proof - a transport ratcheted to its cap dials at
   * once - is tests/unit/relayTransportReconnect.test.ts; do not read a pass
   * here as proof of recovery. Mutation seen failing: removing the
   * kickTransportOnForeground() call from the 'active' branch.
   */
  it('kicks the surviving transport on foreground instead of waiting out its backoff', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    const connectionBefore = getActiveConnection();
    const redialNow = vi.spyOn(phoneTransport, 'redialNow');

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);
      expect(redialNow).not.toHaveBeenCalled();

      phoneTransport.simulateDrop();
      await vi.advanceTimersByTimeAsync(0);
      expect(phoneTransport.state).toBe('reconnecting');

      onAppStateChange('active');
      expect(redialNow).toHaveBeenCalledTimes(1);
      // The kick acts on the connection that exists: no teardown, no reopen.
      await vi.advanceTimersByTimeAsync(0);
      expect(getActiveConnection()).toBe(connectionBefore);
    } finally {
      vi.useRealTimers();
      redialNow.mockRestore();
    }
  });

  /**
   * Board task #70, the failure the kick cannot see. Measured on a release
   * build: a network stall the OS never reports leaves the transport reading
   * 'connected' and the session 'established' while the relay has stopped
   * hearing the phone and the desktop has dropped its subscriptions. The
   * phone then sits silent and stale until something sends. So the 'active'
   * branch sends one cheap request, and a request nobody answers within the
   * deadline is the proof that forces a fresh dial.
   *
   * The stub has no request handler here, so the probe goes unanswered. The
   * first redialNow is the unconditional kick (no arguments); the forced one
   * must land exactly at the deadline. Mutation seen failing: removing the
   * probeChannelOnForeground() call from the 'active' branch (the second call
   * never comes).
   */
  it('force-redials on foreground when the established channel answers nothing', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    const redialNow = vi.spyOn(phoneTransport, 'redialNow');

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(redialNow).toHaveBeenCalledTimes(1);
      expect(redialNow).toHaveBeenCalledWith();

      await vi.advanceTimersByTimeAsync(EXPECTED_PROBE_TIMEOUT_MS - 1);
      expect(redialNow).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(redialNow).toHaveBeenCalledTimes(2);
      expect(redialNow).toHaveBeenLastCalledWith({ force: true });
      expect(getActiveConnection()).not.toBeNull();
    } finally {
      vi.useRealTimers();
      redialNow.mockRestore();
    }
  });

  /**
   * The other verdict: a channel that answers is left alone. The stub answers
   * the project list here, so the probe resolves and the deadline passing
   * forces nothing. A probe that forced regardless of the answer would turn
   * every foreground into a reconnect, which is the bug this test guards.
   */
  it('leaves an answering channel alone on foreground', async () => {
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    stub.setRequestHandler((request: CapabilityRequestMessage): CapabilityResponseMessage => ({
      type: 'capability-response',
      requestId: request.requestId,
      ok: true,
      payload: { projects: [] },
    }));
    const redialNow = vi.spyOn(phoneTransport, 'redialNow');

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      onAppStateChange('active');
      // The request and its answer are a handful of loopback microtask hops.
      for (let round = 0; round < 8; round += 1) await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(EXPECTED_PROBE_TIMEOUT_MS + 1);
      expect(redialNow).toHaveBeenCalledTimes(1);
      expect(redialNow).not.toHaveBeenCalledWith({ force: true });
    } finally {
      vi.useRealTimers();
      redialNow.mockRestore();
      stub.setRequestHandler(null);
    }
  });

  /**
   * The stale-verdict branch: a probe that finally rejects (its 3 s deadline
   * elapsing) must NOT force a redial once the session it was judging has
   * since re-established. Both probe tests above keep the SAME connection
   * live and unchanged throughout, so `stale` is always false in them and
   * deleting the `if (stale) return;` guard would still leave both green.
   *
   * Mutation seen failing: deleting `if (stale) return;` from
   * probeChannelOnForeground made the deadline's rejection call
   * `transport.redialNow({ force: true })` even though establishedEpoch had
   * moved on - "expected redialNow to be called 1 times, but got 2 times".
   */
  it('does not force a redial when the probed session re-establishes before the deadline elapses', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const redialNow = vi.spyOn(phoneTransport, 'redialNow');
    const connectionBeforeReestablish = getActiveConnection();
    if (!connectionBeforeReestablish) throw new Error('expected an active connection before the probe');

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(redialNow).toHaveBeenCalledTimes(1);
      expect(redialNow).toHaveBeenCalledWith();

      // Before the probe's deadline, the SAME connection re-establishes (a
      // fresh KK handshake), bumping establishedEpoch past the value the
      // in-flight probe captured when it started.
      const bootstrapCallCountBeforeReestablish = mockRunBootstrap.mock.calls.length;
      connectionBeforeReestablish.controller.session.reset();
      stub.beginHandshake();
      for (
        let round = 0;
        round < 20 && mockRunBootstrap.mock.calls.length === bootstrapCallCountBeforeReestablish;
        round += 1
      ) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(mockRunBootstrap.mock.calls.length).toBeGreaterThan(bootstrapCallCountBeforeReestablish);

      // The probe's own deadline elapses; the unanswered read-board rejects
      // with a timeout, but the verdict must see the probe as stale.
      await vi.advanceTimersByTimeAsync(EXPECTED_PROBE_TIMEOUT_MS + 1);
      expect(redialNow).toHaveBeenCalledTimes(1);
      expect(redialNow).not.toHaveBeenCalledWith({ force: true });
    } finally {
      vi.useRealTimers();
      redialNow.mockRestore();
    }
  });

  /**
   * The rekey variant of the same stale-verdict guard. `establishedEpoch`
   * does not move on a rekey - src/channel/sessionManager.ts documents that a
   * rekey fires onRekey only, never onEstablished, deliberately, because "a
   * rekey must not look like a fresh connection". But a rekey landing inside
   * the probe's 3 s window could lose the probe's ANSWER, which a desktop
   * without the 0.45.0 hold sealed under the old keys after the phone had
   * switched (task #109; this used to say the probe itself was lost, which
   * had the direction backwards). The phone receiving and processing that
   * rekey frame is proof the socket is alive, so the verdict must not tear it
   * down. Here the stub simply never answers, so only the guard is tested.
   *
   * `useChannelStore().rekeyCount` is asserted FIRST, and deliberately before
   * the deadline-crossing advance below: it is the phone's own onRekey
   * listener actually firing (SessionManager.onRekey -> connectionManager's
   * listener, which bumps both rekeyCount and rekeyEpoch on the same
   * synchronous tick), so a silent no-op that never reached the phone cannot
   * make the later "no forced redial" assertion pass vacuously.
   *
   * Mutation seen failing: removing `rekeyed` from the `stale` expression in
   * probeChannelOnForeground made the deadline's rejection call
   * `transport.redialNow({ force: true })` even though a rekey had landed -
   * "expected redialNow to be called 1 times, but got 2 times".
   */
  it('does not force a redial when a rekey lands inside the probe window', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const redialNow = vi.spyOn(phoneTransport, 'redialNow');

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(redialNow).toHaveBeenCalledTimes(1);
      expect(redialNow).toHaveBeenCalledWith();

      // Partway through the probe's own deadline, a rekey lands and loses it.
      await vi.advanceTimersByTimeAsync(500);
      const rekeyCountBeforeRekey = useChannelStore.getState().rekeyCount;
      stub.beginHandshake();
      for (
        let round = 0;
        round < 20 && useChannelStore.getState().rekeyCount === rekeyCountBeforeRekey;
        round += 1
      ) {
        await vi.advanceTimersByTimeAsync(0);
      }
      // The phone actually saw the rekey - checked BEFORE the deadline-crossing
      // advance below, so a silent no-op cannot make this test pass vacuously.
      expect(useChannelStore.getState().rekeyCount).toBeGreaterThan(rekeyCountBeforeRekey);

      // Past the probe's own deadline; the lost probe rejects with a timeout,
      // but the verdict must see the rekey and leave the transport alone.
      await vi.advanceTimersByTimeAsync(EXPECTED_PROBE_TIMEOUT_MS);
      expect(redialNow).toHaveBeenCalledTimes(1);
      expect(redialNow).not.toHaveBeenCalledWith({ force: true });
      expect(getActiveConnection()).not.toBeNull();
    } finally {
      vi.useRealTimers();
      redialNow.mockRestore();
    }
  });

  /**
   * Board task #107: a SLOW desktop, not a dead socket. Measured on the Pixel
   * (2026-10-07): the desktop pushed a board update 2.2 s into the probe, the
   * project list itself answered after the 3 s deadline, and the forced
   * redial that followed cost about 8 s and left the terminal being opened
   * blank. An event decrypted on the current session while the probe waits
   * answers the probe's question, so the deadline must leave the socket alone.
   *
   * The phone's own receipt of the event is asserted FIRST, through a listener
   * on the same session, before the deadline-crossing advance: a push that
   * never reached the phone cannot make the "no forced redial" assertion pass
   * vacuously.
   *
   * Mutation seen failing: removing `desktopSpoke` from the `stale` expression
   * in probeChannelOnForeground made the deadline's rejection call
   * `transport.redialNow({ force: true })` after the event had arrived.
   */
  it('does not force a redial when the desktop pushes an event inside the probe window', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const connection = getActiveConnection();
    if (!connection) throw new Error('expected an active connection');
    const redialNow = vi.spyOn(phoneTransport, 'redialNow');
    let eventsReceivedByPhone = 0;
    const unsubscribeEvents = connection.controller.session.onMessage((message) => {
      if (message.type === 'event') eventsReceivedByPhone += 1;
    });

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(redialNow).toHaveBeenCalledTimes(1);
      expect(redialNow).toHaveBeenCalledWith();

      // The measured shape: a push 2.2 s in, the probe still unanswered.
      await vi.advanceTimersByTimeAsync(2_200);
      stub.emitEvent({ kind: 'diff', taskId: 'task-9', payload: null });
      for (let round = 0; round < 20 && eventsReceivedByPhone === 0; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(eventsReceivedByPhone).toBe(1);

      // Past the probe's own deadline; the unanswered request rejects with a
      // timeout, but the desktop has spoken, so the transport is left alone.
      await vi.advanceTimersByTimeAsync(EXPECTED_PROBE_TIMEOUT_MS);
      expect(redialNow).toHaveBeenCalledTimes(1);
      expect(redialNow).not.toHaveBeenCalledWith({ force: true });
      expect(getActiveConnection()).not.toBeNull();
    } finally {
      vi.useRealTimers();
      redialNow.mockRestore();
      unsubscribeEvents();
    }
  });

  /**
   * The other side of the same guard: a desktop HEARTBEAT is not a sign of
   * life for this probe. It is the desktop's presence probe, sent to a phone
   * it suspects is gone, and it keeps arriving in the task #70 stall the probe
   * exists for (the relay has stopped hearing the phone, while the phone still
   * hears the desktop). Counting it would disable the probe in exactly that
   * case.
   *
   * Mutation seen failing: counting every message type as proof (dropping the
   * `message.type` filter in probeChannelOnForeground's listener) left
   * redialNow at one call - the forced redial never came.
   */
  it('still force-redials when only a desktop heartbeat arrives inside the probe window', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const connection = getActiveConnection();
    if (!connection) throw new Error('expected an active connection');
    const redialNow = vi.spyOn(phoneTransport, 'redialNow');
    let heartbeatsReceivedByPhone = 0;
    const unsubscribeHeartbeats = connection.controller.session.onMessage((message) => {
      if (message.type === 'heartbeat') heartbeatsReceivedByPhone += 1;
    });

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(redialNow).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(500);
      stub.send({ type: 'heartbeat' });
      for (let round = 0; round < 20 && heartbeatsReceivedByPhone === 0; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(heartbeatsReceivedByPhone).toBe(1);

      await vi.advanceTimersByTimeAsync(EXPECTED_PROBE_TIMEOUT_MS);
      expect(redialNow).toHaveBeenCalledTimes(2);
      expect(redialNow).toHaveBeenLastCalledWith({ force: true });
    } finally {
      vi.useRealTimers();
      redialNow.mockRestore();
      unsubscribeHeartbeats();
    }
  });

  /**
   * The third thing that counts as the desktop speaking: a capability-response.
   * A slow desktop can answer an EARLIER request (a bootstrap read still in
   * flight) while the probe's own read-board is still unanswered, and that
   * response proves the socket carries traffic exactly as an event does. The
   * response here carries an unrelated request id, so the probe's own request
   * is never answered and the deadline still rejects: only the listener's
   * clause can keep the transport alone.
   *
   * Mutation seen failing: dropping `|| message.type === 'capability-response'`
   * from the probe's onMessage listener left redialNow at two calls, the second
   * being the forced `{ force: true }` redial.
   */
  it('does not force a redial when a response to another request arrives inside the probe window', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const connection = getActiveConnection();
    if (!connection) throw new Error('expected an active connection');
    const redialNow = vi.spyOn(phoneTransport, 'redialNow');
    let responsesReceivedByPhone = 0;
    const unsubscribeResponses = connection.controller.session.onMessage((message) => {
      if (message.type === 'capability-response') responsesReceivedByPhone += 1;
    });

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(redialNow).toHaveBeenCalledTimes(1);
      expect(redialNow).toHaveBeenCalledWith();

      await vi.advanceTimersByTimeAsync(2_200);
      stub.send({
        type: 'capability-response',
        requestId: 'a-request-the-probe-did-not-send',
        ok: true,
        payload: { projects: [] },
      });
      for (let round = 0; round < 20 && responsesReceivedByPhone === 0; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(responsesReceivedByPhone).toBe(1);

      await vi.advanceTimersByTimeAsync(EXPECTED_PROBE_TIMEOUT_MS);
      expect(redialNow).toHaveBeenCalledTimes(1);
      expect(redialNow).not.toHaveBeenCalledWith({ force: true });
      expect(getActiveConnection()).not.toBeNull();
    } finally {
      vi.useRealTimers();
      redialNow.mockRestore();
      unsubscribeResponses();
    }
  });

  /**
   * The probe's message listener must not outlive the probe: it is attached to
   * the long-lived session, so one left behind per foreground would accumulate
   * a closure over every probe's state for the life of the connection. Counted
   * from the test side by wrapping the session's own onMessage, which adds no
   * production surface: every subscription the probe makes must be unsubscribed
   * once its request settles.
   *
   * Mutation seen failing: deleting `unsubscribeDesktopSpoke()` from the probe's
   * `.finally` left the unsubscribe count at 0 against 1 subscription.
   */
  it('removes the probe listener from the session once the probe settles', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const connection = getActiveConnection();
    if (!connection) throw new Error('expected an active connection');
    const session = connection.controller.session;
    const originalOnMessage = session.onMessage.bind(session);
    let subscriptionsMade = 0;
    let subscriptionsRemoved = 0;
    const onMessageSpy = vi.spyOn(session, 'onMessage').mockImplementation((listener) => {
      subscriptionsMade += 1;
      const removeListener = originalOnMessage(listener);
      return () => {
        subscriptionsRemoved += 1;
        removeListener();
      };
    });

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      // Non-vacuity: the probe is in flight and has subscribed exactly once.
      expect(subscriptionsMade).toBe(1);
      expect(subscriptionsRemoved).toBe(0);

      await vi.advanceTimersByTimeAsync(EXPECTED_PROBE_TIMEOUT_MS + 1);
      expect(subscriptionsRemoved).toBe(subscriptionsMade);
    } finally {
      vi.useRealTimers();
      onMessageSpy.mockRestore();
    }
  });

  /**
   * Task #109's switch-off arm for the guard above, which is how its "before"
   * is measured in one trace build: the same event arrives inside the window
   * and is ignored, so the deadline tears down a socket that was carrying the
   * desktop's traffic. Without this, a switch wired to nothing would read as
   * a fix that made no difference.
   *
   * Mutation seen failing: computing `heardFromDesktop` as `desktopSpoke`
   * alone (dropping the frameLivenessEnabled() gate) left redialNow at one
   * call - the forced redial never came.
   */
  it('force-redials despite an event inside the probe window when the frame-liveness switch is off', async () => {
    keepaliveProbeMocks.frameLivenessEnabled.mockReturnValue(false);
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const phoneTransport = mockDesktopSeam.phoneTransport as LoopbackTransport;
    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    const connection = getActiveConnection();
    if (!connection) throw new Error('expected an active connection');
    const redialNow = vi.spyOn(phoneTransport, 'redialNow');
    let eventsReceivedByPhone = 0;
    const unsubscribeEvents = connection.controller.session.onMessage((message) => {
      if (message.type === 'event') eventsReceivedByPhone += 1;
    });

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(redialNow).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2_200);
      stub.emitEvent({ kind: 'diff', taskId: 'task-9', payload: null });
      for (let round = 0; round < 20 && eventsReceivedByPhone === 0; round += 1) {
        await vi.advanceTimersByTimeAsync(0);
      }
      expect(eventsReceivedByPhone).toBe(1);

      await vi.advanceTimersByTimeAsync(EXPECTED_PROBE_TIMEOUT_MS);
      expect(redialNow).toHaveBeenCalledTimes(2);
      expect(redialNow).toHaveBeenLastCalledWith({ force: true });
    } finally {
      vi.useRealTimers();
      redialNow.mockRestore();
      unsubscribeEvents();
    }
  });

  /**
   * foregroundProbeInFlight's own re-entry guard: two 'active' transitions
   * before the first probe settles must not send two read-board requests.
   * Every existing probe test drives 'active' exactly once, so none of them
   * would notice this guard disappearing.
   *
   * Mutation seen failing: relaxing the guard from
   * `if (!connection || foregroundProbeInFlight) return;` to
   * `if (!connection) return;` let the second 'active' transition send a
   * second read-board request - "expected 'request' to be called 1 times,
   * but got 2 times".
   */
  it('does not send a second foreground probe while the first is still in flight', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const connection = getActiveConnection();
    if (!connection) throw new Error('expected an active connection');
    const capabilitiesRequest = vi.spyOn(connection.controller.capabilities, 'request');

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(capabilitiesRequest).toHaveBeenCalledTimes(1);
      expect(capabilitiesRequest).toHaveBeenCalledWith('read-board', {}, { timeoutMs: EXPECTED_PROBE_TIMEOUT_MS });

      // A second 'active' transition arrives while the first probe is still
      // outstanding.
      onAppStateChange('active');
      await vi.advanceTimersByTimeAsync(0);
      expect(capabilitiesRequest).toHaveBeenCalledTimes(1);

      // Let the first probe's own deadline elapse so nothing leaks into
      // another test.
      await vi.advanceTimersByTimeAsync(EXPECTED_PROBE_TIMEOUT_MS + 1);
    } finally {
      vi.useRealTimers();
      capabilitiesRequest.mockRestore();
    }
  });

  /**
   * closeConnection() does not own the keepalive (see reconnectNow's own
   * comment), so reconnectNow() has to stop it explicitly rather than relying
   * on a prior AppState 'active' transition to have already done so. Left
   * armed, a ceiling timer from an earlier background would still hold the
   * SAME keepalive generation and fire later against whatever connection is
   * active by then - tearing down the fresh session reconnectNow just opened,
   * not the backgrounded one the timer was meant for.
   *
   * The discriminating assertion is the one right after reconnectNow(), not
   * the survival one: dropping the stopBackgroundKeepalive() call from
   * reconnectNow leaves the original timer's generation untouched, so it
   * still fires on schedule and calls stopForegroundService from INSIDE the
   * ceiling handler instead - just five minutes later than this test expects.
   */
  it('stops the keepalive when reconnectNow is called, so a stale ceiling timer cannot fire later', async () => {
    const { reconnectNow } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    vi.useFakeTimers();
    try {
      onAppStateChange('background');
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.displayNotification).toHaveBeenCalledTimes(1);

      // Partway through the ceiling, well short of either edge.
      await vi.advanceTimersByTimeAsync(EXPECTED_KEEPALIVE_CEILING_MS / 2);

      reconnectNow();
      // stopBackgroundKeepalive's own service-stop reaches notifee through a
      // dynamic import, landing a microtask after the synchronous call.
      await vi.advanceTimersByTimeAsync(0);
      expect(notifeeMocks.stopForegroundService).toHaveBeenCalledTimes(1);

      // Past where the ORIGINAL ceiling timer would have fired had
      // reconnectNow left it armed. A second stop call here means it did.
      await vi.advanceTimersByTimeAsync(EXPECTED_KEEPALIVE_CEILING_MS);
      expect(notifeeMocks.stopForegroundService).toHaveBeenCalledTimes(1);
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

    setNotificationPermissionStatus('denied');
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

    setNotificationPermissionStatus('denied');
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

  /**
   * The connectionManager side of the reassert wiring, not foregroundService's
   * own retry loop (that half is pinned in isolation by foregroundService.test.ts's
   * "retries a rejected stop" case). Every test above keeps stopForegroundService
   * resolving, so onAppStateChange's reassertForegroundServiceState() call - the
   * one that dynamic-imports reassertConnectedForegroundService() - is always a
   * silent no-op here. A broken import path or a dropped call would go unnoticed.
   */
  it('retries a stop that failed every attempt through the real reassert wiring on the next AppState transition', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();

    onAppStateChange('background');
    await waitUntil(() => notifeeMocks.displayNotification.mock.calls.length === 1, {
      label: 'foreground service posted',
    });
    // Non-vacuity checkpoint: the service really is up before the stop below.
    expect(getActiveConnection()).not.toBeNull();

    notifeeMocks.stopForegroundService.mockRejectedValue(new Error('native stop failed'));
    onAppStateChange('active');
    await waitUntil(() => notifeeMocks.stopForegroundService.mock.calls.length === 3, {
      label: 'all three stop attempts exhausted',
    });

    notifeeMocks.stopForegroundService.mockResolvedValue(undefined);
    // A SECOND 'active' transition is what has to carry the retry: nothing
    // else in this test declares a new desired state, so a 4th call can only
    // come from reassertForegroundServiceState -> reassertConnectedForegroundService.
    onAppStateChange('active');

    await waitUntil(() => notifeeMocks.stopForegroundService.mock.calls.length === 4, {
      label: 'stop retried through reassertForegroundServiceState',
    });
  });

  /**
   * onKeepaliveWakeSource's OTHER half, exercised through a wake source that is
   * not AppState. The test above only pins onAppStateChange's own
   * reassertForegroundServiceState() call; the rekey and transport-blip ceiling
   * tests above only exercise enforceKeepaliveCeiling(). Nothing in this file
   * previously proved that a rekey ALSO retries a stop the reconciler still
   * owes, and deleting `reassertForegroundServiceState();` from
   * onKeepaliveWakeSource breaks none of those tests.
   *
   * Deliberately mirrors the AppState test above almost line for line, with
   * exactly one difference: the retry's wake source is a rekey on the SAME
   * still-established connection (stub.beginHandshake()), not a second
   * onAppStateChange('active') call. The connection is never closed or
   * reopened here - 'active' only stops the keepalive, it does not tear down
   * the session - so the stub captured after establishment stays valid and
   * nothing here has to route back through closeConnection()/openConnection(),
   * which would introduce transport-state churn of its own. Deleting
   * `reassertForegroundServiceState();` from onKeepaliveWakeSource makes this
   * time out waiting for a 4th call instead of reaching it; the AppState test
   * above stays green either way, since it drives the retry through a
   * different call site entirely.
   */
  it('retries a stop that failed every attempt through a rekey wake source, not just AppState', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const onAppStateChange = await establishAndWarm();
    const stub = mockDesktopSeam.stub as StubSessionInitiator;

    onAppStateChange('background');
    await waitUntil(() => notifeeMocks.displayNotification.mock.calls.length === 1, {
      label: 'foreground service posted',
    });
    // Non-vacuity checkpoint: the service really is up before the stop below.
    expect(getActiveConnection()).not.toBeNull();

    notifeeMocks.stopForegroundService.mockRejectedValue(new Error('native stop failed'));
    onAppStateChange('active');
    await waitUntil(() => notifeeMocks.stopForegroundService.mock.calls.length === 3, {
      label: 'all three stop attempts exhausted',
    });

    notifeeMocks.stopForegroundService.mockResolvedValue(undefined);
    const establishedCountBefore = stub.establishedCount;
    // No AppState transition anywhere from here on: a 4th call can only come
    // from onKeepaliveWakeSource's own reassertForegroundServiceState(),
    // reached through the rekey listener on the still-live session.
    stub.beginHandshake();
    await waitUntil(() => stub.establishedCount > establishedCountBefore, { label: 'rekey landed' });

    await waitUntil(() => notifeeMocks.stopForegroundService.mock.calls.length === 4, {
      label: 'stop retried through the rekey wake source',
    });
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
    mockDesktopSeam.phoneTransport = null;
    platformMock.OS = 'android';
    setNotificationPermissionStatus('granted');
    notifeeMocks.requestPermission.mockClear();
    notifeeMocks.requestPermission.mockResolvedValue({ authorizationStatus: 1 });
    notifeeMocks.getNotificationSettings.mockReset();
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    stopConnectionLifecycle();
    vi.useRealTimers();
    platformMock.OS = 'android';
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
   * The iOS shape of the same in-flight race, and a different window than the
   * Android test above: on iOS with `alreadyAsked` true, the guard has to hold
   * across the FIRST await (`refreshNotificationPermission()`), before
   * `requestPermission()` is ever reached - not merely around requestPermission
   * itself. `notificationPermissionPromptInFlight` is set synchronously before
   * that await, so a second onEstablished landing while the refresh is still
   * pending must not start its own refresh/request sequence.
   *
   * The second half matters just as much: the `.finally()` has to reset the
   * flag once the first sequence settles, so a LATER establishment (not the
   * racing one) can still prompt. A guard that never resets would silently
   * stop asking forever after the first race.
   */
  it('does not start a second iOS prompt sequence while refreshNotificationPermission is still pending, and resets the guard afterwards', async () => {
    const { startConnectionLifecycle, getActiveConnection } = await import('@/connection/connectionManager');
    platformMock.OS = 'ios';
    useSettingsStore.setState({ hasRequestedNotificationPermission: true });
    setNotificationPermissionStatus('granted');

    const firstRefresh = createDeferred<{ authorizationStatus: number }>();
    notifeeMocks.getNotificationSettings.mockImplementation(() => firstRefresh.promise);

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => notifeeMocks.getNotificationSettings.mock.calls.length === 1, {
      label: 'first refresh issued',
    });

    // The second onEstablished lands while the first refresh is still
    // pending - before requestPermission() was ever reached.
    const activeConnection = getActiveConnection();
    if (!activeConnection) throw new Error('expected an active connection after establishment');
    activeConnection.controller.session.reset();
    (mockDesktopSeam.stub as StubSessionInitiator).beginHandshake();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 2, { label: 're-established' });

    // Still only the one refresh call, and requestPermission never reached:
    // the second establishment did not start its own prompt sequence.
    expect(notifeeMocks.getNotificationSettings).toHaveBeenCalledTimes(1);
    expect(notifeeMocks.requestPermission).not.toHaveBeenCalled();

    // Resolve as "still granted", which returns early without ever calling
    // requestPermission - and, via .finally(), resets the in-flight guard.
    firstRefresh.resolve({ authorizationStatus: 1 });
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
    // Let the whole .then()/.catch()/.finally() chain settle before driving a
    // third establishment - otherwise the real handshake can re-establish
    // faster than that chain unwinds, and the third call would race the
    // .finally() reset rather than genuinely test it.
    await flushMicrotasks();

    // A THIRD establishment only starts a fresh refresh call if the guard was
    // actually reset; stuck at true, this would time out instead.
    activeConnection.controller.session.reset();
    (mockDesktopSeam.stub as StubSessionInitiator).beginHandshake();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 3, { label: 're-established again' });
    await waitUntil(() => notifeeMocks.getNotificationSettings.mock.calls.length === 2, {
      label: 'guard reset, second refresh issued',
    });

    expect(notifeeMocks.requestPermission).not.toHaveBeenCalled();
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

  /**
   * The TestFlight bug. This function opened with `if (Platform.OS !== 'android')
   * return`, so iOS was never asked for authorization - and the failure was
   * invisible, because registration still succeeded:
   * getDevicePushTokenAsync only calls registerForRemoteNotifications(), which
   * yields an APNs token with no authorization behind it. The phone got a token,
   * the desktop sent, APNs delivered, and iOS discarded every alert.
   */
  it('asks on iOS too', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    platformMock.OS = 'ios';
    setNotificationPermissionStatus('not-determined');

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => useSettingsStore.getState().hasRequestedNotificationPermission, { label: 'permission requested' });

    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);
  });

  /**
   * iOS Keychain items survive app deletion, so the persisted "we already asked"
   * flag can outlive the authorization it describes: reinstall, and the flag is
   * still true while iOS has reset authorization to NOT_DETERMINED. A flag-only
   * gate would leave that install never asked AND told in Settings that
   * notifications are blocked. When the OS says nobody has been asked, the OS wins.
   *
   * THE CACHE IS SEEDED STALE HERE ON PURPOSE. That is the production shape:
   * initializeNotifications refreshes the cache fire-and-forget at bundle entry
   * and nothing orders that against establishment, so whatever this reads
   * synchronously may not reflect the OS yet. Reading the cache instead of the
   * OS is the bug this pins - with a stale 'granted' in hand, a cache-based gate
   * decides "not not-determined" and never prompts the very device that needs it.
   */
  it('asks again on iOS when the OS reports not-determined, even against a stale cache', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    platformMock.OS = 'ios';
    useSettingsStore.setState({ hasRequestedNotificationPermission: true });
    setNotificationPermissionStatus('granted');
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: -1 }); // NOT_DETERMINED

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
    await waitUntil(() => notifeeMocks.requestPermission.mock.calls.length === 1, { label: 'permission requested' });

    expect(notifeeMocks.requestPermission).toHaveBeenCalledTimes(1);
  });

  /**
   * The override above is scoped to not-determined, not to iOS generally: an iOS
   * user who was asked and refused must not be re-prompted on every establishment.
   */
  it('does not re-ask on iOS once the OS reports a real answer', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    platformMock.OS = 'ios';
    useSettingsStore.setState({ hasRequestedNotificationPermission: true });
    setNotificationPermissionStatus('granted');
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 }); // DENIED

    startConnectionLifecycle();
    await waitUntil(() => notifeeMocks.getNotificationSettings.mock.calls.length >= 1, { label: 'permission re-read' });
    await flushMicrotasks();

    expect(notifeeMocks.requestPermission).not.toHaveBeenCalled();
  });
});

/**
 * onAppStateChange's 'active' branch used to wrap its refreshNotificationPermission
 * call in `if (Platform.OS === 'android')`. That gate is gone now, deliberately:
 * the Settings blocked-notice seeds itself from this cache on BOTH platforms, and
 * initializeNotifications already seeds the cache on both too, so leaving iOS out
 * meant a permission revoked from system settings while the app was away went
 * unnoticed there, and Settings could keep showing a stale "granted" with no
 * explanation for the silence. The existing foreground-refresh test in the
 * keepalive describe above only ever runs with this file's default Platform.OS
 * ('android'), so the cross-platform half was never actually exercised.
 */
describe('connectionManager foreground permission refresh (cross-platform)', () => {
  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    useSettingsStore.setState({
      backgroundNotificationsMode: 'foreground-service',
      hasRequestedNotificationPermission: true,
      hydrated: true,
    });
    mockRunBootstrap.mockReset();
    mockRunBootstrap.mockResolvedValue(undefined);
    mockDesktopSeam.stub = null;
    mockDesktopSeam.phoneTransport = null;
    setNotificationPermissionStatus('granted');
    notifeeMocks.getNotificationSettings.mockReset();
    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 1 });
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    stopConnectionLifecycle();
    platformMock.OS = 'android';
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useSettingsStore.setState({ backgroundNotificationsMode: 'off', hasRequestedNotificationPermission: false, hydrated: false });
    useChannelStore.getState().reset();
  });

  it('refreshes the permission cache on an active transition on iOS, not just Android', async () => {
    platformMock.OS = 'ios';
    const onAppStateChange = await establishAndWarm();
    // Establishment itself fires a refresh on iOS (maybeRequestNotificationPermission's
    // alreadyAsked branch); let that settle before driving the transition under test,
    // so the assertion below can only be satisfied by the 'active' handler's own call.
    await waitUntil(() => notifeeMocks.getNotificationSettings.mock.calls.length >= 1, {
      label: 'establishment-time refresh settled',
    });

    notifeeMocks.getNotificationSettings.mockResolvedValue({ authorizationStatus: 0 }); // DENIED
    onAppStateChange('active');

    await waitUntil(() => notificationPermissionGranted() === false, {
      label: 'iOS permission cache refreshed to denied on an active transition',
    });
  });
});
