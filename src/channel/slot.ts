import { derivePairingSlotId, deriveSessionSlotId } from '@kangentic/protocol';

export type SlotContext =
  | { kind: 'pairing'; pairingToken: Uint8Array }
  | { kind: 'session'; desktopStaticPublicKey: Uint8Array; phoneStaticPublicKey: Uint8Array };

/**
 * Derives the relay slot id both peers dial with (`${relayUrl}?slot=<hex>`).
 * The relay treats the slot as an opaque rendezvous key - it never learns
 * its cryptographic meaning.
 *
 * Both slots are ROUTING LABELS, never key material: the slot rides in a URL
 * query string, the most-logged part of a request, so anything secret placed
 * here is published to every hop that can read a request URI.
 *
 * Pairing slot: the canonical derivation is the protocol package's
 * `derivePairingSlotId(pairingToken)` (a BLAKE2s-labeled 16-byte key, 32 hex
 * characters), matching the desktop's `startPairing()` byte-for-byte. Earlier
 * builds dialed `bytesToHex(pairingToken)` - the token WAS the slot - which
 * published the Noise IKpsk0 pre-shared key in cleartext, since the same token
 * is the PSK. The token now never leaves the QR code. Peers that derive this
 * differently never meet, which is why the change rode a PROTOCOL_VERSION bump:
 * `validateScannedQr` rejects a mismatched version before anything dials.
 *
 * Session slot: the canonical derivation is the protocol package's
 * `deriveSessionSlotId(desktopStaticPublicKey, phoneStaticPublicKey)` (also a
 * BLAKE2s-labeled 16-byte key), matching the desktop's `openSessionForDevice()`
 * byte-for-byte. Phase 1 shipped a hex-of-the-desktop-key candidate here before
 * the desktop defined the contract; that candidate never matched and is gone.
 */
export function deriveSlotId(context: SlotContext): string {
  switch (context.kind) {
    case 'pairing':
      return derivePairingSlotId(context.pairingToken);
    case 'session':
      return deriveSessionSlotId(context.desktopStaticPublicKey, context.phoneStaticPublicKey);
  }
}
