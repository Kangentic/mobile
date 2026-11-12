/**
 * Drives scripts/syncPlayListingImages.mjs against an in-memory Google Play, so
 * the listing upload is checked without a key or a network call.
 *
 * The fake is TRANSACTIONAL, like the real thing: an edit is a private copy of
 * the listing, and only a commit swaps it in. That is what lets these tests
 * assert the property that matters most ("a failure anywhere leaves the listing
 * exactly as it was") by reading the committed listing afterwards, instead of
 * by trusting that the right calls were made.
 *
 * It also reproduces the edit rule that makes this job fragile in production:
 * an edit can vanish under the run, because another edit was opened or
 * committed for the same account.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import {
  appendStepSummary,
  describePlayFailure,
  listingMatchesFrames,
  main,
  parseArguments,
  syncPlayListingImages,
} from '../../scripts/syncPlayListingImages.mjs';
import { makeFrame, type TestFrame } from '../helpers/storeListings';

const PACKAGE = 'com.example.app';
const LANGUAGE = 'en-US';

interface FakeImage {
  id: string;
  sha256?: string;
  sha1?: string;
}

type Listing = Record<string, FakeImage[]>;

interface PlayCall {
  method: string;
  path: string;
  uploaded: boolean;
}

interface PlayFailure {
  /** Matches `METHOD path` by prefix or by test. */
  when: string | ((call: PlayCall) => boolean);
  status: number;
  message?: string;
  /** How many times it fires. Default: every time. */
  times?: number;
  /** Apply the call's effect, THEN answer with the failure (a response lost on the way back). */
  afterApplying?: boolean;
}

interface PlaySeed {
  listing?: Listing;
  failures?: PlayFailure[];
  /** Called before each call is routed, with the open edits, to pull one away mid-run. */
  beforeCall?: (call: PlayCall, edits: Map<string, Listing>, callIndex: number) => void;
  /** Play reports a hash that is not the uploaded file's (it re-encoded the image). */
  rehash?: boolean;
  /** The listing language that exists. Any other answers 404, as Play does. */
  language?: string;
}

const sha256Of = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const sha1Of = (bytes: Uint8Array) => createHash('sha1').update(bytes).digest('hex');

/** How a frame already on the listing looks to Play. */
const listed = (frames: TestFrame[], prefix = 'live'): FakeImage[] =>
  frames.map((frame, index) => ({ id: `${prefix}-${index}`, sha256: frame.sha256, sha1: frame.sha1 }));

function createFakePlay(seed: PlaySeed = {}) {
  let committed: Listing = structuredClone(seed.listing ?? {});
  const edits = new Map<string, Listing>();
  const calls: PlayCall[] = [];
  const failures = (seed.failures ?? []).map((failure) => ({ ...failure, remaining: failure.times ?? Infinity }));
  let editCount = 0;
  let imageCount = 0;
  let commitCount = 0;

  const respond = (status: number, body: unknown = {}) => ({ ok: status < 300, status, body });
  const refuse = (status: number, message: string) => respond(status, { error: { code: status, message } });

  function apply(method: string, pathname: string, upload?: { bytes: Uint8Array; contentType: string }) {
    let match: RegExpMatchArray | null;
    if (method === 'POST' && pathname === `/${PACKAGE}/edits`) {
      editCount += 1;
      const editId = `edit-${editCount}`;
      edits.set(editId, structuredClone(committed));
      return respond(200, { id: editId });
    }
    if ((match = pathname.match(new RegExp(`^/${PACKAGE}/edits/([^/:]+):commit$`))) && method === 'POST') {
      const edit = edits.get(match[1]);
      if (!edit) return refuse(404, 'Edit not found.');
      committed = structuredClone(edit);
      // Any commit invalidates every open edit, this one included.
      edits.clear();
      commitCount += 1;
      return respond(200, { id: match[1] });
    }
    if ((match = pathname.match(new RegExp(`^/${PACKAGE}/edits/([^/:]+)$`)))) {
      if (!edits.has(match[1])) return refuse(404, 'Edit not found.');
      if (method === 'DELETE') {
        edits.delete(match[1]);
        return respond(204);
      }
      return respond(200, { id: match[1] });
    }
    if ((match = pathname.match(new RegExp(`^/${PACKAGE}/edits/([^/]+)/listings/([^/]+)/([^/]+)$`)))) {
      const edit = edits.get(match[1]);
      if (!edit) return refuse(404, 'Edit not found.');
      if (decodeURIComponent(match[2]) !== (seed.language ?? LANGUAGE)) return refuse(404, 'Listing not found.');
      const imageType = match[3];
      edit[imageType] ??= [];
      if (method === 'GET') return respond(200, { images: edit[imageType] });
      if (method === 'DELETE') {
        const deleted = edit[imageType];
        edit[imageType] = [];
        return respond(200, { deleted });
      }
      if (method === 'POST' && upload) {
        imageCount += 1;
        const image: FakeImage = {
          id: `image-${imageCount}`,
          sha256: seed.rehash ? sha256Of(Buffer.from(`re-encoded ${imageCount}`)) : sha256Of(upload.bytes),
          sha1: sha1Of(upload.bytes),
        };
        edit[imageType].push(image);
        return respond(200, { image });
      }
    }
    return refuse(404, `Not routed by the fake: ${method} ${pathname}`);
  }

  async function request(method: string, apiPath: string, upload?: { bytes: Uint8Array; contentType: string }) {
    const call: PlayCall = { method, path: apiPath, uploaded: upload !== undefined };
    calls.push(call);
    seed.beforeCall?.(call, edits, calls.length);

    const failure = failures.find(
      (candidate) =>
        candidate.remaining > 0 &&
        (typeof candidate.when === 'string' ? `${method} ${apiPath}`.startsWith(candidate.when) : candidate.when(call))
    );
    if (failure) {
      failure.remaining -= 1;
      if (failure.afterApplying) apply(method, apiPath, upload);
      return refuse(failure.status, failure.message ?? `Injected ${failure.status}.`);
    }
    return apply(method, apiPath, upload);
  }

  return {
    request,
    calls,
    edits,
    committedListing: () => committed,
    commitCount: () => commitCount,
    editCount: () => editCount,
  };
}

/** Three shelves, three frames each, every frame distinct. */
function makeShelves(generation = 0) {
  const shelf = (name: string, imageType: string, offset: number) => ({
    name,
    imageType,
    directory: `store/screenshots/android/${name}`,
    frames: ['01-agents', '02-board', '03-session-terminal'].map((shotName, index) =>
      makeFrame(shotName, { payloadBytes: 20 + offset + index + generation * 50, fill: generation })
    ),
  });
  return [
    shelf('phone', 'phoneScreenshots', 0),
    shelf('seven-inch', 'sevenInchScreenshots', 10),
    shelf('ten-inch', 'tenInchScreenshots', 20),
  ];
}

const listingOf = (shelves: ReturnType<typeof makeShelves>): Listing =>
  Object.fromEntries(shelves.map((shelf) => [shelf.imageType, listed(shelf.frames, shelf.name)]));

const hashesOn = (listing: Listing, imageType: string) => (listing[imageType] ?? []).map((image) => image.sha256);
const hashesOf = (frames: TestFrame[]) => frames.map((frame) => frame.sha256);

const noWait = async () => undefined;
const isUpload = (call: PlayCall) => call.method === 'POST' && call.uploaded;
const isClear = (call: PlayCall) => call.method === 'DELETE' && call.path.includes('/listings/');
const isCommit = (call: PlayCall) => call.path.endsWith(':commit');

function run(fake: ReturnType<typeof createFakePlay>, shelves: ReturnType<typeof makeShelves>, overrides = {}) {
  const logged: string[] = [];
  const promise = syncPlayListingImages({
    request: fake.request,
    packageName: PACKAGE,
    language: LANGUAGE,
    shelves,
    mode: 'sync',
    log: (line: string) => logged.push(line),
    sleep: noWait,
    ...overrides,
  });
  return { promise, logged };
}

describe('syncPlayListingImages: sync', () => {
  it('replaces every shelf that differs, in listing order, and commits once', async () => {
    const old = makeShelves(1);
    const shelves = makeShelves();
    const fake = createFakePlay({ listing: listingOf(old) });
    const { promise, logged } = run(fake, shelves);
    const report = await promise;

    for (const shelf of shelves) {
      expect(hashesOn(fake.committedListing(), shelf.imageType)).toEqual(hashesOf(shelf.frames));
    }
    expect(fake.commitCount()).toBe(1);
    expect(report.committed).toBe(true);
    expect(report.shelves.map((shelf) => shelf.replaced)).toEqual([true, true, true]);
    expect(logged.join('\n')).toMatch(/Committed: 3 shelf\(s\) replaced/);
    // A committed edit is gone; deleting it afterwards would be a 404 at best.
    expect(fake.calls.at(-1)?.path).toMatch(/:commit$/);
  });

  it('uploads each shelf in the order of its frames, never sorted or shuffled', async () => {
    // Upload order IS display order. The frames here are deliberately in an
    // order no sort would produce, so only "the order given" passes.
    const shelves = makeShelves();
    shelves[0].frames = [shelves[0].frames[2], shelves[0].frames[0], shelves[0].frames[1]];
    const fake = createFakePlay();
    await run(fake, shelves).promise;

    expect(hashesOn(fake.committedListing(), 'phoneScreenshots')).toEqual(hashesOf(shelves[0].frames));
  });

  it('treats the same frames in another order as a difference, and fixes the order', async () => {
    const shelves = makeShelves();
    const reversed = listed([...shelves[0].frames].reverse());
    const fake = createFakePlay({ listing: { ...listingOf(shelves), phoneScreenshots: reversed } });
    const report = await run(fake, shelves).promise;

    expect(report.shelves.map((shelf) => shelf.inSync)).toEqual([false, true, true]);
    expect(hashesOn(fake.committedListing(), 'phoneScreenshots')).toEqual(hashesOf(shelves[0].frames));
  });

  it('writes nothing when every shelf already shows the committed frames', async () => {
    const shelves = makeShelves();
    const fake = createFakePlay({ listing: listingOf(shelves) });
    const before = structuredClone(fake.committedListing());
    const { promise, logged } = run(fake, shelves);
    const report = await promise;

    expect(report.committed).toBe(false);
    expect(fake.calls.filter((call) => isUpload(call) || isClear(call) || isCommit(call))).toEqual([]);
    expect(fake.committedListing()).toEqual(before);
    // The edit it opened to look is closed again.
    expect(fake.edits.size).toBe(0);
    expect(logged.join('\n')).toMatch(/Nothing was uploaded/);
  });

  it('leaves a shelf that matches alone when another differs', async () => {
    const shelves = makeShelves();
    const fake = createFakePlay({ listing: { ...listingOf(shelves), tenInchScreenshots: listed(makeShelves(1)[2].frames) } });
    const unchangedIds = fake.committedListing().phoneScreenshots.map((image) => image.id);
    await run(fake, shelves).promise;

    const clears = fake.calls.filter(isClear);
    expect(clears).toHaveLength(1);
    expect(clears[0].path).toContain('tenInchScreenshots');
    expect(fake.calls.filter(isUpload).every((call) => call.path.includes('tenInchScreenshots'))).toBe(true);
    // Same image ids as before: the phone shelf was not re-uploaded.
    expect(fake.committedListing().phoneScreenshots.map((image) => image.id)).toEqual(unchangedIds);
    expect(hashesOn(fake.committedListing(), 'tenInchScreenshots')).toEqual(hashesOf(shelves[2].frames));
  });

  it('replaces every shelf when forced, even with nothing to change', async () => {
    const shelves = makeShelves();
    const fake = createFakePlay({ listing: listingOf(shelves) });
    const report = await run(fake, shelves, { force: true }).promise;

    expect(fake.calls.filter(isClear)).toHaveLength(3);
    expect(fake.calls.filter(isUpload)).toHaveLength(9);
    expect(report.committed).toBe(true);
  });

  it('compares on SHA-1 when Play reports no SHA-256 for an image', async () => {
    const shelves = makeShelves();
    const sha1Only: Listing = Object.fromEntries(
      shelves.map((shelf) => [shelf.imageType, shelf.frames.map((frame, index) => ({ id: `old-${index}`, sha1: frame.sha1 }))])
    );
    const fake = createFakePlay({ listing: sha1Only });
    const report = await run(fake, shelves).promise;

    expect(report.shelves.every((shelf) => shelf.inSync)).toBe(true);
    expect(report.committed).toBe(false);
  });

  it('says so when Play re-encodes uploads, and still commits', async () => {
    // The listing is right either way. What is lost is idempotency: the hashes
    // will never match, so every run re-uploads. Worth a loud line, not a failure.
    const shelves = makeShelves();
    const fake = createFakePlay({ rehash: true });
    const { promise, logged } = run(fake, shelves);
    const report = await promise;

    expect(report.committed).toBe(true);
    expect(logged.join('\n')).toMatch(/WARNING: Play reports a different SHA-256/);
  });
});

describe('syncPlayListingImages: check', () => {
  it('reports what differs and changes nothing', async () => {
    const shelves = makeShelves();
    const fake = createFakePlay({ listing: listingOf(makeShelves(1)) });
    const before = structuredClone(fake.committedListing());
    const { promise, logged } = run(fake, shelves, { mode: 'check' });
    const report = await promise;

    expect(report.committed).toBe(false);
    expect(report.shelves.map((shelf) => shelf.inSync)).toEqual([false, false, false]);
    expect(fake.committedListing()).toEqual(before);
    // The only writes are the edit it opens to look and then deletes.
    expect(fake.calls.filter((call) => call.method !== 'GET').map((call) => `${call.method} ${call.path}`)).toEqual([
      `POST /${PACKAGE}/edits`,
      `DELETE /${PACKAGE}/edits/edit-1`,
    ]);
    expect(logged.join('\n')).toMatch(/A sync would replace: phone, seven-inch, ten-inch\./);
    expect(logged.at(-1)).toBe('Read-only: nothing was changed.');
  });

  it('reports a current listing as current', async () => {
    const shelves = makeShelves();
    const fake = createFakePlay({ listing: listingOf(shelves) });
    const { promise, logged } = run(fake, shelves, { mode: 'check' });
    await promise;
    expect(logged.join('\n')).toMatch(/Every shelf already shows the committed frames\./);
  });
});

describe('syncPlayListingImages: a failure leaves the listing as it was', () => {
  it('commits nothing when an upload is refused halfway through a shelf', async () => {
    // By the second upload the shelf has been cleared and holds one new frame.
    // That half-replaced shelf exists only inside the edit, and must die with it.
    const shelves = makeShelves();
    let uploads = 0;
    const fake = createFakePlay({
      listing: listingOf(makeShelves(1)),
      failures: [
        {
          when: (call) => isUpload(call) && (uploads += 1) === 2,
          status: 400,
          message: 'Image is too small.',
        },
      ],
    });
    const before = structuredClone(fake.committedListing());
    await expect(run(fake, shelves).promise).rejects.toThrow(/Image is too small/);

    expect(fake.calls.filter(isClear)).toHaveLength(1);
    expect(fake.committedListing()).toEqual(before);
    expect(fake.commitCount()).toBe(0);
    // The edit holding the half-replaced shelf was deleted, not left open.
    expect(fake.edits.size).toBe(0);
  });

  it('names the permission when Play answers 403 to a listing change', async () => {
    const fake = createFakePlay({ failures: [{ when: `DELETE /${PACKAGE}/edits/edit-1/listings`, status: 403 }] });
    await expect(run(fake, makeShelves()).promise).rejects.toThrow(/Manage store presence/);
    expect(fake.commitCount()).toBe(0);
  });

  it('names the permission when the 403 only arrives at the commit', async () => {
    // Play has enforced a missing permission at commit, not at the calls
    // before it (the first production release, 2026-10-08).
    const fake = createFakePlay({ failures: [{ when: (call) => isCommit(call), status: 403 }] });
    await expect(run(fake, makeShelves()).promise).rejects.toThrow(/Manage store presence/);
    expect(fake.committedListing()).toEqual({});
    expect(fake.edits.size).toBe(0);
  });

  it('stops on unsent changes, and never commits with changesNotSentForReview', async () => {
    // Retrying with the flag would "work": the listing change would be parked
    // unsent in Publishing overview, and an unsent change is exactly what makes
    // the NEXT release's commit fail.
    const fake = createFakePlay({
      failures: [
        {
          when: (call) => isCommit(call),
          status: 400,
          message: 'Changes cannot be sent for review automatically. Please set the query parameter changesNotSentForReview to true.',
        },
      ],
    });
    await expect(run(fake, makeShelves()).promise).rejects.toThrow(/Publishing overview/);

    expect(fake.calls.filter(isCommit)).toHaveLength(1);
    expect(fake.calls.some((call) => call.path.includes('changesNotSentForReview'))).toBe(false);
    expect(fake.commitCount()).toBe(0);
  });

  it('reports a missing listing as itself, not as a lost edit', async () => {
    // No en-US listing answers 404, the same status as a vanished edit. The edit
    // is still there, so this is a real error and restarting would loop.
    const fake = createFakePlay({ language: 'de-DE' });
    await expect(run(fake, makeShelves()).promise).rejects.toThrow(/list the phone screenshots \(404\)/);
    expect(fake.editCount()).toBe(1);
  });
});

describe('syncPlayListingImages: an edit pulled out from under the run', () => {
  it('starts again with a fresh edit, and finishes', async () => {
    // A pull request's version-code check opens its own edit for the same
    // service account, which invalidates this one.
    const shelves = makeShelves();
    let pulled = false;
    const fake = createFakePlay({
      beforeCall: (call, edits) => {
        if (!pulled && isUpload(call)) {
          pulled = true;
          edits.clear();
        }
      },
    });
    const { promise, logged } = run(fake, shelves);
    const report = await promise;

    expect(fake.editCount()).toBe(2);
    expect(report.committed).toBe(true);
    for (const shelf of shelves) {
      expect(hashesOn(fake.committedListing(), shelf.imageType)).toEqual(hashesOf(shelf.frames));
    }
    expect(logged.join('\n')).toMatch(/Starting again with a fresh edit \(attempt 2 of 3\)/);
  });

  it('gives up after three edits, having committed nothing', async () => {
    const fake = createFakePlay({
      beforeCall: (call, edits) => {
        if (isUpload(call)) edits.clear();
      },
    });
    await expect(run(fake, makeShelves()).promise).rejects.toThrow(/3 times.*Nothing was committed/s);
    expect(fake.editCount()).toBe(3);
    expect(fake.commitCount()).toBe(0);
  });

  it('starts again when the edit is invalidated at the commit itself', async () => {
    // Another edit opened between the last write and the commit is the failure
    // the script exists to survive. The commit answers 404 and so does the edit,
    // so it is a lost edit and a fresh start, not a hard failure.
    const shelves = makeShelves();
    let pulled = false;
    const fake = createFakePlay({
      listing: listingOf(makeShelves(1)),
      beforeCall: (call, edits) => {
        if (!pulled && isCommit(call)) {
          pulled = true;
          edits.clear();
        }
      },
    });
    const { promise, logged } = run(fake, shelves);
    const report = await promise;

    expect(report.committed).toBe(true);
    expect(fake.editCount()).toBe(2);
    expect(fake.commitCount()).toBe(1);
    for (const shelf of shelves) {
      expect(hashesOn(fake.committedListing(), shelf.imageType)).toEqual(hashesOf(shelf.frames));
    }
    const lostIndex = logged.findIndex((line) => /invalidated while trying to commit the listing edit/.test(line));
    expect(lostIndex).toBeGreaterThanOrEqual(0);
    expect(logged[lostIndex]).toMatch(/Starting again with a fresh edit \(attempt 2 of 3\)/);
  });

  it('reports a commit refused with 409 as itself when the edit still exists, and does not start again', async () => {
    // A 409 is as ambiguous as a 404. The edit is still there, so the commit
    // itself was refused and a fresh edit would only be refused the same way.
    const fake = createFakePlay({
      failures: [{ when: (call) => isCommit(call), status: 409, message: 'Conflict.' }],
    });
    const { promise, logged } = run(fake, makeShelves());
    await expect(promise).rejects.toThrow(/Could not commit the listing edit \(409\)/);

    expect(fake.editCount()).toBe(1);
    expect(fake.calls.filter(isCommit)).toHaveLength(1);
    expect(fake.commitCount()).toBe(0);
    expect(fake.committedListing()).toEqual({});
    expect(logged.some((line) => /Starting again/.test(line))).toBe(false);
  });

  it('starts again when an upload landed twice, so the listing never gets a duplicate frame', async () => {
    // A 503 whose request DID apply: the retry uploads the same frame again.
    // Read back by id, the shelf holds four images after three uploads.
    const shelves = makeShelves();
    const fake = createFakePlay({
      failures: [{ when: (call) => isUpload(call), status: 503, times: 1, afterApplying: true }],
    });
    const report = await run(fake, shelves).promise;

    expect(fake.editCount()).toBe(2);
    expect(report.committed).toBe(true);
    expect(fake.committedListing().phoneScreenshots).toHaveLength(3);
    expect(hashesOn(fake.committedListing(), 'phoneScreenshots')).toEqual(hashesOf(shelves[0].frames));
  });
});

describe('syncPlayListingImages: transient errors', () => {
  it('retries a 503, pausing first', async () => {
    const shelves = makeShelves();
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const fake = createFakePlay({
      listing: listingOf(shelves),
      failures: [{ when: `GET /${PACKAGE}/edits/edit-1/listings`, status: 503, times: 2 }],
    });
    const report = await run(fake, shelves, { sleep }).promise;

    expect(report.shelves.every((shelf) => shelf.inSync)).toBe(true);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep.mock.calls[0][0]).toBeGreaterThan(0);
  });

  it('gives up on a 503 that does not clear', async () => {
    const fake = createFakePlay({ failures: [{ when: `POST /${PACKAGE}/edits`, status: 503 }] });
    await expect(run(fake, makeShelves()).promise).rejects.toThrow(/open a Play edit \(503\)/);
  });

  it('explains a package Play has never seen', async () => {
    const fake = createFakePlay({ failures: [{ when: `POST /${PACKAGE}/edits`, status: 404 }] });
    await expect(run(fake, makeShelves()).promise).rejects.toThrow(/uploaded by hand through the Play Console/);
  });
});

describe('listingMatchesFrames', () => {
  const frames = [makeFrame('a', { payloadBytes: 10 }), makeFrame('b', { payloadBytes: 11 })];

  it('needs the same count, the same hashes and the same order', () => {
    expect(listingMatchesFrames(listed(frames), frames)).toBe(true);
    expect(listingMatchesFrames(listed(frames).slice(0, 1), frames)).toBe(false);
    expect(listingMatchesFrames(listed([...frames].reverse()), frames)).toBe(false);
  });

  it('ignores the case of the hash Play reports', () => {
    const upperCased = frames.map((frame, index) => ({ id: `x-${index}`, sha256: frame.sha256.toUpperCase() }));
    expect(listingMatchesFrames(upperCased, frames)).toBe(true);
  });

  it('reads an image with no hash as different', () => {
    expect(listingMatchesFrames([{ id: 'x-0' }, { id: 'x-1' }] as FakeImage[], frames)).toBe(false);
  });
});

describe('describePlayFailure', () => {
  it('passes Google\'s own message through for anything else', () => {
    expect(describePlayFailure({ ok: false, status: 400, body: { error: { message: 'Bad image.' } } }, 'upload it')).toBe(
      'Could not upload it (400): Bad image.'
    );
  });
});

describe('syncPlayListingImages.mjs command line', () => {
  const credentials = ['--key', 'key.json', '--package', PACKAGE];

  it('requires a mode it knows, the key and the package', () => {
    expect(parseArguments([...credentials, '--mode', 'check']).mode).toBe('check');
    expect(() => parseArguments([...credentials, '--mode', 'upload'])).toThrow(/check or sync/);
    expect(() => parseArguments(credentials)).toThrow(/check or sync/);
    expect(() => parseArguments(['--key', 'key.json', '--mode', 'sync'])).toThrow(/--package/);
    // Strict pairs: a bare flag would otherwise swallow the next flag as its value.
    expect(() => parseArguments([...credentials, '--mode'])).toThrow(/Malformed argument/);
  });

  it('appends the report to the job summary, and does nothing outside Actions', () => {
    const summaryPath = join(mkdtempSync(join(tmpdir(), 'play-summary-')), 'summary.md');
    writeFileSync(summaryPath, '');
    appendStepSummary(summaryPath, 'sync', ['- phone: replaced']);
    expect(readFileSync(summaryPath, 'utf8')).toBe('### Play listing screenshots (sync)\n\n- phone: replaced\n\n');
    expect(() => appendStepSummary(undefined, 'sync', ['ignored'])).not.toThrow();
  });

  describe('main', () => {
    // Every case passes an explicit summaryPath. The default is
    // process.env.GITHUB_STEP_SUMMARY, which IS set when CI runs this file.
    function createHarness(seed: PlaySeed = {}) {
      const summaryPath = join(mkdtempSync(join(tmpdir(), 'play-main-')), 'summary.md');
      writeFileSync(summaryPath, '');
      const fake = createFakePlay(seed);
      const shelves = makeShelves();
      const connect = vi.fn(async (_keyPath: string) => fake.request);
      const written: string[] = [];
      return {
        fake,
        shelves,
        connect,
        written,
        readSummary: () => readFileSync(summaryPath, 'utf8'),
        dependencies: {
          connect,
          readShelves: () => shelves,
          summaryPath,
          write: (text: string) => {
            written.push(text);
          },
          sleep: noWait,
        },
      };
    }

    it('sync: signs in with the key, uploads to the en-US listing by default, and writes the summary', async () => {
      const harness = createHarness();
      await main([...credentials, '--mode', 'sync'], harness.dependencies);

      expect(harness.connect).toHaveBeenCalledWith('key.json');
      expect(harness.fake.commitCount()).toBe(1);
      expect(harness.fake.calls.some((call) => call.path.includes('/listings/en-US/'))).toBe(true);
      expect(harness.readSummary()).toContain('### Play listing screenshots (sync)\n\n');
      expect(harness.written.join('')).toContain('Committed: 3 shelf(s) replaced');
    });

    it('check: commits nothing', async () => {
      const harness = createHarness();
      await main([...credentials, '--mode', 'check'], harness.dependencies);
      expect(harness.fake.commitCount()).toBe(0);
      expect(harness.readSummary()).toContain('### Play listing screenshots (check)\n\n');
    });

    it('passes --force through', async () => {
      // The listing is already current, so only the flag can cause a commit.
      const unforced = createHarness({ listing: listingOf(makeShelves()) });
      await main([...credentials, '--mode', 'sync'], unforced.dependencies);
      expect(unforced.fake.commitCount()).toBe(0);

      const forced = createHarness({ listing: listingOf(makeShelves()) });
      await main([...credentials, '--mode', 'sync', '--force', '1'], forced.dependencies);
      expect(forced.fake.commitCount()).toBe(1);
    });

    it('reads the frames before it signs in, so a bad frame costs no edit', async () => {
      const harness = createHarness();
      const failing = {
        ...harness.dependencies,
        readShelves: () => {
          throw new Error('The listing frames in store/screenshots/android/phone cannot be uploaded: 02-board.png is missing.');
        },
      };
      await expect(main([...credentials, '--mode', 'sync'], failing)).rejects.toThrow(/02-board\.png is missing/);
      expect(harness.connect).not.toHaveBeenCalled();
      expect(harness.fake.calls).toEqual([]);
    });

    it('still appends what was logged to the job summary when the sync fails', async () => {
      const harness = createHarness({ failures: [{ when: (call) => isCommit(call), status: 403 }] });
      await expect(main([...credentials, '--mode', 'sync'], harness.dependencies)).rejects.toThrow(/Manage store presence/);
      expect(harness.readSummary()).toContain('- phone (phoneScreenshots): 0 on the listing, 3 committed: DIFFERS.');
    });
  });
});
