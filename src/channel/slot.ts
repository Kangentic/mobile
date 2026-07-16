import { bytesToHex, deriveSessionSlotId } from '@kangentic/protocol';

export type SlotContext =
  | { kind: 'pairing'; pairingToken: Uint8Array }
  | { kind: 'session'; desktopStaticPublicKey: Uint8Array; phoneStaticPublicKey: Uint8Array };

/**
 * Derives the relay slot id both peers dial with (`${relayUrl}?slot=<hex>`).
 * The relay treats the slot as an opaque rendezvous key - it never learns
 * its cryptographic meaning.
 *
 * Pairing slot: confirmed to byte-match the desktop
 * (src/main/mobile-bridge/mobile-bridge-service.ts's `startPairing()`:
 * `const slotId = bytesToHex(token.token)`) - the pairing token IS the
 * slot, already exactly 32 bytes (64 hex characters).
 *
 * Session slot: the canonical derivation is the protocol package's
 * `deriveSessionSlotId(desktopStaticPublicKey, phoneStaticPublicKey)` (a
 * BLAKE2s-labeled 16-byte key, 32 hex characters), matching the desktop's
 * `openSessionForDevice()` byte-for-byte. Phase 1 shipped a hex-of-the-
 * desktop-key candidate here before the desktop defined the contract; that
 * candidate never matched and is gone.
 */
export function deriveSlotId(context: SlotContext): string {
  switch (context.kind) {
    case 'pairing':
      return bytesToHex(context.pairingToken);
    case 'session':
      return deriveSessionSlotId(context.desktopStaticPublicKey, context.phoneStaticPublicKey);
  }
}
