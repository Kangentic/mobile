/**
 * The session relay slot must byte-match what the desktop dials
 * (openSessionForDevice -> deriveSessionSlotId), or the two sides never
 * rendezvous. Phase 1 shipped a hex-of-the-desktop-key candidate that did
 * NOT match; this locks the mobile derivation to the protocol package's
 * canonical export so it can never drift locally again.
 */
import { describe, expect, it } from 'vitest';
import { bytesToHex, deriveSessionSlotId, generateX25519KeyPair } from '@kangentic/protocol';
import { deriveSlotId } from '@/channel/slot';

describe('deriveSlotId', () => {
  it('pairing slot is the hex of the pairing token itself', () => {
    const pairingToken = new Uint8Array(32).fill(7);
    expect(deriveSlotId({ kind: 'pairing', pairingToken })).toBe(bytesToHex(pairingToken));
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
