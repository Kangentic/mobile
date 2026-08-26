/**
 * `app/+native-intent.ts`'s `redirectSystemPath`: the ONLY deep-link handling
 * in the app, and deliberately scoped to the reviewer/demo code alone (see
 * the module's own header for why a real `kangentic-pair://` payload must
 * NOT be routed here).
 *
 * Two behaviors matter enough to pin:
 *  1. Only the demo code's three recognised forms are rewritten to the
 *     pairing screen; a real pairing URI and any other path pass through
 *     unchanged.
 *  2. A throw out of the demo predicate must never propagate - this runs
 *     before any error boundary exists, so a throw here would crash the app
 *     at launch on an arbitrary incoming URL.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodePairingQrPayload, generateX25519KeyPair, randomBytes, PROTOCOL_VERSION } from '@kangentic/protocol';

import { DEMO_DEEP_LINK_PARAM } from '@/demo/demoIdentity';
import { redirectSystemPath } from '../../app/+native-intent';

/** A well-formed, currently-valid REAL pairing URI - never the demo code. */
function realPairingUri(): string {
  return encodePairingQrPayload({
    desktopStaticPublicKey: generateX25519KeyPair().publicKey,
    pairingToken: randomBytes(32),
    relayAddress: 'wss://relay.example.com',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    protocolVersion: PROTOCOL_VERSION,
  });
}

describe('redirectSystemPath', () => {
  it('routes the demo URI shortcut to the pairing screen with the demo query param', () => {
    const result = redirectSystemPath({ path: 'kangentic-pair://demo', initial: false });
    // Built from the real constant, not a hardcoded literal, so a rename of
    // the query param is caught by whatever reads it downstream, not by this
    // test silently agreeing with a stale string.
    expect(result).toBe(`/pair?${DEMO_DEEP_LINK_PARAM}=1`);
  });

  it('routes the bare demo word to the pairing screen with the demo query param', () => {
    const result = redirectSystemPath({ path: 'demo', initial: false });
    expect(result).toBe(`/pair?${DEMO_DEEP_LINK_PARAM}=1`);
  });

  it('returns a genuine, currently-valid real pairing URI unchanged', () => {
    // The load-bearing case: a real pairing link must fall through to the
    // no-op, or a phone could be steered into a ceremony with an
    // attacker-chosen desktop key and relay from an arbitrary web page.
    const uri = realPairingUri();
    expect(redirectSystemPath({ path: uri, initial: false })).toBe(uri);
  });

  it('returns an arbitrary path unchanged', () => {
    expect(redirectSystemPath({ path: '/settings', initial: false })).toBe('/settings');
    expect(redirectSystemPath({ path: 'https://example.com', initial: false })).toBe('https://example.com');
  });
});

describe('redirectSystemPath, when the demo predicate throws', () => {
  afterEach(() => {
    vi.doUnmock('@/demo/demoIdentity');
    vi.resetModules();
  });

  it('falls through to the unchanged raw path rather than crashing at launch', async () => {
    vi.resetModules();
    vi.doMock('@/demo/demoIdentity', async () => {
      const actual = await vi.importActual<typeof import('@/demo/demoIdentity')>('@/demo/demoIdentity');
      return {
        ...actual,
        isDemoPairingCode: () => {
          throw new Error('boom');
        },
      };
    });

    const { redirectSystemPath: redirectSystemPathWithThrowingPredicate } = await import('../../app/+native-intent');
    expect(redirectSystemPathWithThrowingPredicate({ path: 'kangentic-pair://demo', initial: false })).toBe(
      'kangentic-pair://demo',
    );
  });
});
