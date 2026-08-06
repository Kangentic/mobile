/**
 * Both relay slots must byte-match what the desktop dials (startPairing ->
 * derivePairingSlotId, openSessionForDevice -> deriveSessionSlotId), or the two
 * sides never rendezvous. Phase 1 shipped a hex-of-the-desktop-key candidate
 * that did NOT match; this locks both mobile derivations to the protocol
 * package's canonical exports so neither can drift locally again.
 */
import { describe, expect, it } from 'vitest';
import { bytesToHex, derivePairingSlotId, deriveSessionSlotId, generateX25519KeyPair } from '@kangentic/protocol';
import { deriveSlotId } from '@/channel/slot';

describe('deriveSlotId', () => {
  it('pairing slot byte-matches the protocol package derivation the desktop dials', () => {
    const pairingToken = new Uint8Array(32).fill(7);
    const slotId = deriveSlotId({ kind: 'pairing', pairingToken });

    expect(slotId).toBe(derivePairingSlotId(pairingToken));
    // The labeled derivation is 16 bytes -> 32 hex chars, and is NOT the raw
    // token: the token is the Noise PSK, and the slot travels in cleartext in
    // the relay URL, so dialing the token verbatim would publish the PSK.
    expect(slotId).toHaveLength(32);
    expect(slotId).not.toBe(bytesToHex(pairingToken));
  });

  it('session slot byte-matches the protocol package derivation the desktop dials', () => {
    const desktopIdentity = generateX25519KeyPair();
    const phoneIdentity = generateX25519KeyPair();

    const slotId = deriveSlotId({
      kind: 'session',
      desktopStaticPublicKey: desktopIdentity.publicKey,
      phoneStaticPublicKey: phoneIdentity.publicKey,
    });

    expect(slotId).toBe(deriveSessionSlotId(desktopIdentity.publicKey, phoneIdentity.publicKey));
    // The labeled derivation is 16 bytes -> 32 hex chars, and is NOT the raw desktop key.
    expect(slotId).toHaveLength(32);
    expect(slotId).not.toBe(bytesToHex(desktopIdentity.publicKey));
  });

  it('session slot is asymmetric in key order (desktop-first is the contract)', () => {
    const desktopIdentity = generateX25519KeyPair();
    const phoneIdentity = generateX25519KeyPair();
    const forward = deriveSessionSlotId(desktopIdentity.publicKey, phoneIdentity.publicKey);
    const reversed = deriveSessionSlotId(phoneIdentity.publicKey, desktopIdentity.publicKey);
    expect(forward).not.toBe(reversed);
  });
});
