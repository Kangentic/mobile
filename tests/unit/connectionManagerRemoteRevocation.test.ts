/**
 * connectionManager's inbound-Final revocation handler: a Final-tagged frame
 * from the desktop is its revoke goodbye (Final is only ever sent on
 * deliberate unpair - see docs/security.md), and the phone must respond by
 * clearing the trust anchor, wiping desktop content, flipping pairedState to
 * 'unpaired', clearing the local push registration, and navigating home -
 * WITHOUT echoing a goodbye of its own back at the desktop that just left.
 *
 * Harness copied from tests/unit/connectionManagerBootstrapRetry.test.ts:
 * mock mode over a real loopback + StubSessionInitiator so the REAL
 * SessionManager establishes and the REAL onRemoteClosed wiring fires. The
 * stub's sendFinalFrame() plays the desktop's BridgeSession.sendGoodbye.
 *
 * Two deliberate assertion choices:
 * - pairedState is recorded as a HISTORY: in mock mode the reopen after the
 *   teardown re-pairs immediately, so 'unpaired' is asserted to have
 *   APPEARED, not to be the final value.
 * - the no-goodbye-echo is asserted by spying on the SENDER
 *   (SessionManager.prototype.sendFinalFrame), never via the stub's
 *   finalFrameCount: LoopbackTransport's close() eats undelivered frames
 *   (loopbackTransport.ts), so a zero count there would false-pass.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionManager } from '@/channel';
import type { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { useSettingsStore } from '@/state/settingsStore';
import { useChannelStore } from '@/state/channelStore';
import { useBoardStore } from '@/state/boardStore';
import { flushMicrotasks, waitUntil } from '../helpers/async';

const mockRunBootstrap = vi.hoisted(() => vi.fn<() => Promise<void>>());
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: mockRunBootstrap }));

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

const mockDeleteItemAsync = vi.hoisted(() => vi.fn(async (_key: string) => undefined));
vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: mockDeleteItemAsync,
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

const mockClearPushRegistration = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/notifications/pushKeys', () => ({ clearPushRegistration: mockClearPushRegistration }));
// The open path lazy-imports pushRegistration (the desktop-key-change reset,
// and the fire-and-forget registration on establish). The REAL module's import
// chain reaches expo-constants, which throws outside a react-native runtime -
// and each test here opens with a fresh random anchor, so from the second test
// on the key-change branch fires. Stubbed inert; this file asserts nothing
// about push registration.
vi.mock('@/notifications/pushRegistration', () => ({
  registerPushWithDesktop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  unregisterPushWithDesktop: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
  resetPushRegistrationProcessState: vi.fn<() => void>(),
}));

const mockRouter = vi.hoisted(() => ({
  canDismiss: vi.fn(() => true),
  dismissAll: vi.fn(),
  navigate: vi.fn(),
  push: vi.fn(),
}));
vi.mock('expo-router', () => ({ router: mockRouter }));

describe('connectionManager remote revocation', () => {
  beforeEach(() => {
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    process.env.EXPO_PUBLIC_KANGENTIC_MOCK = '1';
    useSettingsStore.setState({ backgroundNotificationsMode: 'off' });
    mockRunBootstrap.mockReset();
    mockRunBootstrap.mockResolvedValue(undefined);
    mockDesktopSeam.stub = null;
    mockDeleteItemAsync.mockClear();
    mockClearPushRegistration.mockClear();
    mockRouter.canDismiss.mockClear();
    mockRouter.dismissAll.mockClear();
    mockRouter.navigate.mockClear();
  });

  afterEach(async () => {
    const { stopConnectionLifecycle } = await import('@/connection/connectionManager');
    stopConnectionLifecycle();
    vi.restoreAllMocks();
    delete (globalThis as { __DEV__?: boolean }).__DEV__;
    delete process.env.EXPO_PUBLIC_KANGENTIC_MOCK;
    useChannelStore.getState().reset();
    useChannelStore.setState({ pairedState: 'unknown' });
    useBoardStore.getState().reset();
  });

  it('an inbound Final clears the pairing, wipes content, and navigates home without echoing a goodbye', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    const sendFinalFrameSpy = vi.spyOn(SessionManager.prototype, 'sendFinalFrame');

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established);

    // Content fetched under the pairing, standing in for the whole wipe.
    useBoardStore.setState({ hasHydratedSnapshot: true });
    const pairedStateHistory: string[] = [];
    const unsubscribe = useChannelStore.subscribe((state) => pairedStateHistory.push(state.pairedState));

    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    stub.sendFinalFrame();
    await waitUntil(() => mockRouter.navigate.mock.calls.length === 1);
    unsubscribe();

    expect(pairedStateHistory).toContain('unpaired');
    // All three trust.* keys deleted - the anchor is really gone.
    expect(mockDeleteItemAsync.mock.calls.map((call) => call[0])).toEqual(
      expect.arrayContaining(['trust.desktopStaticPublicKey', 'trust.pairedAt', 'trust.relayAddress']),
    );
    expect(useBoardStore.getState().hasHydratedSnapshot).toBe(false);
    expect(mockClearPushRegistration).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissAll).toHaveBeenCalledTimes(1);
    expect(mockRouter.navigate).toHaveBeenCalledWith('/');
    // 'stay-silent' teardown: the desktop that revoked us gets no goodbye.
    expect(sendFinalFrameSpy).not.toHaveBeenCalled();
  });

  it('still clears the pairing when navigation throws (background revoke)', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    mockRouter.navigate.mockImplementationOnce(() => {
      throw new Error('navigator not mounted');
    });

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established);

    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    stub.sendFinalFrame();
    await waitUntil(() => mockDeleteItemAsync.mock.calls.length >= 3);
    // Let the reopen settle so a swallowed throw cannot hide behind timing.
    await waitUntil(() => useChannelStore.getState().established);

    expect(mockDeleteItemAsync).toHaveBeenCalledTimes(3);
    expect(mockClearPushRegistration).toHaveBeenCalledTimes(1);
  });

  it('skips dismissAll and still navigates home when there is nothing to dismiss', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');
    mockRouter.canDismiss.mockReturnValueOnce(false);

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established);

    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    stub.sendFinalFrame();
    await waitUntil(() => mockRouter.navigate.mock.calls.length === 1);

    expect(mockRouter.dismissAll).not.toHaveBeenCalled();
    expect(mockRouter.navigate).toHaveBeenCalledWith('/');
  });

  it('a Final racing a local teardown does not revoke anything', async () => {
    const { startConnectionLifecycle, stopConnectionLifecycle } = await import('@/connection/connectionManager');

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established);

    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    // The Final is in flight (loopback delivers on a microtask) when the
    // local teardown wins the race synchronously. Whatever the mechanism
    // (the unsubscribe or the handler's controller guard), the revocation
    // must not run against a connection whose fate was already decided.
    stub.sendFinalFrame();
    stopConnectionLifecycle();
    await flushMicrotasks();
    await flushMicrotasks();

    expect(mockDeleteItemAsync).not.toHaveBeenCalled();
    expect(mockRouter.navigate).not.toHaveBeenCalled();
    expect(useChannelStore.getState().pairedState).not.toBe('unpaired');
  });

  it('a second Final does not double-run the teardown', async () => {
    const { startConnectionLifecycle } = await import('@/connection/connectionManager');

    startConnectionLifecycle();
    await waitUntil(() => useChannelStore.getState().established);

    const stub = mockDesktopSeam.stub as StubSessionInitiator;
    stub.sendFinalFrame();
    stub.sendFinalFrame();
    await waitUntil(() => mockRouter.navigate.mock.calls.length >= 1);
    // Give a straggling second handler every chance to (wrongly) run.
    await waitUntil(() => useChannelStore.getState().established);

    expect(mockRouter.navigate).toHaveBeenCalledTimes(1);
    expect(mockRouter.dismissAll).toHaveBeenCalledTimes(1);
    // Exactly one anchor clear: three trust.* keys, once each.
    expect(mockDeleteItemAsync).toHaveBeenCalledTimes(3);
    expect(mockClearPushRegistration).toHaveBeenCalledTimes(1);
  });
});
