/**
 * Locks the shape of the App Store Connect JWT that scripts/checkAppStoreBuild.mjs
 * produces.
 *
 * Worth its own test because every way of getting this wrong looks identical
 * from the outside: Apple answers a malformed token with a bare 401 and no
 * indication of which field it disliked. The specific trap is the signature
 * encoding. Node's ECDSA signing defaults to DER, which is a structurally valid
 * ECDSA signature and the wrong one for JWS; the raw R||S form that JWS requires
 * needs dsaEncoding 'ieee-p1363'. A DER-encoded token is 70-odd bytes instead of
 * 64 and is rejected with the same opaque 401 as a revoked key.
 *
 * Uses a locally generated P-256 key, so no real credential and no network call.
 */
import { Buffer } from 'node:buffer';
import { generateKeyPairSync, verify } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { MAX_TOKEN_LIFETIME_SECONDS, createAppStoreConnectToken } from '../../scripts/checkAppStoreBuild.mjs';

const TEST_KEY_ID = 'ABCD123456';
const TEST_ISSUER_ID = '69a6de70-1111-2222-3333-5b8c7c2f9e01';

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')) as Record<string, unknown>;
}

describe('createAppStoreConnectToken', () => {
  const token: string = createAppStoreConnectToken(privateKeyPem, TEST_KEY_ID, TEST_ISSUER_ID);
  const [encodedHeader, encodedClaims, encodedSignature] = token.split('.');

  it('produces three base64url segments with no padding', () => {
    expect(token.split('.')).toHaveLength(3);
    // Padding or a + / character means the JWT is not base64url and Apple
    // rejects it before looking at the signature.
    expect(token).not.toMatch(/[+/=]/);
  });

  it('declares ES256 and carries the key id in the header', () => {
    // The key id belongs in the header and the issuer in the claims. Swapping
    // them yields the same opaque 401 as a bad signature.
    expect(decodeSegment(encodedHeader)).toEqual({ alg: 'ES256', kid: TEST_KEY_ID, typ: 'JWT' });
  });

  it('sets the audience Apple requires', () => {
    expect(decodeSegment(encodedClaims).aud).toBe('appstoreconnect-v1');
    expect(decodeSegment(encodedClaims).iss).toBe(TEST_ISSUER_ID);
  });

  it('expires inside Apple ceiling', () => {
    const claims = decodeSegment(encodedClaims) as { iat: number; exp: number };
    expect(claims.exp - claims.iat).toBeGreaterThan(0);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(MAX_TOKEN_LIFETIME_SECONDS);
  });

  it('signs with raw R||S rather than DER', () => {
    // The assertion that matters. A P-256 JWS signature is exactly 64 bytes:
    // two 32-byte integers concatenated. DER wraps them in a SEQUENCE with
    // length prefixes, giving 70 to 72 bytes.
    const signature = Buffer.from(encodedSignature, 'base64url');
    expect(signature).toHaveLength(64);

    // And it must actually verify under the same encoding.
    const verified = verify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedClaims}`),
      { key: publicKey, dsaEncoding: 'ieee-p1363' },
      signature
    );
    expect(verified).toBe(true);
  });
});
