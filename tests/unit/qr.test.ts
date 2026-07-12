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
