import { describe, expect, it } from 'vitest';
import {
  encodePairingQrPayload,
  generateX25519KeyPair,
  randomBytes,
  PROTOCOL_VERSION,
  type PairingQrPayload,
} from '@kangentic/protocol';
import { validateScannedQr } from '@/pairing/qr';

/**
 * Fixed anchor so expiry comparisons are fully deterministic - no real
 * timers, no dependency on the wall clock at test-run time. `now` is always
 * passed explicitly to `validateScannedQr`, offset in seconds from this
 * anchor, matching the offsets baked into `expiresAt`.
 */
const ANCHOR_TIME = new Date('2026-01-01T00:00:00.000Z').getTime();

function isoTimestamp(secondsFromAnchor: number): string {
  return new Date(ANCHOR_TIME + secondsFromAnchor * 1000).toISOString();
}

function anchorNow(secondsFromAnchor = 0): Date {
  return new Date(ANCHOR_TIME + secondsFromAnchor * 1000);
}

function buildValidPayload(overrides: Partial<PairingQrPayload> = {}): PairingQrPayload {
  return {
    desktopStaticPublicKey: generateX25519KeyPair().publicKey,
    pairingToken: randomBytes(32),
    relayAddress: 'wss://relay.example.com',
    expiresAt: isoTimestamp(600),
    protocolVersion: PROTOCOL_VERSION,
    ...overrides,
  };
}

describe('validateScannedQr', () => {
  it('accepts a valid wss:// relay payload and returns the decoded payload', () => {
    const payload = buildValidPayload({ relayAddress: 'wss://relay.example.com' });
    const uri = encodePairingQrPayload(payload);

    const result = validateScannedQr(uri, anchorNow(0));

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unreachable');
    expect(result.payload.relayAddress).toBe('wss://relay.example.com');
    expect(result.payload.protocolVersion).toBe(PROTOCOL_VERSION);
    expect(result.payload.expiresAt).toBe(payload.expiresAt);
    expect(Array.from(result.payload.pairingToken)).toEqual(Array.from(payload.pairingToken));
    expect(Array.from(result.payload.desktopStaticPublicKey)).toEqual(Array.from(payload.desktopStaticPublicKey));
  });

  it('accepts loopback ws:// relays as a dev carve-out', () => {
    const ipv4Payload = buildValidPayload({ relayAddress: 'ws://127.0.0.1:8080' });
    const ipv4Result = validateScannedQr(encodePairingQrPayload(ipv4Payload), anchorNow(0));
    expect(ipv4Result.ok).toBe(true);

    const ipv6Payload = buildValidPayload({ relayAddress: 'ws://[::1]:8080' });
    const ipv6Result = validateScannedQr(encodePairingQrPayload(ipv6Payload), anchorNow(0));
    expect(ipv6Result.ok).toBe(true);

    const localhostPayload = buildValidPayload({ relayAddress: 'ws://localhost' });
    const localhostResult = validateScannedQr(encodePairingQrPayload(localhostPayload), anchorNow(0));
    expect(localhostResult.ok).toBe(true);
  });

  it('rejects a ws:// host that only LOOKS like loopback', () => {
    // The pairing token IS the Noise PSK and is dialed verbatim as ?slot=, so
    // every one of these would put it on the wire in cleartext to a host the
    // attacker picked, and persist that host to the trust anchor.
    const impostors = [
      // Userinfo: everything before the '@' is credentials, so this dials evil.test.
      'ws://127.0.0.1:8080@evil.test',
      'ws://localhost@evil.test',
      // Trailing garbage after a bracketed IPv6 literal: truncating at the ']'
      // would read this as the host [::1].
      'ws://[::1]evil.com',
      'ws://[::1]:8080@evil.test',
      // A name that merely starts with a loopback string.
      'ws://localhost.evil.com',
      'ws://127.0.0.1.evil.com',
    ];
    for (const relayAddress of impostors) {
      const result = validateScannedQr(encodePairingQrPayload(buildValidPayload({ relayAddress })), anchorNow(0));
      expect(result.ok, relayAddress).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.errorKind, relayAddress).toBe('insecure-relay');
    }
  });

  it('accepts the emulator host-loopback alias ws://10.0.2.2 only in dev builds', () => {
    const payload = buildValidPayload({ relayAddress: 'ws://10.0.2.2:8080' });
    const uri = encodePairingQrPayload(payload);

    // Without __DEV__ defined (production shape), the alias is rejected.
    const productionResult = validateScannedQr(uri, anchorNow(0));
    expect(productionResult.ok).toBe(false);
    if (productionResult.ok) throw new Error('unreachable');
    expect(productionResult.errorKind).toBe('insecure-relay');

    // With __DEV__ true (dev-client shape), the alias is a loopback peer.
    (globalThis as { __DEV__?: boolean }).__DEV__ = true;
    try {
      const devResult = validateScannedQr(uri, anchorNow(0));
      expect(devResult.ok).toBe(true);

      // Prefix-boundary still enforced: 10.0.2.20 is NOT the alias.
      const boundaryPayload = buildValidPayload({ relayAddress: 'ws://10.0.2.20:8080' });
      const boundaryResult = validateScannedQr(encodePairingQrPayload(boundaryPayload), anchorNow(0));
      expect(boundaryResult.ok).toBe(false);
    } finally {
      delete (globalThis as { __DEV__?: boolean }).__DEV__;
    }
  });

  /**
   * E2E has to run against a release-shaped binary (no dev menu, no Metro),
   * which without this flag refuses the local dev relay. The flag is the ONLY
   * other way in: it is an EXPO_PUBLIC_ value Metro inlines at build time, so
   * a build that did not set it has no branch to take, and nothing on an
   * installed app can turn it on.
   */
  it('accepts the emulator alias in a release-shaped e2e build, and only for that exact flag value', () => {
    const uri = encodePairingQrPayload(buildValidPayload({ relayAddress: 'ws://10.0.2.2:8080' }));
    const originalFlag = process.env.EXPO_PUBLIC_KANGENTIC_E2E;

    try {
      process.env.EXPO_PUBLIC_KANGENTIC_E2E = '1';
      expect(validateScannedQr(uri, anchorNow(0)).ok).toBe(true);

      // A stray truthy-looking value is not the flag: only the literal '1'
      // the e2e profile sets opens the carve-out.
      process.env.EXPO_PUBLIC_KANGENTIC_E2E = 'true';
      expect(validateScannedQr(uri, anchorNow(0)).ok).toBe(false);

      // And the flag never widens anything BEYOND the emulator alias.
      process.env.EXPO_PUBLIC_KANGENTIC_E2E = '1';
      const publicRelay = encodePairingQrPayload(buildValidPayload({ relayAddress: 'ws://relay.example.com' }));
      expect(validateScannedQr(publicRelay, anchorNow(0)).ok).toBe(false);
      const lookalike = encodePairingQrPayload(buildValidPayload({ relayAddress: 'ws://10.0.2.20:8080' }));
      expect(validateScannedQr(lookalike, anchorNow(0)).ok).toBe(false);
    } finally {
      if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_E2E;
      else process.env.EXPO_PUBLIC_KANGENTIC_E2E = originalFlag;
    }
  });

  /**
   * The bypass a prefix match cannot see. A URL's authority ends at the first
   * '/', '?' or '#', and anything before an '@' inside it is USERINFO, not the
   * host: `ws://127.0.0.1:8080@evil.test` dials evil.test, with 127.0.0.1 as a
   * username and 8080 as a password. The old check matched the `ws://127.0.0.1`
   * prefix, saw ':' next, read it as a port boundary and accepted - so a single
   * crafted relayAddress on an otherwise ordinary QR sent the pairing token
   * (which IS the Noise PSK) over cleartext to an attacker-chosen host, and
   * persisted that host to the trust anchor for every later session.
   *
   * Checked for EVERY allowed host, including the emulator alias with its
   * build gate wide open, because each was its own prefix in the old list.
   */
  it('rejects a userinfo address that only looks like loopback', () => {
    const credentialedAddresses = [
      'ws://127.0.0.1:8080@evil.test',
      'ws://localhost:8080@evil.test',
      'ws://[::1]:8080@evil.test',
      'ws://10.0.2.2:8080@evil.test',
      // Without a port, so the '@' lands directly on the boundary char.
      'ws://127.0.0.1@evil.test',
      // Userinfo plus a path, so the authority is not the whole remainder.
      'ws://127.0.0.1:8080@evil.test/relay?slot=abc',
    ];
    const originalFlag = process.env.EXPO_PUBLIC_KANGENTIC_E2E;
    try {
      // Gate open: proves these are refused on their own merits, not because
      // the emulator carve-out happened to be closed.
      process.env.EXPO_PUBLIC_KANGENTIC_E2E = '1';
      for (const relayAddress of credentialedAddresses) {
        const result = validateScannedQr(encodePairingQrPayload(buildValidPayload({ relayAddress })), anchorNow(0));
        expect(result.ok, `${relayAddress} must not validate`).toBe(false);
        if (result.ok) throw new Error('unreachable');
        expect(result.errorKind).toBe('insecure-relay');
      }
    } finally {
      if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_E2E;
      else process.env.EXPO_PUBLIC_KANGENTIC_E2E = originalFlag;
    }
  });

  /**
   * The companion positive control: the forms that are genuinely loopback must
   * still pass, so the fix above cannot be satisfied by rejecting everything.
   */
  it('still accepts genuine loopback authorities, including ports, paths and mixed case', () => {
    const acceptedAddresses = [
      'ws://127.0.0.1',
      'ws://127.0.0.1:8080',
      // Exactly what the desktop emits: LOCAL_DEV_RELAY_URL verbatim for its
      // 'local' mode, and url.href for a custom one - which appends a trailing
      // slash to an authority-only URL. Both must validate, or a real pairing
      // breaks.
      'ws://127.0.0.1:8080/',
      'ws://127.0.0.1:8080/relay',
      'ws://127.0.0.1:8080?slot=abc',
      'ws://localhost:8080',
      'ws://LOCALHOST:8080',
      'ws://[::1]:8080',
    ];
    for (const relayAddress of acceptedAddresses) {
      const result = validateScannedQr(encodePairingQrPayload(buildValidPayload({ relayAddress })), anchorNow(0));
      expect(result.ok, `${relayAddress} must validate`).toBe(true);
    }
  });

  /**
   * A host that merely CONTAINS a loopback label is not loopback. These were
   * already refused by the prefix check; they stay refused under authority
   * parsing, which is what makes this a regression guard rather than a
   * restatement of the fix.
   */
  it('rejects hosts that only embed a loopback label', () => {
    const lookalikeAddresses = [
      'ws://127.0.0.1.evil.test',
      'ws://localhost.evil.test',
      'ws://evil.test/127.0.0.1',
      // A non-numeric port must not be stripped down to a matching host.
      'ws://127.0.0.1:evil.test',
    ];
    for (const relayAddress of lookalikeAddresses) {
      const result = validateScannedQr(encodePairingQrPayload(buildValidPayload({ relayAddress })), anchorNow(0));
      expect(result.ok, `${relayAddress} must not validate`).toBe(false);
    }
  });

  it('rejects a non-loopback plaintext ws:// relay as insecure-relay', () => {
    const payload = buildValidPayload({ relayAddress: 'ws://relay.example.com' });
    const uri = encodePairingQrPayload(payload);

    const result = validateScannedQr(uri, anchorNow(0));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorKind).toBe('insecure-relay');
  });

  it('rejects a host that merely starts with a loopback prefix as insecure-relay (boundary check)', () => {
    const payload = buildValidPayload({ relayAddress: 'ws://localhost.evil.com' });
    const uri = encodePairingQrPayload(payload);

    const result = validateScannedQr(uri, anchorNow(0));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorKind).toBe('insecure-relay');
  });

  it('rejects a non-pairing URI as not-a-pairing-uri', () => {
    const result = validateScannedQr('https://example.com', anchorNow(0));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorKind).toBe('not-a-pairing-uri');
  });

  it('rejects a kangentic-pair:// URI with a corrupted blob as malformed', () => {
    const result = validateScannedQr('kangentic-pair://AAAA', anchorNow(0));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorKind).toBe('malformed');
  });

  it('rejects a payload that has expired relative to the passed-in now', () => {
    const payload = buildValidPayload({ expiresAt: isoTimestamp(-600) });
    const uri = encodePairingQrPayload(payload);

    const result = validateScannedQr(uri, anchorNow(0));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorKind).toBe('expired');
  });

  it('rejects a payload whose protocolVersion differs from PROTOCOL_VERSION', () => {
    const payload = buildValidPayload({ protocolVersion: '999' });
    const uri = encodePairingQrPayload(payload);

    const result = validateScannedQr(uri, anchorNow(0));

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.errorKind).toBe('version-incompatible');
  });
});
