/**
 * The reviewer/demo pairing ceremony, end to end, plus the isolation invariant
 * that keeps it safe to ship.
 *
 * Two things are being proved here, and the second is the one that matters for
 * anything that could go wrong in the field:
 *
 *  1. It is a REAL Noise IKpsk0 pairing. The SAS the confirm screen shows is
 *     derived from a genuine transcript hash and matches what the responder
 *     independently derived, and the trust anchor written on confirm is a
 *     genuine anchor. If this ever silently degraded into a fake, the app would
 *     be showing a reviewer a security screen that verifies nothing.
 *  2. It NEVER touches the network. No RelayTransport is constructed anywhere
 *     in the flow. This is the guarantee that a demo code, which by design ships
 *     in production and is refused by nothing, cannot put a stranger's phone on
 *     Kangentic's relay.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bytesToHex } from '@kangentic/protocol';

import { confirmActivePairing, resetActivePairing } from '@/pairing/activePairing';
import type { PairingMachineState } from '@/pairing/pairingMachine';
import { TrustAnchorStore } from '@/pairing/trustAnchor';
import { usePairingStore } from '@/state/pairingStore';
import { DEMO_DESKTOP_STATIC, DEMO_RELAY_ADDRESS, isDemoAnchor } from '@/demo/demoIdentity';
import { waitUntil } from '../helpers/async';

/**
 * Counts constructions rather than stubbing behaviour. If the demo ever routes
 * through here the count is non-zero and every test below says so, which is a
 * far more legible failure than a socket error from deep inside a handshake.
 */
const relayTransportMocks = vi.hoisted(() => ({ constructions: 0 }));

vi.mock('@/channel/relayTransport', () => {
  class FakeRelayTransport {
    readonly state = 'idle';
    constructor() {
      relayTransportMocks.constructions += 1;
    }
    connect(): Promise<void> {
      return Promise.reject(new Error('FakeRelayTransport: the demo must never reach a relay'));
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

/** An in-memory Keychain, so the anchor round-trips the way it does on a device. */
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

// Imported after the mocks so the module graph picks them up.
const { activeResponderForTest, AlreadyPairedError, beginDemoPairing, PairingInProgressError } = await import(
  '@/demo/demoPairing'
);

const trustAnchorStore = new TrustAnchorStore();

beforeEach(() => {
  secureStoreMocks.items.clear();
  relayTransportMocks.constructions = 0;
});

afterEach(() => {
  resetActivePairing();
  usePairingStore.getState().reset();
});

describe('beginDemoPairing', () => {
  it('refuses when a REAL pairing ceremony is mid-flight, rather than swapping the SAS out from under the user', async () => {
    // The precondition realCeremonyInFlight actually depends on: no demo
    // responder of its own is active. Asserted explicitly rather than relied
    // on implicitly, because this is the first test in the file to touch
    // demoPairing's module state - a later reorder that ran this after
    // another beginDemoPairing call would otherwise fail confusingly on the
    // rejects assertion below instead of failing here, on its real cause.
    expect(activeResponderForTest()).toBeNull();

    const inFlightState: PairingMachineState = {
      status: 'awaiting-sas',
      sas: { digits: '246813', emoji: ['🐙', '🌵', '🚀', '🍉', '🎈'] },
    };
    usePairingStore.getState().setMachineState(inFlightState);

    await expect(beginDemoPairing('Kangentic Mobile')).rejects.toBeInstanceOf(PairingInProgressError);

    // The real ceremony's SAS survives untouched - nothing swapped it out
    // from under a user staring at that confirm screen.
    expect(usePairingStore.getState().machineState).toEqual(inFlightState);
  });

  it('runs a real handshake to awaiting-sas', async () => {
    await beginDemoPairing('Kangentic Mobile');
    await waitUntil(() => usePairingStore.getState().machineState?.status === 'awaiting-sas', {
      label: 'demo ceremony reaches awaiting-sas',
    });

    const state = usePairingStore.getState().machineState;
    expect(state?.status).toBe('awaiting-sas');
    if (state?.status !== 'awaiting-sas') return;
    // A real SAS, not a placeholder: digits derived from the completed
    // transcript hash. Asserting shape rather than a fixed value, because the
    // value depends on the ephemeral keys the handshake generates.
    expect(state.sas.digits).toMatch(/^\d+$/);
    expect(state.sas.digits.length).toBeGreaterThan(0);

    // THE responder derived its own SAS independently, from its own side of
    // the completed transcript hash. The phone's displayed digits must equal
    // the responder's, or the confirm screen would be showing a SAS that
    // verifies nothing - a hardcoded '000000' on the phone side would satisfy
    // the shape assertion above but fail this one.
    const responder = activeResponderForTest();
    expect(responder).not.toBeNull();
    const responderSas = responder?.getSas();
    expect(responderSas).not.toBeNull();
    expect(state.sas.digits).toBe(responderSas?.digits);
  });

  it('never constructs a RelayTransport', async () => {
    await beginDemoPairing('Kangentic Mobile');
    await waitUntil(() => usePairingStore.getState().machineState?.status === 'awaiting-sas');

    expect(relayTransportMocks.constructions).toBe(0);
  });

  it('writes an anchor the connection manager recognises as the demo', async () => {
    await beginDemoPairing('Kangentic Mobile');
    await waitUntil(() => usePairingStore.getState().machineState?.status === 'awaiting-sas');

    await confirmActivePairing();

    const anchor = await trustAnchorStore.load();
    expect(anchor).not.toBeNull();
    if (!anchor) return;
    expect(isDemoAnchor(anchor)).toBe(true);
    expect(bytesToHex(anchor.desktopStaticPublicKey)).toBe(bytesToHex(DEMO_DESKTOP_STATIC.publicKey));
    expect(anchor.relayAddress).toBe(DEMO_RELAY_ADDRESS);
    // Still no relay, even after the confirm frame has been sent.
    expect(relayTransportMocks.constructions).toBe(0);
  });

  it('reaches paired after confirm, so the ceremony completes on both sides', async () => {
    await beginDemoPairing('Kangentic Mobile');
    await waitUntil(() => usePairingStore.getState().machineState?.status === 'awaiting-sas');

    await confirmActivePairing();

    // confirm() seals a frame under the handshake's own transport keys, and the
    // responder only opens it if both sides ran the same transcript. Reaching
    // 'paired' therefore means the desktop half accepted us, not merely that
    // the phone half stopped waiting.
    expect(usePairingStore.getState().machineState?.status).toBe('paired');
  });

  it('refuses when the phone is already paired, rather than clobbering the anchor', async () => {
    const realDesktopKey = new Uint8Array(32).fill(7);
    await trustAnchorStore.save({
      desktopStaticPublicKey: realDesktopKey,
      relayAddress: 'wss://relay.example.com',
      pairedAt: new Date().toISOString(),
    });

    await expect(beginDemoPairing('Kangentic Mobile')).rejects.toBeInstanceOf(AlreadyPairedError);

    // The real pairing survives untouched. A demo code arriving by deep link on
    // a working phone must not be able to replace someone's desktop with
    // fixtures.
    const anchor = await trustAnchorStore.load();
    expect(anchor).not.toBeNull();
    if (!anchor) return;
    expect(bytesToHex(anchor.desktopStaticPublicKey)).toBe(bytesToHex(realDesktopKey));
    expect(isDemoAnchor(anchor)).toBe(false);
  });
});
