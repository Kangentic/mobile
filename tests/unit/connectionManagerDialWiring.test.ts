/**
 * connectionManager's `onDial` wiring: the one place a relay dial id leaves the
 * channel layer, on its way to the crash report's `relay_dial_id` tag
 * (src/state/connectionBreadcrumbs.ts writes the tag from the store).
 *
 * What is pinned is the wiring only: the session connection subscribes BEFORE
 * it dials, so the first dial is seen; each announced id lands in the store;
 * and the teardown unsubscribes, so an abandoned attempt cannot go on writing
 * into the shared store (the two-connections-one-store hazard the generation
 * guard in openConnection exists for). That the transport mints a fresh id per
 * dial and announces it before its state change is
 * tests/unit/relayTransportReconnect.test.ts; that the tag is written is
 * tests/unit/connectionBreadcrumbs.test.ts and tests/unit/reportContext.test.ts.
 *
 * The harness is the minimum of connectionManagerTraceCallSites.test.ts's
 * second describe (a loopback mock desktop and the leaf mocks a real
 * established session reaches). The loopback transport has no `onDial` of its
 * own, which is also why the mock and the demo never set the tag; this file
 * gives the phone's end one, so the connection manager treats it as a relay
 * transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { startConnectionLifecycle, stopConnectionLifecycle } from '@/connection/connectionManager';
import { setNotificationPermissionStatus } from '@/notifications/permissionCache';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import { waitUntil } from '../helpers/async';

/** What the phone transport's test-local `onDial` saw. */
const dialSeam = vi.hoisted(() => ({
  listeners: new Set<(dialId: string) => void>(),
  /** How many listeners were subscribed when the transport was told to connect. */
  listenersAtConnect: null as number | null,
}));

const crashReportingMocks = vi.hoisted(() => ({ reportHandledError: vi.fn() }));
vi.mock('@/observability/crashReporting', () => ({ reportHandledError: crashReportingMocks.reportHandledError }));

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

const mockRunBootstrap = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: mockRunBootstrap }));

vi.mock('@/notifications/pushRegistration', () => ({
  registerPushWithDesktop: vi.fn(async () => undefined),
  unregisterPushWithDesktop: vi.fn(async () => undefined),
  resetPushRegistrationProcessState: vi.fn(),
}));

vi.mock('@notifee/react-native', () => ({
  default: {
    displayNotification: vi.fn(async () => 'notification-id'),
    registerForegroundService: vi.fn(),
    stopForegroundService: vi.fn(async () => undefined),
    createChannels: vi.fn(async () => undefined),
    requestPermission: vi.fn(async () => ({ authorizationStatus: 1 })),
    getNotificationSettings: vi.fn(async () => ({ authorizationStatus: 1 })),
    openNotificationSettings: vi.fn(async () => undefined),
  },
  AndroidForegroundServiceType: { FOREGROUND_SERVICE_TYPE_DATA_SYNC: 1 },
  AndroidImportance: { NONE: 0, MIN: 1, LOW: 2, DEFAULT: 3, HIGH: 4 },
  AuthorizationStatus: { NOT_DETERMINED: -1, DENIED: 0, AUTHORIZED: 1, PROVISIONAL: 2 },
}));

vi.mock('../../modules/foreground-service-guard', () => ({
  armForegroundServiceStopAlarm: vi.fn(),
  disarmForegroundServiceStopAlarm: vi.fn(),
  awaitForegroundServiceStopped: vi.fn(async () => true),
}));

vi.mock('@/connection/mockDesktop', async () => {
  const { createLoopbackPair } = await import('@/devsupport/loopbackTransport');
  const { StubSessionInitiator } = await import('@/devsupport/stubDesktopPeer');
  const { generateX25519KeyPair } = await import('@kangentic/protocol');
  return {
    createMockDesktop: () => {
      const [phoneTransport, desktopTransport] = createLoopbackPair();
      // The phone's end, made to look like a relay transport: an `onDial` that
      // records its subscribers, and a connect that notes how many there were
      // when the connection manager dialed.
      const realConnect = phoneTransport.connect.bind(phoneTransport);
      Object.assign(phoneTransport, {
        relayDialId: null,
        onDial(listener: (dialId: string) => void): () => void {
          dialSeam.listeners.add(listener);
          return () => {
            dialSeam.listeners.delete(listener);
          };
        },
        connect(): Promise<void> {
          dialSeam.listenersAtConnect = dialSeam.listeners.size;
          return realConnect();
        },
      });
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

vi.stubGlobal('__DEV__', true);

describe('connectionManager relay dial id wiring', () => {
  beforeEach(() => {
    stopConnectionLifecycle();
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    useSettingsStore.setState({
      backgroundNotificationsMode: 'off',
      hasRequestedNotificationPermission: true,
      hydrated: true,
    });
    setNotificationPermissionStatus('granted');
    mockRunBootstrap.mockReset();
    mockRunBootstrap.mockResolvedValue(undefined);
    dialSeam.listeners.clear();
    dialSeam.listenersAtConnect = null;
    useChannelStore.setState({ relayDialId: null });
  });

  afterEach(() => {
    stopConnectionLifecycle();
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useSettingsStore.setState({
      backgroundNotificationsMode: 'off',
      hasRequestedNotificationPermission: false,
      hydrated: false,
    });
    useChannelStore.getState().reset();
    useChannelStore.setState({ relayDialId: null });
  });

  async function establish(): Promise<void> {
    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
  }

  /**
   * Mutation seen failing: deferring the `onDial` subscription in
   * openConnection by a microtask, so it lands after `controller.connect()`
   * has dialed, fails the first assertion (Expected 1, Received 0: the first
   * dial would go unnamed).
   */
  it('subscribes before it dials, and puts each announced dial id in the store', async () => {
    await establish();

    expect(dialSeam.listenersAtConnect).toBe(1);
    expect(dialSeam.listeners.size).toBe(1);

    for (const listener of dialSeam.listeners) listener('0123456789abcdef');
    expect(useChannelStore.getState().relayDialId).toBe('0123456789abcdef');

    for (const listener of dialSeam.listeners) listener('fedcba9876543210');
    expect(useChannelStore.getState().relayDialId).toBe('fedcba9876543210');
  });

  /**
   * Mutation seen failing: deleting `unsubscribeDial();` from
   * teardownThisAttempt fails it (Expected 0 listeners, Received 1).
   */
  it('unsubscribes on teardown, so a closed connection writes no more dial ids', async () => {
    await establish();
    expect(dialSeam.listeners.size).toBe(1);

    stopConnectionLifecycle();

    expect(dialSeam.listeners.size).toBe(0);
  });
});
