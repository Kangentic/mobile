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
import { PUSH_CATEGORIES, type PushClearEntry } from '@kangentic/protocol';
import { clearEntryCovers, notificationIdForRouting, routingFromNotificationData } from '@/notifications/notificationRouting';
import { hchacha20, selfCheckHChaCha20, threadIdentifier } from '../../scripts/generateNseCryptoFixtures.mjs';

interface FixtureCase {
  name: string;
  blob: string;
  expected: Record<string, unknown> | null;
}

/** A delivered or incoming alert in a match case: only what pruning reads. */
interface MatchAlert {
  category: string;
  projectId: string;
  taskId: string;
  sessionId: string;
  sentAt: number;
}

type MatchCase =
  | { name: string; kind: 'covers'; entry: PushClearEntry; delivered: MatchAlert; expected: boolean }
  | { name: string; kind: 'supersedes'; incoming: MatchAlert; delivered: MatchAlert; incomingIdentityKey: string; expected: boolean };

interface ThreadIdentifierVector {
  name: string;
  taskId: string;
  projectId: string;
  expected: string | null;
}

interface FixtureFile {
  pushKeyHex: string;
  identityPublicKeyHex: string;
  nowMilliseconds: number;
  hchacha20Vector: { keyHex: string; nonceHeadHex: string; subkeyHex: string };
  cases: FixtureCase[];
  matchCases: MatchCase[];
  threadIdentifierVectors: ThreadIdentifierVector[];
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

  /**
   * Protocol 0.23.0's piggybacked clears: a case whose expected parse keeps some
   * entries and drops others, and a malformed list that must not cost the
   * notification. Reduced to one clean list, the Swift tolerance would go
   * unchecked.
   */
  it('covers the tolerant clears parse the extension must match', () => {
    const tolerant = fixtures.cases.find((testCase) => testCase.name === 'piggybacked-clears-parse-tolerantly');
    expect((tolerant?.expected?.clears as unknown[] | undefined)?.length).toBe(2);
    const malformed = fixtures.cases.find((testCase) => testCase.name === 'malformed-clears-list-still-opens');
    expect(malformed?.expected?.clears).toEqual([]);
  });
});

/**
 * ONE truth table for which delivered alerts a push removes, held against both
 * platforms. The Swift harness runs it through NotificationPruning; this runs
 * the same rows through the app's own TypeScript, so the extension and the
 * Android path cannot drift apart without one of the two going red.
 */
describe('NSE pruning truth table against the app matcher', () => {
  function routingOf(alert: MatchAlert) {
    const routing = routingFromNotificationData(alert);
    if (routing === null) throw new Error('a match alert did not read as routing');
    return routing;
  }

  it('carries both kinds of row', () => {
    expect(fixtures.matchCases.some((matchCase) => matchCase.kind === 'covers')).toBe(true);
    expect(fixtures.matchCases.some((matchCase) => matchCase.kind === 'supersedes')).toBe(true);
  });

  it.each(fixtures.matchCases.map((matchCase) => [matchCase.name, matchCase] as const))('%s', (_name, matchCase) => {
    if (matchCase.kind === 'covers') {
      expect(clearEntryCovers(matchCase.entry, routingOf(matchCase.delivered), matchCase.delivered.sentAt)).toBe(matchCase.expected);
      return;
    }
    // The iOS identity IS the Android stable id: a repeat that replaces an
    // alert on Android supersedes the same alert on iOS.
    const incomingKey = notificationIdForRouting(routingOf(matchCase.incoming));
    expect(incomingKey).toBe(matchCase.incomingIdentityKey);
    const deliveredKey = notificationIdForRouting(routingOf(matchCase.delivered));
    const supersedes = incomingKey !== null && incomingKey === deliveredKey && matchCase.delivered.sentAt <= matchCase.incoming.sentAt;
    expect(supersedes).toBe(matchCase.expected);
  });
});

describe('NSE thread identifier vectors', () => {
  it('still recompute from the generator, so the committed vectors are the ones it derives', () => {
    expect(fixtures.threadIdentifierVectors.length).toBeGreaterThan(0);
    for (const vector of fixtures.threadIdentifierVectors) {
      expect(threadIdentifier(hexToBytes(fixtures.pushKeyHex), vector.taskId, vector.projectId)).toBe(vector.expected);
    }
  });

  it('are opaque: 32 hex characters, never the id itself, and absent for an alert naming nothing', () => {
    for (const vector of fixtures.threadIdentifierVectors) {
      if (vector.taskId.length === 0 && vector.projectId.length === 0) {
        expect(vector.expected).toBeNull();
        continue;
      }
      expect(vector.expected).toMatch(/^[0-9a-f]{32}$/);
      expect(vector.expected).not.toContain(vector.taskId || vector.projectId);
    }
  });
});
