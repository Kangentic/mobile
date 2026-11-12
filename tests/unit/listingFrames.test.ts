/**
 * scripts/lib/listingFrames.mjs is the one place the store listing frames are
 * read for upload. Two properties matter, and both are invisible until a store
 * shows the result:
 *
 *   - the frames come back in LISTING order, from the explicit list, never from
 *     how a directory happens to sort;
 *   - a frame a store would refuse stops the run before the first network call.
 *
 * The generated cases use throwaway directories. The last group reads the
 * committed shelves, because what ships is those files.
 */
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  PLAY_LISTING_SHELVES,
  PLAY_SCREENSHOT_CAP,
  REPOSITORY_ROOT,
  readListingFrames,
  readPlayShelves,
  readPngHasAlpha,
} from '../../scripts/lib/listingFrames.mjs';
import { SHELVES, SHOT_NAMES } from '../../scripts/storeScreenshots.mjs';
import { makePng } from '../helpers/storeListings';

function shelfWith(files: Record<string, Uint8Array>): string {
  const directory = mkdtempSync(join(tmpdir(), 'listing-frames-'));
  for (const [fileName, bytes] of Object.entries(files)) writeFileSync(join(directory, fileName), bytes);
  return directory;
}

describe('readListingFrames', () => {
  it('returns the frames in the order of the list, not the order the directory sorts in', () => {
    // The names sort a, b, c. The list says c, a, b. If the reader ever fell
    // back to a directory listing, this is the test that would notice, and a
    // listing with its screenshots in filename order is the bug this replaces.
    const directory = shelfWith({
      'a.png': makePng({ payloadBytes: 10 }),
      'b.png': makePng({ payloadBytes: 20 }),
      'c.png': makePng({ payloadBytes: 30 }),
    });
    const frames = readListingFrames(directory, { shotNames: ['c', 'a', 'b'] });
    expect(frames.map((frame) => frame.name)).toEqual(['c', 'a', 'b']);
    expect(frames.map((frame) => frame.fileName)).toEqual(['c.png', 'a.png', 'b.png']);
  });

  it('hashes the bytes that will be uploaded, and reports their size', () => {
    const bytes = makePng({ width: 100, height: 200, payloadBytes: 17 });
    const [frame] = readListingFrames(shelfWith({ 'only.png': bytes }), { shotNames: ['only'] });
    expect(frame.byteLength).toBe(bytes.byteLength);
    expect(frame.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(frame.sha1).toBe(createHash('sha1').update(bytes).digest('hex'));
    expect(frame.md5).toBe(createHash('md5').update(bytes).digest('hex'));
    expect({ width: frame.width, height: frame.height }).toEqual({ width: 100, height: 200 });
    expect(Buffer.from(frame.bytes).equals(bytes)).toBe(true);
  });

  it('refuses a shelf with a shot missing, naming it', () => {
    const directory = shelfWith({ 'a.png': makePng() });
    expect(() => readListingFrames(directory, { shotNames: ['a', 'b'] })).toThrow(/b\.png is missing/);
  });

  it('refuses a shelf holding a file the capture does not produce', () => {
    // A renamed shot leaves its old file behind. Uploading "the directory"
    // would ship it; uploading the list would silently skip it. Neither is
    // right, so it stops.
    const directory = shelfWith({ 'a.png': makePng(), 'old-name.png': makePng() });
    expect(() => readListingFrames(directory, { shotNames: ['a'] })).toThrow(/old-name\.png is not one of the shots/);
  });

  it('refuses a frame that is not the shelf size', () => {
    const directory = shelfWith({ 'a.png': makePng({ width: 1080, height: 1920 }) });
    expect(() =>
      readListingFrames(directory, { shotNames: ['a'], expectedSize: { width: 1440, height: 2560 } })
    ).toThrow(/a\.png is 1080x1920, expected 1440x2560/);
  });

  it('refuses frames of mixed sizes when no size is given', () => {
    // The App Store path passes no size (Apple's reference data decides whether
    // the size is acceptable), but one shelf is still one size.
    const directory = shelfWith({
      'a.png': makePng({ width: 1320, height: 2868 }),
      'b.png': makePng({ width: 1290, height: 2796 }),
    });
    expect(() => readListingFrames(directory, { shotNames: ['a', 'b'] })).toThrow(/not all one size/);
  });

  it.each([
    ['an RGBA colour type', makePng({ colourType: 6 })],
    ['a grey-plus-alpha colour type', makePng({ colourType: 4 })],
    ['a tRNS chunk on an RGB image', makePng({ colourType: 2, transparencyChunk: true })],
  ])('refuses a frame with %s', (_label, bytes) => {
    // App Store Connect rejects a PNG with an alpha channel, and Play asks for
    // "24-bit PNG (no alpha)". An image optimiser adds one without changing
    // how the frame looks.
    expect(readPngHasAlpha(bytes)).toBe(true);
    expect(() => readListingFrames(shelfWith({ 'a.png': bytes }), { shotNames: ['a'] })).toThrow(/alpha channel/);
  });

  it('accepts an opaque RGB frame', () => {
    expect(readPngHasAlpha(makePng({ colourType: 2 }))).toBe(false);
  });

  it('refuses more frames than the store takes', () => {
    const directory = shelfWith({ 'a.png': makePng(), 'b.png': makePng(), 'c.png': makePng() });
    expect(() => readListingFrames(directory, { shotNames: ['a', 'b', 'c'], maxCount: 2 })).toThrow(/over the store's cap of 2/);
  });

  it('refuses a file that is not a PNG, naming it', () => {
    const directory = shelfWith({ 'a.png': Buffer.from('this is a text file, comfortably longer than a PNG header') });
    expect(() => readListingFrames(directory, { shotNames: ['a'] })).toThrow(/a\.png is not a PNG/);
  });

  it('reports every problem at once', () => {
    const directory = shelfWith({ 'a.png': makePng({ colourType: 6 }), 'stray.png': makePng() });
    expect(() => readListingFrames(directory, { shotNames: ['a', 'b'] })).toThrow(
      /stray\.png.*b\.png is missing|b\.png is missing.*stray\.png/s
    );
  });

  it('says so when the directory does not exist', () => {
    expect(() => readListingFrames(join(tmpdir(), 'no-such-listing-shelf'))).toThrow(/does not exist/);
  });
});

describe('the Play shelves', () => {
  it('maps each shelf onto the image type the Play API files it under', () => {
    expect(PLAY_LISTING_SHELVES.map((shelf) => [shelf.name, shelf.imageType])).toEqual([
      ['phone', 'phoneScreenshots'],
      ['seven-inch', 'sevenInchScreenshots'],
      ['ten-inch', 'tenInchScreenshots'],
    ]);
  });

  it('takes each shelf\'s directory and size from the capture script, so the two cannot disagree', () => {
    for (const shelf of PLAY_LISTING_SHELVES) {
      const captured = SHELVES[shelf.name as keyof typeof SHELVES];
      expect(shelf.directory).toBe(captured.outputDirectory);
      expect({ width: shelf.width, height: shelf.height }).toEqual({ width: captured.width, height: captured.height });
    }
  });
});

describe('the committed frames', () => {
  const playShelves = readPlayShelves();
  const iosFrames = readListingFrames(join(REPOSITORY_ROOT, 'store/screenshots/ios/iphone-6.9'));

  it('pass every upload check on all four shelves', () => {
    // Reading them is the assertion: a wrong size, an alpha channel, a missing
    // or stray file would have thrown above.
    expect(playShelves.map((shelf) => shelf.frames.length)).toEqual([7, 7, 7]);
    expect(iosFrames).toHaveLength(7);
    expect(SHOT_NAMES.length).toBeLessThanOrEqual(PLAY_SCREENSHOT_CAP);
  });

  it('come back in listing order on every shelf', () => {
    for (const frames of [...playShelves.map((shelf) => shelf.frames), iosFrames]) {
      expect(frames.map((frame) => frame.name)).toEqual([...SHOT_NAMES]);
    }
  });

  it('are each a different length on the iPhone shelf', () => {
    // The App Store path recognises a frame someone uploaded by hand by its
    // exact byte length, because the asset library has no checksum to compare.
    // That only identifies a frame while no two frames are the same length. If
    // a capture ever produces two, this fails here, where the reason is written
    // down, and not as a listing that reads "in sync" with the wrong picture.
    const lengths = iosFrames.map((frame) => frame.byteLength);
    expect(new Set(lengths).size).toBe(lengths.length);
  });
});
