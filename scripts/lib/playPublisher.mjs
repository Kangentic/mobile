/**
 * The Google Play Developer API v3 transport shared by the release scripts:
 * the service-account sign-in, and a `request` function the scripts are handed
 * so their tests can swap it for an in-memory Play.
 *
 * No dependencies: the service-account JWT is signed with node:crypto, so
 * nothing is added to package-lock.json for CI-only scripts.
 *
 * The sign-in was written for scripts/checkPlayVersionCode.mjs and moved here
 * unchanged when scripts/syncPlayListingImages.mjs needed it too.
 */
import { Buffer } from 'node:buffer';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

export const PLAY_API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
/** Media uploads go to the same resource path under `/upload/`. */
export const PLAY_UPLOAD_BASE = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3/applications';
export const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
export const PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

/**
 * @typedef {{ client_email: string, private_key: string }} ServiceAccount
 * @typedef {{ ok: boolean, status: number, body: any }} PlayResponse
 * @typedef {{ bytes: Uint8Array, contentType: string }} PlayUpload
 * @typedef {(method: string, apiPath: string, upload?: PlayUpload) => Promise<PlayResponse>} PlayRequest
 */

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Reads the service-account key file.
 *
 * The failure message is deliberately generic. `JSON.parse` quotes the start of
 * what it could not parse, and what it could not parse here is a private key
 * headed for a public CI log.
 *
 * @param {string} keyPath
 * @returns {ServiceAccount}
 */
export function readServiceAccount(keyPath) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(keyPath, 'utf8'));
  } catch {
    throw new Error(
      'The Play service-account key could not be read as JSON. Check that PLAY_SERVICE_ACCOUNT_JSON holds the ' +
        'full key file, unquoted and unwrapped.'
    );
  }
  if (typeof parsed?.client_email !== 'string' || typeof parsed?.private_key !== 'string') {
    throw new Error('The Play service-account key has no client_email or private_key. Is it a service-account key file?');
  }
  return parsed;
}

/**
 * The signed JWT Google exchanges for an access token (RFC 7523).
 *
 * @param {ServiceAccount} serviceAccount
 * @param {number} [issuedAt] seconds since the epoch
 * @returns {string}
 */
export function createServiceAccountAssertion(serviceAccount, issuedAt = Math.floor(Date.now() / 1000)) {
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: serviceAccount.client_email,
      scope: PUBLISHER_SCOPE,
      aud: TOKEN_ENDPOINT,
      iat: issuedAt,
      exp: issuedAt + 3600,
    })
  );

  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer
    .sign(serviceAccount.private_key, 'base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${claims}.${signature}`;
}

/**
 * @param {ServiceAccount} serviceAccount
 * @returns {Promise<string>}
 */
export async function requestAccessToken(serviceAccount) {
  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: createServiceAccountAssertion(serviceAccount),
    }),
  });

  if (!response.ok) {
    throw new Error(`Google rejected the service-account assertion (${response.status}): ${await response.text()}`);
  }
  return (await response.json()).access_token;
}

/**
 * What a 404 on opening an edit means. Every script that opens one says it the
 * same way, because the fix is the same: the first upload is by hand.
 *
 * @param {string} packageName
 * @returns {string}
 */
export function describeMissingPackage(packageName) {
  return (
    `Play has no record of ${packageName}. The very first release for a package must be uploaded by hand ` +
    'through the Play Console UI before the Play Developer API will accept anything.'
  );
}

/**
 * The real transport behind the injected `request`.
 *
 * `apiPath` is relative to the applications collection (`/<package>/edits...`).
 * Passing `upload` sends the bytes as a simple media upload to the same path
 * under `/upload/`, which is how `edits.images.upload` takes a screenshot.
 *
 * The body is read as text first: a proxy error page is not JSON, and a
 * `response.json()` that throws would hide the status that explains it.
 *
 * @param {string} accessToken
 * @returns {PlayRequest}
 */
export function createPlayRequest(accessToken) {
  return async (method, apiPath, upload) => {
    const url = upload
      ? `${PLAY_UPLOAD_BASE}${apiPath}${apiPath.includes('?') ? '&' : '?'}uploadType=media`
      : `${PLAY_API_BASE}${apiPath}`;
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(upload ? { 'Content-Type': upload.contentType } : {}),
      },
      body: upload ? upload.bytes : undefined,
    });
    const text = await response.text();
    let body = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text.slice(0, 500) };
      }
    }
    return { ok: response.ok, status: response.status, body };
  };
}
