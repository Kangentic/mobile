import { hexToBytes, type X25519KeyPair } from '@kangentic/protocol';

/**
 * The dev rig's instant-pairing "hot path" (live mode): instead of the
 * QR/SAS ceremony, the rig exchanges public keys with the developer's
 * local desktop instance through the desktop repo's gitignored
 * `.kangentic/mobile-dev-pairing/` directory, the desktop (dev builds
 * only) adopts the rig's phone key into its signed roster, and the rig
 * hands this app the matching identity + pinned desktop key via
 * EXPO_PUBLIC_KANGENTIC_DEV_PAIRING, inlined at bundle time as
 * `<desktopPubHex>,<phoneSecretHex>,<phonePubHex>,<relayUrl>`.
 *
 * Dev builds only: the variable never exists in a production bundle and
 * the __DEV__ guard removes this code path from release JS regardless.
 * The QR/SAS ceremony stays the one and only pairing path for real
 * devices; this module never touches the SecureStore trust anchor, so
 * manual-pairing testing (dev:pair, no env) is unaffected.
 */
export interface DevPairing {
  identity: X25519KeyPair;
  desktopStaticPublicKey: Uint8Array;
  relayAddress: string;
}

const HEX_64 = /^[0-9a-f]{64}$/;

export function getDevPairing(): DevPairing | null {
  if (!__DEV__) return null;
  const encoded = process.env.EXPO_PUBLIC_KANGENTIC_DEV_PAIRING;
  if (!encoded) return null;
  const [desktopPublicHex, phoneSecretHex, phonePublicHex, ...relayParts] = encoded.split(',');
  const relayAddress = relayParts.join(',');
  if (!HEX_64.test(desktopPublicHex ?? '') || !HEX_64.test(phoneSecretHex ?? '') || !HEX_64.test(phonePublicHex ?? '') || relayAddress.length === 0) {
    console.warn('[devPairing] EXPO_PUBLIC_KANGENTIC_DEV_PAIRING is malformed; falling back to the normal pairing flow');
    return null;
  }
  return {
    identity: { secretKey: hexToBytes(phoneSecretHex), publicKey: hexToBytes(phonePublicHex) },
    desktopStaticPublicKey: hexToBytes(desktopPublicHex),
    relayAddress,
  };
}
