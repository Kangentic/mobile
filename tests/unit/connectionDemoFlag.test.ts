/**
 * The demo flag the connection hands to runBootstrap (protocol 0.30.0's push
 * repair must never run for the demo's in-process desktop, which has to stay
 * networkless). Only connectionManager knows a connection is the demo, so the
 * flag has two carriers and both are pinned here against a demo trust anchor:
 * the `demoConnection` field of the active connection, and the options object
 * runBootstrap receives, both on an open (runBootstrapWithRetry) and on
 * refreshSnapshots (pull-to-refresh).
 *
 * runBootstrap is mocked, which is why this is not demoConnection.test.ts: that
 * file needs the real bootstrap to populate the board. The normal-connection
 * half (`demoConnection: false`) is in connectionManagerBootstrapRetry.test.ts.
 *
 * Mutations seen failing:
 * - `{ demoConnection: false }` hard-coded at connectionManager's runBootstrap call;
 * - `demoConnection: false` hard-coded in the activeConnection object;
 * - `{ demoConnection: false }` hard-coded in actions.ts refreshSnapshots.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@kangentic/protocol';

import { getActiveConnection, startConnectionLifecycle, stopConnectionLifecycle } from '@/connection/connectionManager';
import { refreshSnapshots } from '@/connection/actions';
import { DEMO_DESKTOP_STATIC, DEMO_RELAY_ADDRESS } from '@/demo/demoIdentity';
import { useChannelStore } from '@/state/channelStore';
import { waitUntil } from '../helpers/async';

const mockRunBootstrap = vi.hoisted(() => vi.fn<(...bootstrapArguments: unknown[]) => Promise<void>>());
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: mockRunBootstrap }));

vi.mock('@/notifications/pushRegistration', () => ({
  unregisterPushWithDesktop: vi.fn(async () => undefined),
  registerPushWithDesktop: vi.fn(async () => undefined),
  resetPushRegistrationProcessState: vi.fn(),
}));
vi.mock('@/notifications/pushKeys', () => ({ clearPushRegistration: vi.fn(async () => undefined) }));
vi.mock('@/notifications/channels', () => ({
  refreshNotificationPermission: vi.fn(async () => undefined),
  requestNotificationPermission: vi.fn(async () => undefined),
}));
vi.mock('@/observability/crashReporting', () => ({ reportHandledError: vi.fn() }));

vi.mock('react-native', () => ({
  AppState: { currentState: 'active', addEventListener: vi.fn(() => ({ remove: vi.fn() })) },
  Platform: { OS: 'android' },
}));

const secureStoreMocks = vi.hoisted(() => ({ items: new Map<string, string>() }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async (key: string) => secureStoreMocks.items.get(key) ?? null),
  setItemAsync: vi.fn(async (key: string, value: string) => {
    secureStoreMocks.items.set(key, value);
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    secureStoreMocks.items.delete(key);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

// Production-shaped, as in demoConnection.test.ts: the demo branch is the one
// that ships.
vi.stubGlobal('__DEV__', false);

function writeDemoAnchor(): void {
  secureStoreMocks.items.set('trust.desktopStaticPublicKey', bytesToHex(DEMO_DESKTOP_STATIC.publicKey));
  secureStoreMocks.items.set('trust.relayAddress', DEMO_RELAY_ADDRESS);
  secureStoreMocks.items.set('trust.pairedAt', '2026-08-25T12:00:00.000Z');
}

beforeEach(() => {
  secureStoreMocks.items.clear();
  mockRunBootstrap.mockReset();
  mockRunBootstrap.mockResolvedValue(undefined);
  useChannelStore.getState().reset();
  useChannelStore.getState().setPairedState('unknown');
});

afterEach(() => {
  stopConnectionLifecycle();
});

describe('a demo trust anchor marks its connection as the demo', () => {
  it('records demoConnection on the active connection and passes it to the open bootstrap', async () => {
    writeDemoAnchor();

    startConnectionLifecycle();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 1, { label: 'the open bootstrap runs', timeoutMs: 5000 });

    expect(getActiveConnection()?.demoConnection).toBe(true);
    expect(mockRunBootstrap.mock.calls[0][2]).toEqual({ demoConnection: true });
  });

  it('refreshSnapshots re-runs the bootstrap with the connection\'s own flag', async () => {
    writeDemoAnchor();
    startConnectionLifecycle();
    await waitUntil(() => mockRunBootstrap.mock.calls.length === 1, { label: 'the open bootstrap runs', timeoutMs: 5000 });
    await waitUntil(() => useChannelStore.getState().established, { label: 'demo session establishes', timeoutMs: 5000 });

    await refreshSnapshots();

    expect(mockRunBootstrap).toHaveBeenCalledTimes(2);
    expect(mockRunBootstrap.mock.calls[1][2]).toEqual({ demoConnection: true });
  });
});
