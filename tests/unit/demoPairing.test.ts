/**
 * The reviewer/demo pairing code: what it recognises, what it must NOT
 * recognise, and the two invariants that keep it permanent.
 *
 * The stakes are unusual for a unit test. `DEMO_PAIRING_URI` is a frozen
 * literal that will be encoded into a QR image and handed to App Store Review,
 * where it has to keep working across protocol bumps and app releases with no
 * way to reissue it mid-review. So this file pins the literal against the key
 * material it is supposed to carry, and pins that the recognition path cannot
 * be routed through version-sensitive validation.
 */
import { decodePairingQrPayload, encodePairingQrPayload, generateX25519KeyPair, randomBytes, PROTOCOL_VERSION, bytesToHex } from '@kangentic/protocol';
import { describe, expect, it } from 'vitest';

import {
  DEMO_DESKTOP_STATIC,
  DEMO_PAIRING_SHORTCUT,
  DEMO_PAIRING_TOKEN,
  DEMO_PAIRING_URI,
  DEMO_PAIRING_WORD,
  DEMO_RELAY_ADDRESS,
  demoPairingPayload,
  isDemoAnchor,
  isDemoPairingCode,
} from '@/demo/demoIdentity';
import { validateScannedQr } from '@/pairing/qr';

/** A well-formed, currently-valid real pairing URI, built the way a desktop builds one. */
function realPairingUri(): string {
  return encodePairingQrPayload({
    desktopStaticPublicKey: generateX25519KeyPair().publicKey,
    pairingToken: randomBytes(32),
    relayAddress: 'wss://relay.example.com',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    protocolVersion: PROTOCOL_VERSION,
  });
}

describe('isDemoPairingCode', () => {
  it('accepts all three forms exactly', () => {
    expect(isDemoPairingCode(DEMO_PAIRING_URI)).toBe(true);
    expect(isDemoPairingCode(DEMO_PAIRING_SHORTCUT)).toBe(true);
    expect(isDemoPairingCode(DEMO_PAIRING_WORD)).toBe(true);
  });

  it('accepts the bare word, which is what the review notes ask a reviewer to type', () => {
    // The field's placeholder advertises kangentic-pair://..., but that is a
    // hint for the normal case. Requiring a reviewer to type a scheme prefix to
    // reach a demo is friction for no benefit, and a bare word cannot collide
    // with a real code because every real pairing URI carries the scheme.
    expect(isDemoPairingCode('demo')).toBe(true);
    expect(isDemoPairingCode('  demo  ')).toBe(true);
    expect(isDemoPairingCode('DEMO')).toBe(true);
    expect(isDemoPairingCode('Demo')).toBe(true);
  });

  it('tolerates the whitespace a paste or a QR scan can carry', () => {
    expect(isDemoPairingCode(`  ${DEMO_PAIRING_SHORTCUT}  `)).toBe(true);
    expect(isDemoPairingCode(`\n${DEMO_PAIRING_URI}\n`)).toBe(true);
  });

  it('accepts the shortcut in any case, because a human types it', () => {
    expect(isDemoPairingCode('KANGENTIC-PAIR://DEMO')).toBe(true);
    expect(isDemoPairingCode('Kangentic-Pair://Demo')).toBe(true);
  });

  it('does NOT case-fold the encoded URI, where case is significant', () => {
    // base64url is case-significant, so a case-insensitive match here would be
    // accepting a string that is not the payload it claims to be.
    expect(isDemoPairingCode(DEMO_PAIRING_URI.toLowerCase())).toBe(false);
    expect(isDemoPairingCode(DEMO_PAIRING_URI.toUpperCase())).toBe(false);
  });

  it('rejects a real pairing URI', () => {
    expect(isDemoPairingCode(realPairingUri())).toBe(false);
  });

  it('rejects near misses rather than matching by prefix', () => {
    for (const nearMiss of [
      '',
      '   ',
      // 'demo' itself is ACCEPTED (see the bare-word case above); these are the
      // things that merely look like it.
      'demos',
      'demo ok',
      'ademo',
      'kangentic-pair://demo2',
      'kangentic-pair://demoo',
      'kangentic-pair://demo/',
      'kangentic-pair://demo?x=1',
      'kangentic-pair://de',
      'kangentic-pair://',
      'https://kangentic.com/demo',
      `${DEMO_PAIRING_URI}x`,
      DEMO_PAIRING_URI.slice(0, -1),
      DEMO_PAIRING_URI.replace('kangentic-pair://', 'kangentic-pairs://'),
    ]) {
      expect(isDemoPairingCode(nearMiss), nearMiss).toBe(false);
    }
  });
});

describe('the frozen demo URI', () => {
  it('decodes to exactly the key material the ceremony runs on', () => {
    // THE DRIFT ALARM. The literal is frozen and the QR built from it may
    // already be in Apple's hands, so if anyone changes the derivation labels
    // in demoIdentity.ts the running app would stop agreeing with that QR.
    // Nothing else in the codebase would notice.
    const decoded = decodePairingQrPayload(DEMO_PAIRING_URI);
    expect(bytesToHex(decoded.desktopStaticPublicKey)).toBe(bytesToHex(DEMO_DESKTOP_STATIC.publicKey));
    expect(bytesToHex(decoded.pairingToken)).toBe(bytesToHex(DEMO_PAIRING_TOKEN));
    expect(decoded.relayAddress).toBe(DEMO_RELAY_ADDRESS);
  });

  it('is deliberately NOT validated, because validation would expire it', () => {
    // The whole reason the demo is recognised by string match. If the frozen
    // blob were ever routed through validateScannedQr, this is what would
    // happen the first time PROTOCOL_VERSION moved: the QR already published
    // to App Review starts being rejected, with nothing in this repository
    // having changed. Asserting the mechanism rather than the outcome, so the
    // test explains itself when it fails.
    const decoded = decodePairingQrPayload(DEMO_PAIRING_URI);
    const result = validateScannedQr(
      encodePairingQrPayload({ ...decoded, protocolVersion: `${Number(PROTOCOL_VERSION) + 1}` }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errorKind).toBe('version-incompatible');

    // ...whereas the recognition path is unaffected by the same bump.
    expect(isDemoPairingCode(DEMO_PAIRING_URI)).toBe(true);
  });

  it('carries a far-future expiry so a curious human decoding it is not misled', () => {
    const decoded = decodePairingQrPayload(DEMO_PAIRING_URI);
    expect(Date.parse(decoded.expiresAt)).toBeGreaterThan(Date.now());
  });
});

describe('demoPairingPayload', () => {
  it('binds THIS build\'s protocol version, not the frozen blob\'s', () => {
    // The responder is handed the same value, so the two prologues agree by
    // construction. Reading the version out of the frozen literal instead
    // would desync them on the first bump.
    expect(demoPairingPayload().protocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('carries the demo key material', () => {
    const payload = demoPairingPayload();
    expect(bytesToHex(payload.desktopStaticPublicKey)).toBe(bytesToHex(DEMO_DESKTOP_STATIC.publicKey));
    expect(bytesToHex(payload.pairingToken)).toBe(bytesToHex(DEMO_PAIRING_TOKEN));
  });
});

describe('isDemoAnchor', () => {
  it('matches the demo desktop key', () => {
    expect(isDemoAnchor({ desktopStaticPublicKey: DEMO_DESKTOP_STATIC.publicKey })).toBe(true);
    expect(isDemoAnchor({ desktopStaticPublicKey: Uint8Array.from(DEMO_DESKTOP_STATIC.publicKey) })).toBe(true);
  });

  it('does not match a real desktop, however its relay is addressed', () => {
    // The discriminator is the key, not the relay address, precisely so a
    // self-hosted desktop that happened to share the demo hostname could not
    // tip a real pairing into fixture mode.
    expect(isDemoAnchor({ desktopStaticPublicKey: generateX25519KeyPair().publicKey })).toBe(false);
  });

  it('does not match a truncated or padded key', () => {
    expect(isDemoAnchor({ desktopStaticPublicKey: DEMO_DESKTOP_STATIC.publicKey.slice(0, 31) })).toBe(false);
    const padded = new Uint8Array(33);
    padded.set(DEMO_DESKTOP_STATIC.publicKey);
    expect(isDemoAnchor({ desktopStaticPublicKey: padded })).toBe(false);
  });

  it('does not match a key differing in a single byte', () => {
    const nearly = Uint8Array.from(DEMO_DESKTOP_STATIC.publicKey);
    nearly[31] ^= 0x01;
    expect(isDemoAnchor({ desktopStaticPublicKey: nearly })).toBe(false);
  });
});
