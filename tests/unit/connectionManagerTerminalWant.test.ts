/**
 * The black-terminal regression, end to end through the real lifecycle.
 *
 * A session screen asks the desktop for live PTY bytes. That "want" used to
 * live as a Set on the connection's SubscriptionManager, and the manager is
 * rebuilt on every connection, so:
 *
 * - a screen that stayed MOUNTED across a teardown and rebuild (every iOS
 *   background, Android push-only or off mode, the five-minute keepalive
 *   ceiling) was re-subscribed list-only by the new manager, and its mirror
 *   froze or, on a fresh page, went black with nothing to repaint from;
 * - a screen opened BEFORE any connection existed (a cold-launch notification
 *   tap) recorded nothing at all, through `connection?.`, so the connection
 *   that came up next subscribed it list-only from the start.
 *
 * The want now lives in terminalFeed's retention, outside every connection,
 * and each manager reads it at subscribe time. Both cases below were red on
 * the unfixed code with no mutation: the read-stream subscribe after the
 * rebuild carried `terminal: false`. Mutation that reddens them now: wire
 * `isTerminalWanted: () => false` in connectionManager.
 *
 * Harness lifted from connectionManagerKeepalive.test.ts: a REAL Noise KK
 * handshake over the loopback transport against StubSessionInitiator, through
 * the mock-desktop seam. runBootstrap is mocked, so nothing declares the
 * desired stream set; the test does that by hand after each establish, which
 * is what the first board snapshot's reconcile would do.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppState, type AppStateStatus } from 'react-native';
import type { CapabilityRequestMessage, CapabilityResponseMessage, JsonValue } from '@kangentic/protocol';
import type { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { useSettingsStore } from '@/state/settingsStore';
import { useChannelStore } from '@/state/channelStore';
import { useActivityStore } from '@/state/activityStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { resetTerminalFeed } from '@/state/terminalFeed';
import { waitUntil } from '../helpers/async';

const mockRunBootstrap = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: mockRunBootstrap }));

const pushRegistrationMocks = vi.hoisted(() => ({
  registerPushWithDesktop: vi.fn(async () => undefined),
  unregisterPushWithDesktop: vi.fn(async () => undefined),
  resetPushRegistrationProcessState: vi.fn(),
}));
vi.mock('@/notifications/pushRegistration', () => pushRegistrationMocks);

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

vi.mock('@/observability/crashReporting', () => ({ reportHandledError: vi.fn() }));

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

const SESSION_ID = 'sess-held';

/**
 * Records every request the CURRENT stub desktop receives and answers a
 * read-stream subscribe with a snapshot. Anything else (the open's
 * transcript-window read, push registration) is refused, which the app treats
 * as a best-effort failure.
 */
function recordRequests(stub: StubSessionInitiator): CapabilityRequestMessage[] {
  const requests: CapabilityRequestMessage[] = [];
  stub.setRequestHandler((request): CapabilityResponseMessage => {
    requests.push(request);
    const payload = request.payload as { action?: string };
    if (request.verb === 'read-stream' && payload.action === 'subscribe') {
      return { type: 'capability-response', requestId: request.requestId, ok: true, payload: streamSnapshotFixture() as unknown as JsonValue };
    }
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'not part of this test' };
  });
  return requests;
}

function streamSubscribesFor(requests: CapabilityRequestMessage[], sessionId: string): { terminal?: boolean }[] {
  return requests
    .filter((request) => request.verb === 'read-stream')
    .map((request) => request.payload as { sessionId?: string; action?: string; terminal?: boolean })
    .filter((payload) => payload.action === 'subscribe' && payload.sessionId === sessionId);
}

function currentStub(): StubSessionInitiator {
  const stub = mockDesktopSeam.stub as StubSessionInitiator | null;
  if (!stub) throw new Error('expected the mock desktop to have built a stub');
  return stub;
}

async function startAndEstablish(): Promise<(status: AppStateStatus) => void> {
  const { startConnectionLifecycle } = await import('@/connection/connectionManager');
  startConnectionLifecycle();
  await waitUntil(() => useChannelStore.getState().established, { label: 'session established' });
  const onAppStateChange = vi.mocked(AppState.addEventListener).mock.calls.at(-1)?.[1];
  if (!onAppStateChange) throw new Error('expected an AppState change handler to be registered');
  return onAppStateChange;
}

/** What the first board snapshot's reconcile does: declare the live session desired. */
async function desireHeldSession(): Promise<void> {
  const { getActiveConnection } = await import('@/connection/connectionManager');
  const connection = getActiveConnection();
  if (!connection) throw new Error('expected an active connection');
  connection.subscriptions.setDesiredStreams(new Set([SESSION_ID]));
}

describe('a mounted session screen across a connection rebuild', () => {
  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    // 'off' takes the closeConnection() branch on background: the teardown
    // and rebuild this regression lives on.
    useSettingsStore.setState({ backgroundNotificationsMode: 'off', hasRequestedNotificationPermission: true, hydrated: true });
    mockRunBootstrap.mockReset();
    mockRunBootstrap.mockResolvedValue(undefined);
    mockDesktopSeam.stub = null;
    resetTerminalFeed();
    useActivityStore.getState().reset();
    useTranscriptStore.getState().reset();
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    stopConnectionLifecycle();
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useSettingsStore.setState({ backgroundNotificationsMode: 'off', hasRequestedNotificationPermission: false, hydrated: false });
    useChannelStore.getState().reset();
    resetTerminalFeed();
  });

  it('keeps asking for live PTY bytes after the connection is torn down and rebuilt', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const { openSessionScreen } = await import('@/connection/actions');
    const onAppStateChange = await startAndEstablish();
    const firstRequests = recordRequests(currentStub());
    openSessionScreen(SESSION_ID);
    await desireHeldSession();
    await waitUntil(() => streamSubscribesFor(firstRequests, SESSION_ID).length > 0, { label: 'first subscribe' });
    expect(streamSubscribesFor(firstRequests, SESSION_ID).at(-1)?.terminal).toBe(true);

    // Background in 'off' mode: the connection, and its manager, are gone.
    const firstStub = currentStub();
    onAppStateChange('background');
    expect(getActiveConnection()).toBeNull();

    // Foreground: a NEW connection and a NEW manager. The screen never
    // unmounted, so nothing re-ran openSessionScreen.
    onAppStateChange('active');
    await waitUntil(() => useChannelStore.getState().established && mockDesktopSeam.stub !== firstStub, {
      label: 'the rebuilt session established',
    });
    const rebuiltRequests = recordRequests(currentStub());
    await desireHeldSession();
    await waitUntil(() => streamSubscribesFor(rebuiltRequests, SESSION_ID).length > 0, { label: 'rebuilt subscribe' });

    expect(streamSubscribesFor(rebuiltRequests, SESSION_ID).at(-1)?.terminal).toBe(true);
  });

  it('asks for live PTY bytes for a screen opened before any connection existed', async () => {
    const { getActiveConnection } = await import('@/connection/connectionManager');
    const { openSessionScreen } = await import('@/connection/actions');
    // The cold-launch notification tap: the screen opens first.
    expect(getActiveConnection()).toBeNull();
    openSessionScreen(SESSION_ID);

    await startAndEstablish();
    const requests = recordRequests(currentStub());
    await desireHeldSession();
    await waitUntil(() => streamSubscribesFor(requests, SESSION_ID).length > 0, { label: 'first subscribe' });

    expect(streamSubscribesFor(requests, SESSION_ID).at(-1)?.terminal).toBe(true);
  });
});
