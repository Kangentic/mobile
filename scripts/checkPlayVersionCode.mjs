#!/usr/bin/env node
/**
 * Fail fast when the version code about to be submitted already exists on a
 * Google Play track.
 *
 * android.versionCode is hand-bumped in app.config.ts (eas.json sets
 * cli.appVersionSource to "local", so EAS does not track it server-side).
 * Nothing local can tell whether a value is already spent, because the answer
 * lives in Play Console. This closes that gap, which the Android release
 * section of docs/developer-guide.md calls out as unenforced.
 *
 * It deliberately does not auto-increment. The hand-bumped, code-reviewed
 * version code is a decision made in task #10 and this only guards it.
 *
 * Implemented against the Play Developer API v3 with no dependencies: the
 * service-account JWT is signed with node:crypto, so nothing is added to
 * package-lock.json for a CI-only check.
 *
 * Usage:
 *   node scripts/checkPlayVersionCode.mjs \
 *     --key <service-account.json> --package <applicationId> --version-code <n>
 */
import { Buffer } from 'node:buffer';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const PLAY_API_BASE = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag.startsWith('--') || value === undefined) {
      throw new Error(`Malformed argument near "${flag}".`);
    }
    parsed[flag.slice(2)] = value;
  }
  for (const required of ['key', 'package', 'version-code']) {
    if (!parsed[required]) {
      throw new Error(`Missing required argument --${required}.`);
    }
  }
  return parsed;
}

function base64Url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function requestAccessToken(serviceAccount) {
  const issuedAt = Math.floor(Date.now() / 1000);
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
  const signature = signer.sign(serviceAccount.private_key, 'base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });

  if (!response.ok) {
    throw new Error(`Google rejected the service-account assertion (${response.status}): ${await response.text()}`);
  }
  return (await response.json()).access_token;
}

async function callPlayApi(accessToken, path, method = 'GET') {
  const response = await fetch(`${PLAY_API_BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  return { ok: response.ok, status: response.status, body: response.status === 204 ? {} : await response.json() };
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const versionCode = Number(options['version-code']);
  if (!Number.isInteger(versionCode) || versionCode <= 0) {
    throw new Error(`--version-code must be a positive integer, got "${options['version-code']}".`);
  }

  const serviceAccount = JSON.parse(readFileSync(options.key, 'utf8'));
  const accessToken = await requestAccessToken(serviceAccount);
  const applicationId = options.package;

  const edit = await callPlayApi(accessToken, `/${applicationId}/edits`, 'POST');
  if (!edit.ok) {
    if (edit.status === 404) {
      throw new Error(
        `Play has no record of ${applicationId}. The very first release for a package must be uploaded by hand ` +
          'through the Play Console UI before the Play Developer API will accept anything.'
      );
    }
    throw new Error(`Could not open a Play edit (${edit.status}): ${JSON.stringify(edit.body)}`);
  }

  const editId = edit.body.id;
  try {
    const tracks = await callPlayApi(accessToken, `/${applicationId}/edits/${editId}/tracks`);
    if (!tracks.ok) {
      throw new Error(`Could not list Play tracks (${tracks.status}): ${JSON.stringify(tracks.body)}`);
    }

    const usedVersionCodes = new Map();
    for (const track of tracks.body.tracks ?? []) {
      for (const release of track.releases ?? []) {
        for (const code of release.versionCodes ?? []) {
          usedVersionCodes.set(Number(code), track.track);
        }
      }
    }

    if (usedVersionCodes.has(versionCode)) {
      throw new Error(
        `Version code ${versionCode} is already released on the "${usedVersionCodes.get(versionCode)}" track. ` +
          'Bump android.versionCode in app.config.ts and rebuild; Play will not accept a duplicate.'
      );
    }

    const highestUsed = usedVersionCodes.size > 0 ? Math.max(...usedVersionCodes.keys()) : 0;
    if (versionCode < highestUsed) {
      throw new Error(
        `Version code ${versionCode} is lower than ${highestUsed}, which is already on a track. ` +
          'Play only accepts an increasing version code.'
      );
    }

    process.stdout.write(
      `Version code ${versionCode} is free (highest currently on a track: ${highestUsed || 'none'}).\n`
    );
  } finally {
    // Edits expire on their own, but leaving them open clutters the app and
    // can block a concurrent edit.
    await callPlayApi(accessToken, `/${applicationId}/edits/${editId}`, 'DELETE');
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
