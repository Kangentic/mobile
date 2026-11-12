/**
 * scripts/lib/appStoreScreenshots.mjs against an in-memory App Asset Library
 * (tests/helpers/storeListings.ts), so the App Store listing upload is checked
 * without a key or a network call.
 *
 * This path cannot be exercised for real until a release: App Store Connect only
 * lets a version's screenshots change before it is submitted, and between
 * releases no such version exists. So these tests carry more weight than usual,
 * and they are written against outcomes the fake holds (what the localization
 * shows afterwards, in what order, and what state the library is in) rather
 * than against the calls that were made.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  describeScreenshotPlan,
  planScreenshotSync,
  readLegacyScreenshotSets,
  readLibraryImages,
  readScreenshotPlacements,
  readScreenshotTarget,
  referenceHash,
  referenceNameFor,
  resolveScreenshotGroup,
  syncScreenshots,
  uploadPartWithFetch,
} from '../../scripts/lib/appStoreScreenshots.mjs';
import {
  FRAME_HEIGHT,
  FRAME_WIDTH,
  LIBRARY_ID,
  SCREENSHOT_GROUP,
  appleReferenceData,
  createFakeAssetLibrary,
  libraryWrites,
  makeFrame,
  makeListingFrames,
  placedFrames,
  referenceNameOf,
  type AssetLibrarySeed,
  type FakeAssetLibrary,
  type TestFrame,
} from '../helpers/storeListings';

const LOCALIZATION = 'localization-en';
const noWait = async () => undefined;

interface TestImage {
  id: string;
  referenceName: string | null;
  fileSize: number | null;
  fileName: string | null;
  state: string | null;
}

/** A placement as the library module reads one. */
const placement = (id: string, image: Partial<TestImage> | null) => ({
  id,
  group: SCREENSHOT_GROUP,
  state: 'ACTIVE',
  image: image ? { id: `image-of-${id}`, referenceName: null, fileSize: null, fileName: null, state: 'APPROVED', ...image } : null,
});

const byHash = (frames: TestFrame[]) =>
  frames.map((frame, index) => placement(`placement-${index}`, { referenceName: referenceNameOf(frame) }));
const bySize = (frames: TestFrame[]) =>
  frames.map((frame, index) => placement(`placement-${index}`, { fileSize: frame.byteLength }));

function sync(library: FakeAssetLibrary, frames: TestFrame[], overrides: Record<string, unknown> = {}) {
  const logged: string[] = [];
  const promise = syncScreenshots({
    request: library.request,
    uploadPart: library.uploadPart,
    libraryId: LIBRARY_ID,
    localizationId: LOCALIZATION,
    group: SCREENSHOT_GROUP,
    maxCount: 10,
    frames,
    log: (line: string) => logged.push(line),
    sleep: noWait,
    ...overrides,
  });
  return { promise, logged };
}

const isPlacementWrite = (call: { method: string; path: string }) =>
  call.method !== 'GET' && call.path.startsWith('/appAssetLibraryPlacement');

describe('resolveScreenshotGroup', () => {
  it('resolves the frame size to its placement group and cap from Apple\'s reference data', () => {
    expect(resolveScreenshotGroup(appleReferenceData({ maxCount: 10 }), FRAME_WIDTH, FRAME_HEIGHT)).toEqual({
      group: SCREENSHOT_GROUP,
      maxCount: 10,
    });
  });

  it('reads the single-resource shape as well as the collection', () => {
    const collection = appleReferenceData();
    expect(resolveScreenshotGroup({ data: collection.data[0] }, FRAME_WIDTH, FRAME_HEIGHT).group).toBe(SCREENSHOT_GROUP);
  });

  it('refuses a size Apple lists no screenshot specification for', () => {
    expect(() => resolveScreenshotGroup(appleReferenceData(), 1000, 1000)).toThrow(/no screenshot specification for 1000x1000/);
  });

  it('refuses to choose between two groups that both take the size', () => {
    const referenceData = appleReferenceData();
    const attributes = referenceData.data[0].attributes;
    attributes.placementTypes[0].specMappings.push({ placementGroupId: 'IPHONE_OTHER_PROFILE', specs: ['spec-iphone'] });
    attributes.features[0].placementPolicies[0].groupLimits[0].groupIds.push('IPHONE_OTHER_PROFILE');
    expect(() => resolveScreenshotGroup(referenceData, FRAME_WIDTH, FRAME_HEIGHT)).toThrow(
      /more than one placement group \(IPHONE_DYNAMIC_ISLAND_LARGE_PROFILE, IPHONE_OTHER_PROFILE\)/
    );
  });

  it('ignores a group an App Store version does not take', () => {
    // The same specification can be mapped for a surface this script never
    // writes to. Only the groups in the APP_STORE_VERSIONS policy count.
    const referenceData = appleReferenceData();
    referenceData.data[0].attributes.placementTypes[0].specMappings.push({
      placementGroupId: 'CUSTOM_PAGE_ONLY_PROFILE',
      specs: ['spec-iphone'],
    });
    expect(resolveScreenshotGroup(referenceData, FRAME_WIDTH, FRAME_HEIGHT).group).toBe(SCREENSHOT_GROUP);
  });

  it('says so when the reference data is empty', () => {
    expect(() => resolveScreenshotGroup({ data: [] }, FRAME_WIDTH, FRAME_HEIGHT)).toThrow(/no asset library reference data/);
  });
});

describe('the reference name', () => {
  const frame = makeFrame('02-board');

  it('carries the shot name for a person and a hash prefix for the match', () => {
    expect(referenceNameFor(frame)).toBe(`02-board ${frame.sha256.slice(0, 16)}`);
    expect(referenceHash(referenceNameFor(frame))).toBe(frame.sha256.slice(0, 16));
  });

  it.each([
    ['a name typed in Media Manager', 'Menu screen'],
    ['a file name', '02-board.png'],
    ['a shorter hex suffix', '02-board 0123abcd'],
    ['hex that is part of a longer word', '02-board x0123456789abcdef'],
    ['nothing', null],
  ])('reads %s as not ours', (_label, referenceName) => {
    expect(referenceHash(referenceName)).toBeNull();
  });
});

describe('planScreenshotSync', () => {
  const frames = makeListingFrames();

  it('is in sync when the placements carry the frames\' hashes in listing order', () => {
    const plan = planScreenshotSync(frames, byHash(frames));
    expect(plan).toMatchObject({ inSync: true, evidence: 'hash', stale: [] });
  });

  it('recognises frames uploaded by hand by their exact byte length', () => {
    // No hash in the name: this is what a Media Manager upload looks like.
    const plan = planScreenshotSync(frames, bySize(frames));
    expect(plan).toMatchObject({ inSync: true, evidence: 'size' });
  });

  it('says when it matched some frames each way', () => {
    const mixed = [...byHash(frames).slice(0, 3), ...bySize(frames).slice(3)];
    expect(planScreenshotSync(frames, mixed).evidence).toBe('mixed');
  });

  it('is not in sync when the right frames are in the wrong order', () => {
    // The order is what the store displays. Every frame has a placement and
    // nothing is stale, so only the position check can catch this.
    const swapped = byHash(frames);
    [swapped[1], swapped[4]] = [swapped[4], swapped[1]];
    const plan = planScreenshotSync(frames, swapped);
    expect(plan.inSync).toBe(false);
    expect(plan.stale).toEqual([]);
    expect(plan.slots.every((slot) => slot.placement !== null)).toBe(true);
  });

  it('keeps what matches and names what does not, when some frames were re-captured', () => {
    const recaptured = makeListingFrames(1);
    const current = [frames[0], recaptured[1], frames[2], frames[3], recaptured[4], frames[5], frames[6]];
    const plan = planScreenshotSync(current, byHash(frames));

    expect(plan.inSync).toBe(false);
    expect(plan.slots.filter((slot) => slot.placement === null).map((slot) => slot.frame.name)).toEqual([
      '02-board',
      '05-session-changes',
    ]);
    expect(plan.stale.map((stale) => stale.id)).toEqual(['placement-1', 'placement-4']);
  });

  it('is not in sync with one screenshot too many', () => {
    const extra = [...byHash(frames), placement('placement-extra', { fileSize: 999_999 })];
    const plan = planScreenshotSync(frames, extra);
    expect(plan.inSync).toBe(false);
    expect(plan.stale.map((stale) => stale.id)).toEqual(['placement-extra']);
  });

  it('does not let a size match override a name that carries a different hash', () => {
    // An earlier capture of the same screen that happens to be the same length.
    // The hash says it is another frame, and the hash is the stronger statement.
    const earlier = { ...frames[0], sha256: 'f'.repeat(64) };
    const plan = planScreenshotSync(
      [frames[0]],
      [placement('placement-0', { referenceName: referenceNameOf(earlier), fileSize: frames[0].byteLength })]
    );
    expect(plan.inSync).toBe(false);
  });

  it('reads a placement whose image details did not come back as not matching', () => {
    expect(planScreenshotSync([frames[0]], [placement('placement-0', null)]).inSync).toBe(false);
  });

  it('reuses a library image that already carries a frame\'s hash, and nothing unusable', () => {
    const [first, second, third] = frames;
    const libraryImage = (id: string, frame: TestFrame, state: string): TestImage => ({
      id,
      referenceName: referenceNameOf(frame),
      fileSize: frame.byteLength,
      fileName: frame.fileName,
      state,
    });
    const plan = planScreenshotSync([first, second, third], [], [
      libraryImage('ready', first, 'PREPARE_FOR_SUBMISSION'),
      libraryImage('never-uploaded', second, 'AWAITING_UPLOAD'),
      libraryImage('retired', third, 'ARCHIVED'),
    ]);

    expect(plan.slots.map((slot) => slot.reuseImage?.id ?? null)).toEqual(['ready', null, null]);
    // Only a reservation a dead run left behind is ever cleaned up. An archived
    // image is somebody's decision and is left alone.
    expect(plan.abandoned.map((image) => image.id)).toEqual(['never-uploaded']);
  });
});

describe('describeScreenshotPlan', () => {
  const frames = makeListingFrames();

  it('says how an in-sync listing was matched', () => {
    expect(describeScreenshotPlan(planScreenshotSync(frames, byHash(frames)), 7)).toBe(
      '7 screenshot(s), in sync with the committed frames (matched by content hash)'
    );
    expect(describeScreenshotPlan(planScreenshotSync(frames, bySize(frames)), 7)).toMatch(/uploaded by hand/);
  });

  it('names the frames that are missing and counts the ones that do not belong', () => {
    const line = describeScreenshotPlan(planScreenshotSync(frames, byHash(makeListingFrames(1))), 7);
    expect(line).toMatch(/DIFFERS from the committed frames: 7 committed frame\(s\) not on the listing \(01-agents\.png, /);
    expect(line).toMatch(/7 screenshot\(s\) on the listing that are not committed frames/);
  });

  it('says so when only the order is wrong', () => {
    expect(describeScreenshotPlan(planScreenshotSync(frames, byHash(frames).reverse()), 7)).toMatch(/DIFFERENT ORDER/);
  });
});

describe('the reads', () => {
  it('finds the library and resolves the group, sending no limit to the reference data', async () => {
    // The fake answers a `limit` on the reference data with a 400, as Apple does.
    const library = createFakeAssetLibrary({ maxCount: 10 });
    const target = await readScreenshotTarget({ request: library.request, appId: 'app-1', frames: makeListingFrames() });
    expect(target).toEqual({ libraryId: LIBRARY_ID, group: SCREENSHOT_GROUP, maxCount: 10 });
    expect(library.calls.map((call) => call.path)).toEqual([
      '/apps/app-1/assetLibrary',
      '/appAssetLibraryRefData?filter[features]=APP_STORE_VERSIONS',
    ]);
  });

  it('reads placements in display order with the image each shows', async () => {
    const frames = makeListingFrames();
    const library = createFakeAssetLibrary(placedFrames(frames, { localizationId: LOCALIZATION, by: 'hash' }));
    const placements = await readScreenshotPlacements({
      request: library.request,
      localizationId: LOCALIZATION,
      group: SCREENSHOT_GROUP,
    });
    expect(placements.map((entry) => entry.image?.referenceName)).toEqual(frames.map(referenceNameOf));
    expect(placements[0]).toMatchObject({ group: SCREENSHOT_GROUP, image: { fileSize: frames[0].byteLength } });
    expect(library.calls[0].path).toContain('sort=placementGroupPosition');
    expect(library.calls[0].path).toContain(`filter[placementGroup]=${SCREENSHOT_GROUP}`);
  });

  it('follows the next link across pages, as a path relative to the API base', async () => {
    const paths: string[] = [];
    const request = async (_method: string, apiPath: string) => {
      paths.push(apiPath);
      const firstPage = !apiPath.includes('cursor=');
      return {
        ok: true,
        status: 200,
        body: firstPage
          ? {
              data: [{ type: 'appAssetLibraryImages', id: 'image-1', attributes: { state: 'APPROVED' } }],
              links: { next: 'https://api.appstoreconnect.apple.com/v1/appAssetLibraries/library-1/images?cursor=abc' },
            }
          : { data: [{ type: 'appAssetLibraryImages', id: 'image-2', attributes: { state: 'APPROVED' } }], links: {} },
      };
    };
    const images = await readLibraryImages({ request, libraryId: 'library-1' });
    expect(images.map((image) => image.id)).toEqual(['image-1', 'image-2']);
    expect(paths).toEqual(['/appAssetLibraries/library-1/images', '/appAssetLibraries/library-1/images?cursor=abc']);
  });

  it('throws on a next link outside the API base rather than returning a partial list, and never requests it', async () => {
    const paths: string[] = [];
    const request = async (_method: string, apiPath: string) => {
      paths.push(apiPath);
      return {
        ok: true,
        status: 200,
        body: {
          data: [{ type: 'appAssetLibraryImages', id: 'image-1', attributes: { state: 'APPROVED' } }],
          links: { next: 'https://elsewhere.invalid/v1/appAssetLibraries/library-1/images?cursor=abc' },
        },
      };
    };
    await expect(readLibraryImages({ request, libraryId: 'library-1' })).rejects.toThrow(/next-page link outside/);
    expect(paths).toEqual(['/appAssetLibraries/library-1/images']);
  });

  it('throws when a list is still going after the page cap rather than returning a partial list', async () => {
    let requested = 0;
    const request = async () => {
      requested += 1;
      return {
        ok: true,
        status: 200,
        body: {
          data: [{ type: 'appAssetLibraryImages', id: `image-${requested}`, attributes: { state: 'APPROVED' } }],
          links: { next: 'https://api.appstoreconnect.apple.com/v1/appAssetLibraries/library-1/images?cursor=more' },
        },
      };
    };
    await expect(readLibraryImages({ request, libraryId: 'library-1' })).rejects.toThrow(/still had more after 20 pages/);
    expect(requested).toBe(20);
  });

  it('reads Apple\'s own checksum for each screenshot out of the deprecated sets', async () => {
    const request = async () => ({
      ok: true,
      status: 200,
      body: {
        data: [
          {
            type: 'appScreenshotSets',
            id: 'set-1',
            attributes: { screenshotDisplayType: 'APP_IPHONE_67' },
            relationships: { appScreenshots: { data: [{ id: 'shot-b' }, { id: 'shot-a' }] } },
          },
        ],
        included: [
          { type: 'appScreenshots', id: 'shot-a', attributes: { sourceFileChecksum: 'aaa' } },
          { type: 'appScreenshots', id: 'shot-b', attributes: { sourceFileChecksum: 'bbb' } },
        ],
      },
    });
    // In the set's own order, which is the display order, not `included` order.
    expect(await readLegacyScreenshotSets({ request, localizationId: LOCALIZATION })).toEqual([
      { displayType: 'APP_IPHONE_67', checksums: ['bbb', 'aaa'] },
    ]);
  });

  it('turns a refused read into an error naming what it was doing', async () => {
    const library = createFakeAssetLibrary({ failWith: [{ prefix: 'GET /apps/', status: 500 }] });
    await expect(
      readScreenshotTarget({ request: library.request, appId: 'app-1', frames: makeListingFrames() })
    ).rejects.toThrow(/Could not read the app's asset library \(500\)/);
  });
});

describe('syncScreenshots', () => {
  const oldFrames = makeListingFrames(1);
  const frames = makeListingFrames();
  /** A version that inherited seven frames someone uploaded by hand. */
  const inherited = (extra: AssetLibrarySeed = {}) =>
    createFakeAssetLibrary({ ...placedFrames(oldFrames, { localizationId: LOCALIZATION, by: 'size' }), ...extra });

  it('replaces a version\'s inherited screenshots with the committed frames, in listing order', async () => {
    const library = inherited();
    const result = await sync(library, frames).promise;

    expect(library.shownOn(LOCALIZATION)).toEqual(frames.map(referenceNameOf));
    expect(result).toEqual({ changed: true, evidence: 'hash', uploaded: 7, reused: 0, placed: 7, removed: 7 });
  });

  it('uploads and processes every frame before it changes a single placement', async () => {
    // So a failed upload leaves the listing exactly as it was. The fake refuses
    // to place an image that is still processing, so a sync that did not wait
    // would fail outright; this pins the stronger property, the ORDER.
    const library = inherited({ processingReads: 2 });
    await sync(library, frames).promise;

    const firstPlacementWrite = library.calls.findIndex(isPlacementWrite);
    const lastUploadCall = library.calls.findLastIndex((call) => call.path.startsWith('/appAssetLibraryImages'));
    expect(firstPlacementWrite).toBeGreaterThan(-1);
    expect(lastUploadCall).toBeLessThan(firstPlacementWrite);
  });

  it('never leaves the listing with fewer screenshots than it will end with, when the cap allows', async () => {
    const library = inherited();
    await sync(library, frames).promise;
    expect(library.lowestCount.get(`${LOCALIZATION}/${SCREENSHOT_GROUP}`)).toBe(7);
  });

  it('never empties the group even when it is already at its cap', async () => {
    // Seven on the listing and a cap of seven: nothing can be added until one
    // is removed. Deleting all seven first would pass through zero, and a run
    // that died there would leave a version stage 2 refuses to submit.
    const library = inherited({ maxCount: 7 });
    await sync(library, frames, { maxCount: 7 }).promise;

    expect(library.shownOn(LOCALIZATION)).toEqual(frames.map(referenceNameOf));
    expect(library.lowestCount.get(`${LOCALIZATION}/${SCREENSHOT_GROUP}`)).toBe(6);
  });

  it('writes nothing when the listing already shows the committed frames', async () => {
    const library = createFakeAssetLibrary(placedFrames(frames, { localizationId: LOCALIZATION, by: 'size' }));
    const result = await sync(library, frames).promise;

    expect(result).toMatchObject({ changed: false, evidence: 'size' });
    expect(libraryWrites(library.calls)).toEqual([]);
    expect(library.partUploads).toEqual([]);
  });

  it('is idempotent: a second run finds nothing to do', async () => {
    const library = inherited();
    await sync(library, frames).promise;
    const callsAfterFirst = library.calls.length;
    const second = await sync(library, frames).promise;

    expect(second).toMatchObject({ changed: false, evidence: 'hash' });
    expect(libraryWrites(library.calls.slice(callsAfterFirst))).toEqual([]);
  });

  it('touches only the frames that changed', async () => {
    const library = createFakeAssetLibrary(placedFrames(frames, { localizationId: LOCALIZATION, by: 'hash' }));
    const recaptured = makeListingFrames(2);
    const current = [frames[0], recaptured[1], frames[2], frames[3], frames[4], frames[5], recaptured[6]];
    const keptIds = [0, 2, 3, 4, 5].map((index) => `old-placement-${LOCALIZATION}-${index}`);
    const result = await sync(library, current).promise;

    expect(result).toMatchObject({ uploaded: 2, placed: 2, removed: 2 });
    expect(library.shownOn(LOCALIZATION)).toEqual(current.map(referenceNameOf));
    // The five unchanged frames kept the placements they had.
    expect(library.placements.map((entry) => entry.id)).toEqual(expect.arrayContaining(keptIds));
  });

  it('only reorders when the right frames are in the wrong order', async () => {
    const seed = placedFrames(frames, { localizationId: LOCALIZATION, by: 'hash' });
    seed.placements.reverse();
    const library = createFakeAssetLibrary(seed);
    const result = await sync(library, frames).promise;

    expect(result).toMatchObject({ changed: true, uploaded: 0, placed: 0, removed: 0 });
    expect(libraryWrites(library.calls).map((call) => `${call.method} ${call.path}`)).toEqual([
      'POST /appAssetLibraryPlacementOrderingRequests',
    ]);
    expect(library.shownOn(LOCALIZATION)).toEqual(frames.map(referenceNameOf));
  });

  it('reuses frames a previous run uploaded but never placed', async () => {
    // A run that died after its uploads. The images are in the library with our
    // hashes; uploading them again would only fill it with duplicates.
    const library = inherited({
      images: [
        ...placedFrames(oldFrames, { localizationId: LOCALIZATION, by: 'size' }).images,
        ...frames.map((frame, index) => ({
          id: `uploaded-earlier-${index}`,
          referenceName: referenceNameOf(frame),
          fileName: frame.fileName,
          fileSize: frame.byteLength,
          state: 'PREPARE_FOR_SUBMISSION',
        })),
      ],
    });
    const result = await sync(library, frames).promise;

    expect(result).toMatchObject({ uploaded: 0, reused: 7, placed: 7 });
    expect(library.partUploads).toEqual([]);
    expect(library.shownOn(LOCALIZATION)).toEqual(frames.map(referenceNameOf));
  });

  it('waits for a reused image a dead run uploaded but Apple was still processing, before placing it', async () => {
    // The recovery case: the earlier run died after the commit and before Apple
    // finished. The images are reused, not uploaded again, and a placement made
    // while one is still processing would be refused.
    const library = inherited({
      images: [
        ...placedFrames(oldFrames, { localizationId: LOCALIZATION, by: 'size' }).images,
        ...frames.map((frame, index) => ({
          id: `uploaded-earlier-${index}`,
          referenceName: referenceNameOf(frame),
          fileName: frame.fileName,
          fileSize: frame.byteLength,
          state: 'UPLOAD_COMPLETE',
          readsUntilProcessed: 1,
        })),
      ],
    });
    const result = await sync(library, frames).promise;

    expect(result).toMatchObject({ uploaded: 0, reused: 7, placed: 7 });
    expect(library.partUploads).toEqual([]);
    expect(library.shownOn(LOCALIZATION)).toEqual(frames.map(referenceNameOf));
    const firstPlacement = library.calls.findIndex((call) => call.method === 'POST' && call.path === '/appAssetLibraryPlacements');
    const lastPoll = library.calls.findLastIndex(
      (call) => call.method === 'GET' && call.path.startsWith('/appAssetLibraryImages/uploaded-earlier-')
    );
    expect(lastPoll).toBeGreaterThan(-1);
    expect(lastPoll).toBeLessThan(firstPlacement);
  });

  it('carries on with the upload when an abandoned reservation cannot be removed', async () => {
    // Cleanup is best effort: a refusal must not stop the upload that replaces it.
    const library = inherited({
      images: [
        ...placedFrames(oldFrames, { localizationId: LOCALIZATION, by: 'size' }).images,
        {
          id: 'reserved-and-abandoned',
          referenceName: referenceNameOf(frames[0]),
          fileName: frames[0].fileName,
          fileSize: frames[0].byteLength,
          state: 'AWAITING_UPLOAD',
        },
      ],
      failWith: [{ prefix: 'DELETE /appAssetLibraryImages', status: 409 }],
    });
    const { promise, logged } = sync(library, frames);
    const result = await promise;

    expect(library.images.has('reserved-and-abandoned')).toBe(true);
    expect(result).toMatchObject({ uploaded: 7, placed: 7 });
    expect(library.shownOn(LOCALIZATION)).toEqual(frames.map(referenceNameOf));
    expect(logged.join('\n')).toMatch(/Could not remove an abandoned upload of 01-agents\.png \(409\); leaving it\./);
  });

  it('clears a reservation a dead run never uploaded, then uploads the frame properly', async () => {
    const library = inherited({
      images: [
        ...placedFrames(oldFrames, { localizationId: LOCALIZATION, by: 'size' }).images,
        {
          id: 'reserved-and-abandoned',
          referenceName: referenceNameOf(frames[0]),
          fileName: frames[0].fileName,
          fileSize: frames[0].byteLength,
          state: 'AWAITING_UPLOAD',
        },
      ],
    });
    const { promise, logged } = sync(library, frames);
    const result = await promise;

    expect(library.images.has('reserved-and-abandoned')).toBe(false);
    expect(result.uploaded).toBe(7);
    expect(logged.join('\n')).toMatch(/Removed an abandoned upload of 01-agents\.png/);
  });

  it('never deletes a library image that is, or was, on a listing', async () => {
    // The live version's placements point at the same images as the version
    // being prepared. Removing the old frames from THIS version must leave the
    // images themselves in the library.
    const library = inherited();
    const oldImageIds = [...library.images.keys()];
    await sync(library, frames).promise;

    expect([...library.images.keys()]).toEqual(expect.arrayContaining(oldImageIds));
    expect(library.calls.filter((call) => call.method === 'DELETE' && call.path.startsWith('/appAssetLibraryImages'))).toEqual([]);
  });

  it('sends each file as the parts Apple asked for, with its headers and no token', async () => {
    const library = createFakeAssetLibrary();
    await sync(library, [frames[0]]).promise;

    expect(library.partUploads).toHaveLength(2);
    expect(library.partUploads.reduce((total, part) => total + part.length, 0)).toBe(frames[0].byteLength);
    for (const part of library.partUploads) {
      expect(part.headers).toEqual({ 'Content-Type': 'image/png' });
    }
  });

  it('names the image by its reference name and reserves its exact size', async () => {
    const library = createFakeAssetLibrary();
    await sync(library, [frames[0]]).promise;
    const reservation = library.calls.find((call) => call.method === 'POST' && call.path === '/appAssetLibraryImages');
    expect(reservation?.body).toMatchObject({
      data: {
        type: 'appAssetLibraryImages',
        attributes: {
          fileName: '01-agents.png',
          fileSize: frames[0].byteLength,
          category: 'APP_SCREENSHOTS_AND_PREVIEWS',
          referenceName: referenceNameOf(frames[0]),
        },
        relationships: { assetLibrary: { data: { type: 'appAssetLibraries', id: LIBRARY_ID } } },
      },
    });
  });

  describe('a failure before the listing is touched leaves it as it was', () => {
    const untouched = (library: FakeAssetLibrary) => {
      expect(library.shownOn(LOCALIZATION)).toEqual(oldFrames.map((frame) => frame.fileName));
      expect(library.calls.filter(isPlacementWrite)).toEqual([]);
    };

    it('when Apple cannot process an uploaded frame', async () => {
      const library = inherited({ failProcessing: ['03-session-terminal.png'] });
      await expect(sync(library, frames).promise).rejects.toThrow(/could not process an uploaded screenshot \(03-session-terminal\.png\)/);
      untouched(library);
    });

    it.each(['REJECTED', 'ARCHIVED'])(
      'when processing ends %s, with the group at its cap so a create would have needed a delete first',
      async (finishedState) => {
        // Step 2 deletes a stale placement to make room when the group is full,
        // and the create that follows is then refused for an image that cannot be
        // placed. Only FAILED used to stop the run here, so the listing lost a
        // screenshot. Every unusable finished state has to stop it before any write.
        const library = inherited({ maxCount: 7, processingEndsAs: finishedState });
        const rejection = sync(library, frames, { maxCount: 7 }).promise;
        await expect(rejection).rejects.toThrow(
          new RegExp(`Apple left an uploaded screenshot \\(01-agents\\.png\\) ${finishedState}, which cannot be placed`)
        );
        await expect(rejection).rejects.toThrow(/Nothing on the listing was changed\./);
        untouched(library);
        expect(library.calls.filter((call) => call.method === 'DELETE' && call.path.startsWith('/appAssetLibraryPlacements'))).toEqual([]);
      }
    );

    it('when storage refuses a part', async () => {
      const library = inherited({ failUploadPart: ['02-board.png'] });
      await expect(sync(library, frames).promise).rejects.toThrow(/Uploading 02-board\.png to Apple's storage failed \(500\)/);
      untouched(library);
    });

    it('when processing does not finish in time', async () => {
      const sleep = vi.fn(async (_milliseconds: number) => undefined);
      const library = inherited({ processingReads: 50 });
      await expect(sync(library, frames, { sleep, pollAttempts: 3, pollIntervalMilliseconds: 250 }).promise).rejects.toThrow(
        /still processing after 3 checks/
      );
      untouched(library);
      expect(sleep).toHaveBeenCalledWith(250);
    });

    it('when there are more frames than the group holds', async () => {
      const library = inherited({ maxCount: 3 });
      await expect(sync(library, frames, { maxCount: 3 }).promise).rejects.toThrow(/7 frames is over the 3 screenshots/);
      untouched(library);
    });
  });

  it('fails when the placements read back in another order than it set', async () => {
    // Every call answered 2xx. Only the read-back knows the listing is wrong,
    // which is the reason there is one.
    const seed = placedFrames(frames, { localizationId: LOCALIZATION, by: 'hash' });
    seed.placements.reverse();
    const library = createFakeAssetLibrary({ ...seed, ignoreOrdering: true });
    await expect(sync(library, frames, { verifyAttempts: 2 }).promise).rejects.toThrow(
      /reading them back does not show the committed frames in order \(7 screenshot\(s\), the committed frames in a DIFFERENT ORDER\)/
    );
  });

  it('accepts a listing that reads back in order only on a later read', async () => {
    // Apple does not say whether the ordering request applies before it answers.
    // The first read-back still shows the old order, so a single read would fail
    // a sync that had in fact worked.
    const seed = placedFrames(frames, { localizationId: LOCALIZATION, by: 'hash' });
    seed.placements.reverse();
    const library = createFakeAssetLibrary({ ...seed, orderingAppliesAfterReads: 1 });
    const sleep = vi.fn(async (_milliseconds: number) => undefined);
    const result = await sync(library, frames, { sleep, pollIntervalMilliseconds: 250 }).promise;

    expect(result).toMatchObject({ changed: true });
    expect(library.shownOn(LOCALIZATION)).toEqual(frames.map(referenceNameOf));
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(250);
  });

  it('turns a refused write into an error naming what it was doing', async () => {
    const library = inherited({ failWith: [{ prefix: 'POST /appAssetLibraryPlacements', status: 409 }] });
    await expect(sync(library, frames).promise).rejects.toThrow(/Could not place 01-agents\.png on the listing \(409\)/);
  });
});

describe('uploadPartWithFetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('PUTs the bytes with Apple\'s headers and no credentials', async () => {
    // The upload URL is unauthenticated and time-limited. Sending the API token
    // to Apple's blob storage would be handing a credential to a host that did
    // not ask for one.
    const fetchStub = vi.fn(async (_url: string, _init: RequestInit) => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchStub);
    const bytes = new Uint8Array([9, 8, 7]);
    const result = await uploadPartWithFetch(
      {
        method: 'PUT',
        url: 'https://storage.invalid/part-1',
        offset: 0,
        length: 3,
        requestHeaders: [{ name: 'Content-Type', value: 'image/png' }],
      },
      bytes
    );

    const [url, init] = fetchStub.mock.calls[0];
    expect(url).toBe('https://storage.invalid/part-1');
    expect(init.method).toBe('PUT');
    expect(init.body).toBe(bytes);
    expect(init.headers).toEqual({ 'Content-Type': 'image/png' });
    expect(result).toEqual({ ok: true, status: 200 });
  });
});
