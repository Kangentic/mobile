import { decodePairingQrPayload, PROTOCOL_VERSION, type PairingQrPayload } from '@kangentic/protocol';

export type QrValidationErrorKind = 'not-a-pairing-uri' | 'malformed' | 'expired' | 'version-incompatible' | 'insecure-relay';

export type QrValidationResult =
  | { ok: true; payload: PairingQrPayload }
  | { ok: false; errorKind: QrValidationErrorKind };

/** Loopback hosts permitted over plaintext `ws://` for a local dev relay (see scripts/stubDesktopPeer.mjs). */
const LOOPBACK_WS_PREFIXES = ['ws://localhost', 'ws://127.0.0.1', 'ws://[::1]'];

/**
 * The pairing token IS the Noise PSK and is dialed verbatim as the relay's
 * `?slot=` parameter (channel/slot.ts), so a non-TLS relay would put the PSK
 * on the wire in cleartext. Require `wss://`, independent of any OS-level
 * cleartext policy, carving out only loopback for local dev (docs/security.md).
 */
function isSecureRelayAddress(relayAddress: string): boolean {
  if (relayAddress.startsWith('wss://')) return true;
  return LOOPBACK_WS_PREFIXES.some((prefix) => {
    if (!relayAddress.startsWith(prefix)) return false;
    const boundaryChar = relayAddress.charAt(prefix.length);
    return boundaryChar === '' || boundaryChar === ':' || boundaryChar === '/';
  });
}

/**
 * Validates a scanned (or pasted) pairing URI before any handshake attempt.
 * Expiry and version checks here are UX only - "this code expired, scan
 * again" beats an opaque authentication failure - the real security
 * boundary is the Noise prologue binding enforced during the handshake
 * itself (docs/security.md). The relay-scheme check is not UX-only: it is
 * defense-in-depth against leaking the pairing-token PSK over a plaintext
 * relay connection.
 */
export function validateScannedQr(uri: string, now: Date = new Date()): QrValidationResult {
  let payload: PairingQrPayload;
  try {
    payload = decodePairingQrPayload(uri);
  } catch {
    return { ok: false, errorKind: uri.includes('kangentic-pair') ? 'malformed' : 'not-a-pairing-uri' };
  }

  const expiresAt = Date.parse(payload.expiresAt);
  if (Number.isNaN(expiresAt) || now.getTime() > expiresAt) {
    return { ok: false, errorKind: 'expired' };
  }

  if (payload.protocolVersion !== PROTOCOL_VERSION) {
    return { ok: false, errorKind: 'version-incompatible' };
  }

  if (!isSecureRelayAddress(payload.relayAddress)) {
    return { ok: false, errorKind: 'insecure-relay' };
  }

  return { ok: true, payload };
}
