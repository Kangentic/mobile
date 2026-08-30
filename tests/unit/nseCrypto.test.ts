/**
 * Guards the cross-language crypto fixture the iOS Notification Service
 * Extension is checked against.
 *
 * The real proof that the Swift XChaCha20-Poly1305 matches the protocol is the
 * "NSE crypto (swiftc)" job in ci.yml, which opens these sealed envelopes on a
 * macOS runner. This file guards the inputs to that proof, on Windows, for
 * free:
 *
 *   - the subkey construction still reproduces @noble's XChaCha20-Poly1305, so
 *     a change in either library cannot silently invalidate the approach,
 *   - the committed fixture still matches the implementation that generated it,
 *   - and the negative cases the harness relies on are actually present. A
 *     fixture quietly reduced to happy-path cases would leave the harness green
 *     while proving almost nothing.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUSH_CATEGORIES } from '@kangentic/protocol';
import { hchacha20, selfCheckHChaCha20 } from '../../scripts/generateNseCryptoFixtures.mjs';

interface FixtureCase {
  name: string;
  blob: string;
  expected: Record<string, unknown> | null;
}

interface FixtureFile {
  pushKeyHex: string;
  identityPublicKeyHex: string;
  nowMilliseconds: number;
  hchacha20Vector: { keyHex: string; nonceHeadHex: string; subkeyHex: string };
  cases: FixtureCase[];
}

const fixtures = JSON.parse(
  readFileSync(join(__dirname, '..', 'swift', 'pushEnvelopeFixtures.json'), 'utf8'),
) as FixtureFile;

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

function bytesToHexString(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

describe('NSE crypto fixture', () => {
  it('subkey derivation still reproduces XChaCha20-Poly1305 as @noble implements it', () => {
    // The identity the whole Swift port rests on: XChaCha20-Poly1305 is
    // HChaCha20 for a subkey, then the IETF cipher under 0^4 || nonce[16..24].
    // Throws rather than returning false if it ever stops holding.
    expect(() => selfCheckHChaCha20()).not.toThrow();
  });

  it('matches the published draft-irtf-cfrg-xchacha HChaCha20 vector', () => {
    const derived = hchacha20(
      hexToBytes(fixtures.hchacha20Vector.keyHex),
      hexToBytes(fixtures.hchacha20Vector.nonceHeadHex),
    ) as Uint8Array;
    expect(bytesToHexString(derived)).toBe(fixtures.hchacha20Vector.subkeyHex);
    expect(fixtures.hchacha20Vector.subkeyHex).toBe(
      '82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc',
    );
  });

  it('carries a 32-byte push key, a 32-byte AAD, and a baked-in timestamp', () => {
    expect(fixtures.pushKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(fixtures.identityPublicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    // Baked in rather than read from the clock, so the freshness cases stay
    // meaningful however long after generation the Swift harness runs.
    expect(Number.isFinite(fixtures.nowMilliseconds)).toBe(true);
    expect(fixtures.nowMilliseconds).toBeGreaterThan(0);
  });

  it('still covers every rejection path the extension must degrade on', () => {
    const rejectionCases = fixtures.cases.filter((testCase) => testCase.expected === null).map((testCase) => testCase.name);
    expect(rejectionCases).toEqual(
      expect.arrayContaining([
        'tampered-tag',
        'sealed-with-a-different-push-key',
        'sealed-for-a-different-recipient-aad-mismatch',
        'stale-sent-at',
        'sent-at-too-far-in-the-future',
        'too-short-to-hold-a-nonce-and-tag',
        'not-a-blob-at-all',
      ]),
    );
  });

  it('covers the two body-composition fallbacks and a known category', () => {
    const names = fixtures.cases.map((testCase) => testCase.name);
    expect(names).toContain('empty-detail-falls-back-to-the-bare-task-title');
    expect(names).toContain('empty-task-title-uses-the-agent-session-fallback');

    for (const testCase of fixtures.cases) {
      if (testCase.expected === null) continue;
      expect(PUSH_CATEGORIES).toContain(testCase.expected.category as string);
    }
  });

  it('encodes every blob as unpadded base64url', () => {
    for (const testCase of fixtures.cases) {
      if (testCase.name === 'not-a-blob-at-all') continue;
      expect(testCase.blob).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });
});
