/**
 * actions.ts's unpairLocally: the local half of unpairing, shared by the
 * Devices screen ('announce-departure') and the remote-revocation handler
 * ('stay-silent'). Pins the order - anchor clear, then content wipe, then
 * reconnect - and that the caller's intent reaches reconnectNow verbatim.
 * The order matters: a reconnect BEFORE the anchor clear would reopen
 * against the old desktop, and a wipe after it would race fresh content in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useBoardStore } from '@/state/boardStore';

const eventLog = vi.hoisted(() => [] as string[]);

const mockReconnectNow = vi.hoisted(() =>
  vi.fn((intent?: string) => {
    eventLog.push(`reconnect:${intent ?? 'default'}`);
  }),
);
vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection: vi.fn(() => null),
  reconnectNow: mockReconnectNow,
  requireSubscriptions: vi.fn(),
  requireVerbClient: vi.fn(),
}));

vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async (key: string) => {
    eventLog.push(`anchor-delete:${key}`);
  }),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

describe('unpairLocally', () => {
  beforeEach(() => {
    eventLog.length = 0;
    mockReconnectNow.mockClear();
  });

  afterEach(() => {
    useBoardStore.getState().reset();
  });

  it('clears the anchor, then wipes content, then reconnects with the given intent', async () => {
    const { unpairLocally } = await import('@/connection/actions');
    useBoardStore.setState({ hasHydratedSnapshot: true });
    const unsubscribe = useBoardStore.subscribe((state, previousState) => {
      if (previousState.hasHydratedSnapshot && !state.hasHydratedSnapshot) eventLog.push('board-reset');
    });

    await unpairLocally('announce-departure');
    unsubscribe();

    expect(eventLog).toEqual([
      'anchor-delete:trust.desktopStaticPublicKey',
      'anchor-delete:trust.relayAddress',
      'anchor-delete:trust.pairedAt',
      'board-reset',
      'reconnect:announce-departure',
    ]);
  });

  it('passes the stay-silent intent through verbatim', async () => {
    const { unpairLocally } = await import('@/connection/actions');

    await unpairLocally('stay-silent');

    expect(mockReconnectNow).toHaveBeenCalledTimes(1);
    expect(mockReconnectNow).toHaveBeenCalledWith('stay-silent');
  });

  /**
   * A locked Keystore rejecting the anchor delete must not skip the wipe or
   * the teardown: on a remote revocation, content fetched under the revoked
   * trust would otherwise survive on a phone whose UI says unpaired. The
   * rejection still rethrows so DevicesScreen's error surface works.
   */
  it('still wipes and reconnects when the anchor clear rejects, and rethrows', async () => {
    const { unpairLocally } = await import('@/connection/actions');
    const secureStore = await import('expo-secure-store');
    vi.mocked(secureStore.deleteItemAsync).mockRejectedValueOnce(new Error('Keystore is locked'));
    useBoardStore.setState({ hasHydratedSnapshot: true });

    await expect(unpairLocally('stay-silent')).rejects.toThrow('Keystore is locked');

    expect(useBoardStore.getState().hasHydratedSnapshot).toBe(false);
    expect(mockReconnectNow).toHaveBeenCalledWith('stay-silent');
  });
});
