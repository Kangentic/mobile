#!/usr/bin/env node
/**
 * Fail fast when the build number about to be uploaded already exists on App
 * Store Connect.
 *
 * The iOS counterpart of scripts/checkPlayVersionCode.mjs, and it exists for the
 * same reason: ios.buildNumber is hand-bumped in app.config.ts (eas.json sets
 * cli.appVersionSource to "local", which is CLI-wide and not Android-only), so
 * nothing local knows which values are spent. Apple rejects a duplicate, but
 * only after a full archive, export and upload have been paid for.
 *
 * It deliberately does not auto-increment. The hand-bumped, code-reviewed build
 * number stays a decision; this only guards it.
 *
 * KNOWN BLIND SPOT, measured rather than assumed: a build Apple has not finished
 * ingesting is invisible here. After an upload on 2026-07-26, `/v1/builds` and
 * `/v1/preReleaseVersions` both returned zero for that app for well over 45
 * minutes while the build was processing, so this script would happily have
 * called the just-uploaded number free. That window is exactly when someone is
 * most likely to re-run.
 *
 * So this is a fast early check, not the authority. The authority is the upload
 * itself: altool rejects a duplicate, and
 * .github/scripts/upload-ios-testflight.sh fails on that rejection rather than
 * treating it as success. Do not add logic here that assumes a "free" answer is
 * a guarantee.
 *
 * No dependencies. App Store Connect wants an ES256 JWT, which node:crypto can
 * produce as long as the signature is asked for in raw R||S form rather than the
 * DER that ECDSA signing defaults to. That is the dsaEncoding option below, and
 * getting it wrong yields a token Apple rejects as malformed with no hint why.
 *
 * Usage:
 *   node scripts/checkAppStoreBuild.mjs \
 *     --key <AuthKey.p8> --key-id <kid> --issuer-id <iss> \
 *     --bundle-id <com.example.app> --version <1.2.3> --build-number <n>
 */
import { Buffer } from 'node:buffer';
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const ASC_API_BASE = 'https://api.appstoreconnect.apple.com/v1';

/** Apple rejects a token whose lifetime exceeds 20 minutes. */
export const MAX_TOKEN_LIFETIME_SECONDS = 20 * 60;

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
  for (const required of ['key', 'key-id', 'issuer-id', 'bundle-id', 'build-number']) {
    if (!parsed[required]) {
      throw new Error(`Missing required argument --${required}.`);
    }
  }
  return parsed;
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

/**
 * Apple requires ES256, an expiry no more than 20 minutes out, and
 * aud "appstoreconnect-v1". The key id goes in the header, the issuer in the
 * claims.
 *
 * Exported so tests/unit/appStoreConnectToken.test.ts can lock the shape without
 * a real key or a network call. The whole point is that a malformed token comes
 * back as an opaque 401.
 */
export function createAppStoreConnectToken(privateKeyPem, keyId, issuerId) {
  const issuedAt = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: 'ES256', kid: keyId, typ: 'JWT' }));
  const claims = base64Url(
    JSON.stringify({
      iss: issuerId,
      iat: issuedAt,
      exp: issuedAt + 600,
      aud: 'appstoreconnect-v1',
    })
  );

  const signer = createSign('SHA256');
  signer.update(`${header}.${claims}`);
  // ieee-p1363 is the raw R||S encoding JWS requires. The default, 'der',
  // produces a structurally valid ECDSA signature that Apple rejects.
  const signature = signer
    .sign({ key: privateKeyPem, dsaEncoding: 'ieee-p1363' })
    .toString('base64url');

  return `${header}.${claims}.${signature}`;
}

async function callAppStoreConnect(token, path) {
  const response = await fetch(`${ASC_API_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = response.status === 204 ? {} : await response.json();
  return { ok: response.ok, status: response.status, body };
}

function describeApiErrors(body) {
  if (!Array.isArray(body?.errors)) return JSON.stringify(body);
  return body.errors.map((error) => `${error.title}: ${error.detail ?? ''}`.trim()).join('; ');
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const buildNumber = options['build-number'];
  const bundleId = options['bundle-id'];
  // Apple treats CFBundleVersion as a string, so "1" and "1.0" are different
  // builds. Compared as strings for that reason, not out of laziness.
  const shortVersion = options.version;

  const token = createAppStoreConnectToken(
    readFileSync(options.key, 'utf8'),
    options['key-id'],
    options['issuer-id']
  );

  // Resolved from the bundle id rather than taken as an argument: the numeric
  // ascAppId is not in eas.json or app.config.ts, and making a release step
  // depend on a number someone has to go and find is how releases get skipped.
  const apps = await callAppStoreConnect(token, `/apps?filter[bundleId]=${encodeURIComponent(bundleId)}`);
  if (!apps.ok) {
    if (apps.status === 401) {
      throw new Error(
        `App Store Connect rejected the API key (401). Check ASC_KEY_ID and ASC_ISSUER_ID match the .p8, ` +
          `and that the key has not been revoked. Detail: ${describeApiErrors(apps.body)}`
      );
    }
    throw new Error(`Could not list apps (${apps.status}): ${describeApiErrors(apps.body)}`);
  }

  const app = apps.body.data?.[0];
  if (!app) {
    throw new Error(
      `App Store Connect has no app with bundle id ${bundleId}. The app record must exist there before a ` +
        'build can be uploaded; create it under My Apps, or let `eas submit` create it once.'
    );
  }

  // Builds are listed per app and carry the version string (CFBundleVersion).
  // Filtering server-side keeps this correct for an app with hundreds of builds.
  const builds = await callAppStoreConnect(
    token,
    `/builds?filter[app]=${app.id}&filter[version]=${encodeURIComponent(buildNumber)}&limit=200`
  );
  if (!builds.ok) {
    throw new Error(`Could not list builds (${builds.status}): ${describeApiErrors(builds.body)}`);
  }

  const conflicting = (builds.body.data ?? []).filter(
    (build) => build.attributes?.version === buildNumber
  );

  if (conflicting.length > 0) {
    const states = conflicting
      .map((build) => build.attributes?.processingState ?? 'UNKNOWN')
      .join(', ');
    throw new Error(
      `Build number ${buildNumber} already exists on App Store Connect for ${bundleId} (state: ${states}). ` +
        'Bump ios.buildNumber in app.config.ts and rebuild; Apple will not accept a duplicate.'
    );
  }

  // Advisory only. Apple requires the build number to be unique per version
  // string, not globally increasing, so a lower number is legal after a version
  // bump and must not fail the build.
  const allBuilds = await callAppStoreConnect(token, `/builds?filter[app]=${app.id}&limit=200`);
  const registeredBuilds = allBuilds.body?.data ?? [];
  const existingNumbers = registeredBuilds
    .map((build) => Number(build.attributes?.version))
    .filter((value) => Number.isFinite(value));
  const highest = existingNumbers.length > 0 ? Math.max(...existingNumbers) : 0;

  // Deliberately worded as what was checked rather than as a verdict. "Build
  // number N is free" reads like a guarantee, and it is not one while a build can
  // still be in ingestion (see the blind spot note at the top of this file).
  process.stdout.write(
    `No registered build on App Store Connect uses build number ${buildNumber} for ${bundleId} ` +
      `version ${shortVersion ?? '(unspecified)'}.\n`
  );
  process.stdout.write(
    `Registered builds visible: ${registeredBuilds.length}` +
      `${highest ? ` (highest numeric build number ${highest})` : ''}.\n`
  );

  if (registeredBuilds.length === 0) {
    process.stdout.write(
      'Note: this app has no registered builds at all. That means either nothing has been uploaded ' +
        'yet, or an upload is still being processed and is therefore invisible to this check. A ' +
        'recently uploaded build can take well over 45 minutes to appear. The upload step is the ' +
        'authoritative check.\n'
    );
  }
}

// Guarded so the module can be imported by a test without firing a network call
// and exiting the process.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
