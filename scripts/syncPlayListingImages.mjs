#!/usr/bin/env node
/**
 * Puts the committed Play listing screenshots (store/screenshots/android/) on
 * the Google Play store listing, or reports whether they are already there.
 *
 *   --mode check  commits nothing. It reports, per shelf, whether the listing
 *                 already shows the committed frames.
 *   --mode sync   replaces every shelf that differs, in listing order, and
 *                 commits. A shelf that already matches is left alone, so a
 *                 release that re-captured nothing uploads nothing.
 *
 * Run by the `listing-images` job of .github/workflows/build-android.yml after a
 * production release has committed, and on demand by
 * .github/workflows/store-listing.yml.
 *
 * WHY AFTER THE RELEASE, IN ITS OWN EDIT
 *
 * A listing change waiting in Publishing overview makes the release's own
 * commit fail with "Changes cannot be sent for review automatically". So the
 * release commits first, and the listing follows in a separate edit. Committed
 * a minute later, that edit's default review behaviour cancels the release's
 * pending review and sends both together, which is what pressing "Send for
 * review" in the Console after a hand upload did.
 *
 * WHAT DECIDES AN UPLOAD
 *
 * The listing itself, not git history. Play reports a SHA-256 for every image,
 * so a shelf is in sync when the listed hashes are the committed files' hashes
 * in the same order. That is self-healing in a way a diff against the previous
 * release tag is not: a run that failed leaves the listing stale, and the next
 * run sees it and tries again. `--force 1` replaces every shelf regardless.
 *
 * AN EDIT IS A TRANSACTION, AND A FRAGILE ONE
 *
 * Nothing here reaches the listing until the commit, so a failure at any step
 * leaves the listing exactly as it was. But opening an edit invalidates this
 * account's other open edit, and any commit invalidates every open edit, so a
 * pull request's version-code check (scripts/checkPlayVersionCode.mjs) can pull
 * this one out from under it. That is detected and the sync starts again with a
 * fresh edit. The same rule cuts the other way: never run this while a Play
 * submission is uploading, or it invalidates the release's edit.
 *
 * Editing listing graphics needs the service account to hold **Manage store
 * presence** for the app in Play Console. The release permissions do not cover
 * it, and Play has enforced permissions at the commit before.
 *
 * No dependencies. Every Play call goes through an injected `request`, so
 * tests/unit/syncPlayListingImages.test.ts drives both modes with no network.
 *
 * Usage:
 *   node scripts/syncPlayListingImages.mjs \
 *     --key <service-account.json> --package <applicationId> \
 *     --mode <check|sync> [--language en-US] [--force 1]
 */
import { appendFileSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';

import { parseFlagPairs } from './lib/cliArguments.mjs';
import { isEntrypoint } from './lib/is-entrypoint.mjs';
import { readPlayShelves } from './lib/listingFrames.mjs';
import {
  createPlayRequest,
  describeMissingPackage,
  readServiceAccount,
  requestAccessToken,
} from './lib/playPublisher.mjs';

const MODES = ['check', 'sync'];

/** Attempts at one call that answers 429 or 5xx, and the pause before each retry. */
const RETRY_DELAYS_MILLISECONDS = [2_000, 5_000, 10_000];

/**
 * @typedef {import('./lib/playPublisher.mjs').PlayRequest} PlayRequest
 * @typedef {import('./lib/playPublisher.mjs').PlayResponse} PlayResponse
 * @typedef {import('./lib/listingFrames.mjs').ListingFrame} ListingFrame
 * @typedef {{ name: string, imageType: string, directory: string, frames: ListingFrame[] }} PlayShelf
 * @typedef {{
 *   shelf: string,
 *   imageType: string,
 *   liveCount: number,
 *   committedCount: number,
 *   inSync: boolean,
 *   replaced: boolean,
 * }} ShelfReport
 * @typedef {{ mode: string, committed: boolean, shelves: ShelfReport[] }} SyncReport
 */

const noLog = () => {};

/**
 * The edit this run was working in no longer exists, or what it holds cannot be
 * trusted. Not a failure of the sync: the answer is a fresh edit.
 */
class EditLostError extends Error {}

function describeError(body) {
  if (typeof body?.error?.message === 'string') return body.error.message;
  return JSON.stringify(body);
}

/**
 * Turns a failed call into a message that names the fix.
 *
 * @param {PlayResponse} response
 * @param {string} purpose
 * @returns {string}
 */
export function describePlayFailure(response, purpose) {
  const detail = describeError(response.body);
  if (response.status === 401) {
    return `Google rejected the access token (401) while trying to ${purpose}. Detail: ${detail}`;
  }
  if (response.status === 403) {
    return (
      `Google Play refused to ${purpose} (403). Editing the store listing's images needs the service account to ` +
      'hold "Manage store presence" for this app: Play Console > Users and permissions > the play-publisher ' +
      `account > App permissions. A new grant can take up to 24 hours to apply. Detail: ${detail}`
    );
  }
  if (/changesNotSentForReview/.test(detail)) {
    return (
      `Google Play would not ${purpose}: ${detail} That means Publishing overview holds changes that have not ` +
      'been sent for review. Open Play Console > Publishing overview, send or discard them, then re-run this ' +
      'job. This script will not commit with changesNotSentForReview: it would park the listing change unsent, ' +
      "and an unsent change makes the next release's commit fail."
    );
  }
  return `Could not ${purpose} (${response.status}): ${detail}`;
}

function imagesPath(packageName, editId, language, imageType) {
  return `/${packageName}/edits/${editId}/listings/${encodeURIComponent(language)}/${imageType}`;
}

/**
 * Whether the listed images are the committed frames, in order.
 *
 * Compared on SHA-256, or SHA-1 when Play reports no SHA-256 for an image. An
 * image carrying neither cannot be compared, which reads as "differs": the cost
 * of being wrong that way is one redundant upload, and the other way is a stale
 * listing.
 *
 * @param {{ sha256?: string, sha1?: string }[]} liveImages
 * @param {ListingFrame[]} frames
 * @returns {boolean}
 */
export function listingMatchesFrames(liveImages, frames) {
  if (liveImages.length !== frames.length) return false;
  return frames.every((frame, index) => {
    const live = liveImages[index];
    if (typeof live.sha256 === 'string' && live.sha256.length > 0) return live.sha256.toLowerCase() === frame.sha256;
    if (typeof live.sha1 === 'string' && live.sha1.length > 0) return live.sha1.toLowerCase() === frame.sha1;
    return false;
  });
}

/**
 * One attempt at the whole job inside one edit. Throws EditLostError when the
 * edit has to be abandoned for a fresh one.
 */
async function runInOneEdit({ request, packageName, language, shelves, mode, force, log, sleep }) {
  /**
   * 429 and 5xx are retried. A retried upload can land twice, which the
   * read-back below catches.
   */
  const send = async (method, apiPath, upload) => {
    let response = await request(method, apiPath, upload);
    for (const pause of RETRY_DELAYS_MILLISECONDS) {
      if (response.status !== 429 && response.status < 500) break;
      await sleep(pause);
      response = await request(method, apiPath, upload);
    }
    return response;
  };

  const opened = await send('POST', `/${packageName}/edits`);
  if (!opened.ok) {
    if (opened.status === 404) {
      throw new Error(describeMissingPackage(packageName));
    }
    throw new Error(describePlayFailure(opened, 'open a Play edit'));
  }
  const editId = opened.body.id;
  const editPath = `/${packageName}/edits/${editId}`;

  /**
   * A call inside the edit. A 404 or a 409 is ambiguous: the edit may have been
   * invalidated by another edit, or the call itself may be wrong (no `en-US`
   * listing answers 404 too). Asking for the edit settles which.
   */
  const callInEdit = async (method, apiPath, upload, purpose) => {
    const response = await send(method, apiPath, upload);
    if (response.ok) return response.body ?? {};
    if (response.status === 404 || response.status === 409) {
      const edit = await send('GET', editPath);
      if (!edit.ok) {
        throw new EditLostError(`The Play edit was invalidated while trying to ${purpose} (${response.status}).`);
      }
    }
    throw new Error(describePlayFailure(response, purpose));
  };

  let committed = false;
  try {
    /** @type {ShelfReport[]} */
    const reports = [];
    for (const shelf of shelves) {
      const listed = await callInEdit(
        'GET',
        imagesPath(packageName, editId, language, shelf.imageType),
        undefined,
        `list the ${shelf.name} screenshots`
      );
      const liveImages = listed.images ?? [];
      reports.push({
        shelf: shelf.name,
        imageType: shelf.imageType,
        liveCount: liveImages.length,
        committedCount: shelf.frames.length,
        inSync: listingMatchesFrames(liveImages, shelf.frames),
        replaced: false,
      });
    }

    for (const report of reports) {
      log(
        `- ${report.shelf} (${report.imageType}): ${report.liveCount} on the listing, ${report.committedCount} ` +
          `committed: ${report.inSync ? 'in sync' : 'DIFFERS'}.`
      );
    }

    const toReplace = reports.filter((report) => force || !report.inSync);
    if (mode === 'check') {
      log(
        toReplace.length === 0
          ? 'Every shelf already shows the committed frames.'
          : `A sync would replace: ${toReplace.map((report) => report.shelf).join(', ')}.`
      );
      log('Read-only: nothing was changed.');
      return { mode, committed: false, shelves: reports };
    }
    if (toReplace.length === 0) {
      log('Every shelf already shows the committed frames. Nothing was uploaded.');
      return { mode, committed: false, shelves: reports };
    }

    let playRehashes = false;
    for (const report of toReplace) {
      const shelf = shelves.find((candidate) => candidate.name === report.shelf);
      const shelfPath = imagesPath(packageName, editId, language, shelf.imageType);
      await callInEdit('DELETE', shelfPath, undefined, `clear the ${shelf.name} screenshots`);

      // One at a time, in listing order: the upload order is the display order.
      const uploadedIds = [];
      for (const frame of shelf.frames) {
        const uploaded = await callInEdit(
          'POST',
          shelfPath,
          { bytes: frame.bytes, contentType: 'image/png' },
          `upload ${shelf.name}/${frame.fileName}`
        );
        const image = uploaded.image ?? {};
        if (!image.id) {
          throw new Error(`Play accepted ${shelf.name}/${frame.fileName} without returning an image id.`);
        }
        uploadedIds.push(image.id);
        if (typeof image.sha256 === 'string' && image.sha256.toLowerCase() !== frame.sha256) playRehashes = true;
      }

      // Verified by the ids Play handed back, not by hash: the question here is
      // "did exactly these uploads land, in this order", and a hash comparison
      // would also fail for the unrelated reason that Play re-encoded a file.
      const readBack = await callInEdit('GET', shelfPath, undefined, `read back the ${shelf.name} screenshots`);
      const listedIds = (readBack.images ?? []).map((image) => image.id);
      if (listedIds.length !== uploadedIds.length || listedIds.some((id, index) => id !== uploadedIds[index])) {
        throw new EditLostError(
          `Play lists ${listedIds.length} ${shelf.name} screenshot(s) after ${uploadedIds.length} uploads, or lists ` +
            'them in another order.'
        );
      }
      report.replaced = true;
      log(`- ${shelf.name}: replaced with ${uploadedIds.length} frames, order read back.`);
    }

    if (playRehashes) {
      log(
        'WARNING: Play reports a different SHA-256 for an uploaded frame than the file has, so it re-encodes ' +
          'uploads. The listing is correct, but an unchanged shelf will read as different and be uploaded again ' +
          'on every run.'
      );
    }

    // Through callInEdit like every other call: an edit invalidated between the
    // last write and the commit answers 404 or 409 here, and is a fresh start.
    await callInEdit('POST', `${editPath}:commit`, undefined, 'commit the listing edit');
    committed = true;
    log(
      `Committed: ${toReplace.length} shelf(s) replaced on the ${language} listing. Google reviews a listing ` +
        'change before it shows.'
    );
    return { mode, committed: true, shelves: reports };
  } finally {
    // Edits expire on their own, but leaving one open clutters the app and can
    // block a concurrent edit. Never fails the run: the outcome is already decided.
    if (!committed) {
      await request('DELETE', editPath).catch(() => undefined);
    }
  }
}

/**
 * @param {{
 *   request: PlayRequest,
 *   packageName: string,
 *   language: string,
 *   shelves: PlayShelf[],
 *   mode: string,
 *   force?: boolean,
 *   log?: (line: string) => void,
 *   sleep?: (milliseconds: number) => Promise<unknown>,
 *   maximumEditAttempts?: number,
 * }} options
 * @returns {Promise<SyncReport>}
 */
export async function syncPlayListingImages({
  request,
  packageName,
  language,
  shelves,
  mode,
  force = false,
  log = noLog,
  sleep = delay,
  maximumEditAttempts = 3,
}) {
  log(`Play listing screenshots for ${packageName} (${language}), mode ${mode}${force ? ', forced' : ''}:`);
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await runInOneEdit({ request, packageName, language, shelves, mode, force, log, sleep });
    } catch (error) {
      if (!(error instanceof EditLostError) || attempt >= maximumEditAttempts) {
        if (error instanceof EditLostError) {
          throw new Error(
            `${error.message} That happened ${attempt} times, so something keeps opening or committing Play ` +
              'edits. Is a Play submission or another listing sync running? Nothing was committed.'
          );
        }
        throw error;
      }
      log(`${error.message} Starting again with a fresh edit (attempt ${attempt + 1} of ${maximumEditAttempts}).`);
    }
  }
}

/**
 * Flag/value pairs, strictly (scripts/lib/cliArguments.mjs), then this
 * script's own modes and required arguments.
 *
 * @param {string[]} argv
 * @returns {Record<string, string>}
 */
export function parseArguments(argv) {
  const parsed = parseFlagPairs(argv);
  if (!MODES.includes(parsed.mode ?? '')) {
    throw new Error(`--mode must be check or sync, not "${parsed.mode ?? ''}".`);
  }
  for (const required of ['key', 'package']) {
    if (!parsed[required]) {
      throw new Error(`Missing required argument --${required}.`);
    }
  }
  return parsed;
}

/** @param {string} keyPath */
async function connectToPlay(keyPath) {
  return createPlayRequest(await requestAccessToken(readServiceAccount(keyPath)));
}

/**
 * The job summary gets the same lines as the log, success or not. A no-op
 * outside Actions, where there is no summary file.
 *
 * @param {string | undefined} summaryPath
 * @param {string} mode
 * @param {string[]} lines
 */
export function appendStepSummary(summaryPath, mode, lines) {
  if (!summaryPath || lines.length === 0) return;
  appendFileSync(summaryPath, `### Play listing screenshots (${mode})\n\n${lines.join('\n')}\n\n`);
}

/**
 * The command line the workflows run. Its collaborators are parameters so that
 * the tests can drive it without a key, a network or the committed frames.
 *
 * @param {string[]} argv
 * @param {{
 *   connect?: (keyPath: string) => Promise<PlayRequest>,
 *   readShelves?: () => PlayShelf[],
 *   summaryPath?: string,
 *   write?: (text: string) => void,
 *   sleep?: (milliseconds: number) => Promise<unknown>,
 * }} [dependencies]
 */
export async function main(
  argv,
  {
    connect = connectToPlay,
    readShelves = readPlayShelves,
    summaryPath = process.env.GITHUB_STEP_SUMMARY,
    write = (text) => process.stdout.write(text),
    sleep = delay,
  } = {}
) {
  const options = parseArguments(argv);
  const lines = [];
  const log = (line) => {
    lines.push(line);
    write(`${line}\n`);
  };

  try {
    // The frames are read and validated first: a bad frame should stop the run
    // before it has opened an edit, not halfway through a shelf.
    const shelves = readShelves();
    const request = await connect(options.key);
    await syncPlayListingImages({
      request,
      packageName: options.package,
      language: options.language ?? 'en-US',
      shelves,
      mode: options.mode,
      force: options.force === '1' || options.force === 'true',
      log,
      sleep,
    });
  } finally {
    appendStepSummary(summaryPath, options.mode, lines);
  }
}

if (isEntrypoint(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
