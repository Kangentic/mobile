/**
 * src/pairing/activePairing.ts's beginPairing() is the ONLY production call
 * site that turns a scanned QR payload into a relay slot
 * (`deriveSlotId({ kind: 'pairing', pairingToken: payload.pairingToken })`).
 * slotParity.test.ts locks the derivation function itself; nothing locked
 * that beginPairing threads the right 32-byte field into it. Reading the
 * WRONG field (e.g. the desktop's static public key, also 32 bytes, sitting
 * right next to pairingToken on the same payload) would type-check, compile,
 * and pass slotParity.test.ts unchanged, while producing a slot the desktop
 * never dials - a silent, permanent never-rendezvous with no error anywhere.
 *
 * RelayTransport is mocked so this stays a unit test: beginPairing's
 * PairingMachine.start() calls transport.connect(), and the fake rejects
 * immediately rather than opening a real socket, matching "never hit a real
 * relay" outside the E2E tier.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { derivePairingSlotId, generateX25519KeyPair, PROTOCOL_VERSION, randomBytes, type PairingQrPayload } from '@kangentic/protocol';
import { beginPairing, resetActivePairing } from '@/pairing/activePairing';
import { usePairingStore } from '@/state/pairingStore';

const relayTransportMocks = vi.hoisted(() => ({
  constructedWith: [] as { relayUrl: string; slotId: string }[],
}));

vi.mock('@/channel/relayTransport', () => {
  class FakeRelayTransport {
    readonly state = 'idle';
    constructor(options: { relayUrl: string; slotId: string }) {
      relayTransportMocks.constructedWith.push(options);
    }
    connect(): Promise<void> {
      // No real relay in a unit test: PairingMachine.start() catches this and
      // settles into its own 'error' state, so beginPairing's await resolves
      // without ever opening a socket.
      return Promise.reject(new Error('FakeRelayTransport: no real relay in a unit test'));
    }
    send(): void {}
    close(): void {}
    onFrame(): () => void {
      return () => {};
    }
    onStateChange(): () => void {
      return () => {};
    }
  }
  return { RelayTransport: FakeRelayTransport };
});

const secureStoreMocks = vi.hoisted(() => ({
  getItemAsync: vi.fn<(key: string) => Promise<string | null>>(async () => null),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStoreMocks.getItemAsync,
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'whenUnlockedThisDeviceOnly',
}));

function buildPayload(overrides: Partial<PairingQrPayload> = {}): PairingQrPayload {
  return {
    desktopStaticPublicKey: generateX25519KeyPair().publicKey,
    pairingToken: randomBytes(32),
    relayAddress: 'wss://relay.example.test',
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    protocolVersion: PROTOCOL_VERSION,
    ...overrides,
  };
}

describe('beginPairing', () => {
  afterEach(() => {
    resetActivePairing();
    usePairingStore.getState().reset();
    relayTransportMocks.constructedWith.length = 0;
  });

  it('derives the relay slot from the payload pairing token, byte-matching the protocol package', async () => {
    const payload = buildPayload();

    await beginPairing(payload, 'Test Device');

    expect(relayTransportMocks.constructedWith).toHaveLength(1);
    const { relayUrl, slotId } = relayTransportMocks.constructedWith[0];
    expect(relayUrl).toBe(payload.relayAddress);
    expect(slotId).toBe(derivePairingSlotId(payload.pairingToken));
  });

  /**
   * The discriminating case: pairingToken and desktopStaticPublicKey are both
   * 32-byte Uint8Arrays on the same payload, so a wiring mistake that reads
   * the wrong field is a real, easy-to-make mistake, not a hypothetical one.
   * Asserting only equality with derivePairingSlotId(payload.pairingToken)
   * above would not catch it, since a consistently-wrong field would still
   * "byte-match the protocol package" for whatever it derived from - it
   * would just be deriving from the wrong 32 bytes. This proves the actual
   * pairing token was the input, by showing it produces a DIFFERENT slot
   * than the desktop key does.
   */
  it('is not the slot for the desktop static public key (the field beside it on the same payload)', async () => {
    const payload = buildPayload();

    await beginPairing(payload, 'Test Device');

    const { slotId } = relayTransportMocks.constructedWith[0];
    expect(slotId).not.toBe(derivePairingSlotId(payload.desktopStaticPublicKey));
  });

  it('produces a different slot for a different pairing token, on an otherwise identical payload', async () => {
    const firstPayload = buildPayload({ pairingToken: randomBytes(32) });
    await beginPairing(firstPayload, 'Test Device');
    const firstSlotId = relayTransportMocks.constructedWith[0].slotId;

    resetActivePairing();
    relayTransportMocks.constructedWith.length = 0;

    const secondPayload = buildPayload({ ...firstPayload, pairingToken: randomBytes(32) });
    await beginPairing(secondPayload, 'Test Device');
    const secondSlotId = relayTransportMocks.constructedWith[0].slotId;

    expect(firstSlotId).not.toBe(secondSlotId);
  });
});
