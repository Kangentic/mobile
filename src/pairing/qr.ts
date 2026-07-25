import { decodePairingQrPayload, PROTOCOL_VERSION, type PairingQrPayload } from '@kangentic/protocol';

export type QrValidationErrorKind = 'not-a-pairing-uri' | 'malformed' | 'expired' | 'version-incompatible' | 'insecure-relay';

export type QrValidationResult =
  | { ok: true; payload: PairingQrPayload }
  | { ok: false; errorKind: QrValidationErrorKind };

/** Loopback hosts permitted over plaintext `ws://` for a local dev relay (see scripts/stubDesktopPeer.mjs). */
const LOOPBACK_WS_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

const PLAINTEXT_SCHEME = 'ws://';

/**
 * The Android emulator's NAT alias for the HOST's loopback interface:
 * same-machine traffic with loopback trust, so a dev-rig relay is reachable
 * without any adb reverse. Only meaningful ON an emulator - on physical
 * hardware 10.0.2.2 is an ordinary private address - so it is carved out only
 * for the two build shapes below, never for a build a user could install.
 */
const DEV_EMULATOR_HOST_LOOPBACK = '10.0.2.2';

/**
 * Whether this BUILD may pair through the emulator's host-loopback alias.
 *
 * Two build shapes qualify, and both are decided at BUILD time, never at run
 * time: there is no runtime flag, setting, or intent an attacker could flip on
 * an installed app to widen what it accepts.
 *
 * - `__DEV__` - a Metro dev bundle.
 * - `EXPO_PUBLIC_KANGENTIC_E2E` - the `e2e` EAS profile (eas.json). E2E has to
 *   run against a RELEASE-shaped binary: Maestro's own guidance is to test the
 *   final bundled app, and a dev client drags in a dev menu whose window hides
 *   the app's entire view tree from the hierarchy, a Metro dependency, and a
 *   bundle URL that `pm clear` wipes. Without this flag that binary refuses the
 *   local dev relay, which is why E2E was stuck on the dev client.
 *
 * Both are inlined by Metro at build time (`EXPO_PUBLIC_*` is substituted as a
 * literal), so in a production bundle this function constant-folds to the
 * loopback-only list and the emulator branch is eliminated outright. The `e2e`
 * profile is internal-distribution only and is never the profile that ships.
 */
function buildAllowsEmulatorHostLoopback(): boolean {
  if (typeof __DEV__ !== 'undefined' && __DEV__) return true;
  return process.env.EXPO_PUBLIC_KANGENTIC_E2E === '1';
}

/**
 * Strips a port from a URL authority, leaving the host.
 *
 * An IPv6 literal is bracketed and full of colons of its own, so its port (if
 * any) is whatever follows the closing bracket - never `lastIndexOf(':')`.
 * A non-numeric port is left attached deliberately: it cannot match the
 * allow-list, so a malformed authority fails closed instead of being
 * "cleaned up" into a host that does match.
 */
function hostWithoutPort(authority: string): string {
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']');
    return closingBracket === -1 ? authority : authority.slice(0, closingBracket + 1);
  }
  const portSeparator = authority.lastIndexOf(':');
  if (portSeparator === -1) return authority;
  const port = authority.slice(portSeparator + 1);
  return /^[0-9]+$/.test(port) ? authority.slice(0, portSeparator) : authority;
}

/**
 * The host a plaintext `ws://` address actually dials, or null if it is not
 * plaintext or carries credentials.
 *
 * This must parse the AUTHORITY, never prefix-match the string. A URL's
 * authority ends at the first `/`, `?` or `#`, and anything before an `@`
 * inside it is userinfo, not the host - so `ws://127.0.0.1:8080@evil.test`
 * dials **evil.test**, with `127.0.0.1`/`8080` as a username and password.
 * A prefix match reads that as loopback-plus-a-port and waves it through,
 * which is precisely the bypass this function exists to close: the pairing
 * token is the Noise PSK, so one crafted `relayAddress` in an otherwise
 * ordinary QR would put it on the wire in cleartext to an attacker-chosen
 * host, and the address is then persisted to the trust anchor for every
 * later session.
 *
 * Credentials are rejected outright rather than parsed around: this app has
 * no use for relay userinfo, so an `@` here is only ever an attempt to look
 * like something it is not.
 */
function plaintextRelayHost(relayAddress: string): string | null {
  if (!relayAddress.startsWith(PLAINTEXT_SCHEME)) return null;
  const afterScheme = relayAddress.slice(PLAINTEXT_SCHEME.length);
  const authorityEnd = afterScheme.search(/[/?#]/);
  const authority = authorityEnd === -1 ? afterScheme : afterScheme.slice(0, authorityEnd);
  if (authority.includes('@')) return null;
  // Hosts are case-insensitive; the allow-list is lowercase.
  return hostWithoutPort(authority).toLowerCase();
}

/**
 * The pairing token IS the Noise PSK and is dialed verbatim as the relay's
 * `?slot=` parameter (channel/slot.ts), so a non-TLS relay would put the PSK
 * on the wire in cleartext. Require `wss://`, independent of any OS-level
 * cleartext policy, carving out only loopback for local dev (docs/security.md),
 * plus the emulator's host-loopback alias for the build shapes above.
 *
 * Deliberately hand-rolled rather than built on `new URL()`: Hermes ships a
 * partial URL implementation and React Native's polyfill situation varies by
 * SDK, so a security check whose verdict depends on which URL parser is
 * present at runtime would be worse than the string comparison it replaced.
 */
function isSecureRelayAddress(relayAddress: string): boolean {
  if (relayAddress.startsWith('wss://')) return true;
  const host = plaintextRelayHost(relayAddress);
  if (host === null) return false;
  if (LOOPBACK_WS_HOSTS.includes(host)) return true;
  return buildAllowsEmulatorHostLoopback() && host === DEV_EMULATOR_HOST_LOOPBACK;
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
