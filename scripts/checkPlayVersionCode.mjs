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
 * package-lock.json for a CI-only check. The sign-in and the transport live in
 * scripts/lib/playPublisher.mjs, shared with scripts/syncPlayListingImages.mjs.
 *
 * Usage:
 *   node scripts/checkPlayVersionCode.mjs \
 *     --key <service-account.json> --package <applicationId> --version-code <n>
 */
import { parseFlagPairs } from './lib/cliArguments.mjs';
import {
  createPlayRequest,
  describeMissingPackage,
  readServiceAccount,
  requestAccessToken,
} from './lib/playPublisher.mjs';

function parseArguments(argv) {
  const parsed = parseFlagPairs(argv);
  for (const required of ['key', 'package', 'version-code']) {
    if (!parsed[required]) {
      throw new Error(`Missing required argument --${required}.`);
    }
  }
  return parsed;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const versionCode = Number(options['version-code']);
  if (!Number.isInteger(versionCode) || versionCode <= 0) {
    throw new Error(`--version-code must be a positive integer, got "${options['version-code']}".`);
  }

  // The shared transport, so this preflight and the listing sync cannot drift
  // apart on how a Play response is read.
  const request = createPlayRequest(await requestAccessToken(readServiceAccount(options.key)));
  const applicationId = options.package;

  const edit = await request('POST', `/${applicationId}/edits`);
  if (!edit.ok) {
    if (edit.status === 404) {
      throw new Error(describeMissingPackage(applicationId));
    }
    throw new Error(`Could not open a Play edit (${edit.status}): ${JSON.stringify(edit.body)}`);
  }

  const editId = edit.body.id;
  try {
    const tracks = await request('GET', `/${applicationId}/edits/${editId}/tracks`);
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
    await request('DELETE', `/${applicationId}/edits/${editId}`);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
