import { bytesToHex } from '@kangentic/protocol';

export type SlotContext =
  | { kind: 'pairing'; pairingToken: Uint8Array }
  | { kind: 'session'; desktopStaticPublicKey: Uint8Array };

/**
 * Derives the 64-hex-character relay slot id both peers dial with
 * (`${relayUrl}?slot=<hex>`). The relay treats the slot as an opaque
 * rendezvous key - it never learns its cryptographic meaning.
 *
 * Pairing slot: confirmed to byte-match the desktop
 * (src/main/mobile-bridge/mobile-bridge-service.ts's `startPairing()`:
 * `const slotId = bytesToHex(token.token)`) - the pairing token IS the
 * slot, already exactly 32 bytes.
 *
 * Session slot: NOT YET DEFINED by the desktop (its ongoing-session
 * connect is Bridge Phase 2 - see BridgeSession, which is constructed with
 * an already-connected Transport rather than owning slot derivation
 * itself). This is a documented candidate, not a confirmed contract: the
 * desktop's static public key is already 32 bytes, already known to both
 * sides (the phone has it pinned in its trust anchor; the desktop is the
 * one publishing it), and needs no hash function to compress into a slot
 * id (the package does not export one - see crypto/primitives.ts's
 * unexported hashBlake2s). File the canonical derivation as a follow-up
 * against @kangentic/protocol once Bridge Phase 2 lands, so both sides are
 * guaranteed to match byte-for-byte rather than by convention.
 */
export function deriveSlotId(context: SlotContext): string {
  switch (context.kind) {
    case 'pairing':
      return bytesToHex(context.pairingToken);
    case 'session':
      return bytesToHex(context.desktopStaticPublicKey);
  }
}
