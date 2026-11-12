/**
 * The committed store listing frames, read in LISTING ORDER and validated before
 * anything is sent to a store.
 *
 * Both upload paths (scripts/syncPlayListingImages.mjs for Google Play, and the
 * screenshot modes of scripts/prepareAppStoreRelease.mjs for the App Store) read
 * their frames through here, for two reasons:
 *
 *   - Order. Both stores display screenshots in upload order. The order comes
 *     from SHOT_NAMES in scripts/storeScreenshots.mjs, an explicit list a test
 *     pins, and never from a directory listing: `readdir` order is a property
 *     of the filesystem, and the listing once showed the Board fifth because a
 *     filename sort said so.
 *   - Refusal before upload. A wrong-size frame, an alpha channel, or a stray
 *     file is rejected by the store after the upload has started. On Play that
 *     is harmless (an edit is transactional), but on the App Store it would
 *     leave a half-replaced shelf, so every frame is checked first.
 *
 * No dependencies. The hashes are what make both uploads idempotent: Play
 * reports a SHA-256 for every listing image, and the App Store path writes a
 * SHA-256 prefix into each image's reference name.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SHELVES, SHOT_NAMES, readPngSize } from '../storeScreenshots.mjs';

/** The checkout this script lives in, so a shelf resolves the same from any working directory. */
export const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Play accepts at most this many screenshots per device type (Play Console help, "Add preview assets"). */
export const PLAY_SCREENSHOT_CAP = 8;

/**
 * The three Play shelves, each with the `AppImageType` the Play Developer API
 * files it under. Sizes and directories come from the capture script's own
 * SHELVES, so the upload and the capture cannot disagree about a shelf.
 *
 * @type {ReadonlyArray<{ name: string, imageType: string, directory: string, width: number, height: number }>}
 */
export const PLAY_LISTING_SHELVES = [
  { name: 'phone', imageType: 'phoneScreenshots' },
  { name: 'seven-inch', imageType: 'sevenInchScreenshots' },
  { name: 'ten-inch', imageType: 'tenInchScreenshots' },
].map((shelf) => ({
  ...shelf,
  directory: SHELVES[shelf.name].outputDirectory,
  width: SHELVES[shelf.name].width,
  height: SHELVES[shelf.name].height,
}));

/**
 * @typedef {{
 *   name: string,
 *   fileName: string,
 *   bytes: Uint8Array,
 *   byteLength: number,
 *   sha256: string,
 *   sha1: string,
 *   md5: string,
 *   width: number,
 *   height: number,
 * }} ListingFrame
 */

/**
 * Whether a PNG carries transparency: an alpha colour type (4 grey+alpha, 6
 * RGBA) in IHDR, or a tRNS chunk before the image data. App Store Connect
 * rejects both, and Play asks for "24-bit PNG (no alpha)".
 *
 * Layout: an 8-byte signature, then chunks of a 4-byte length, a 4-byte type,
 * the data, and a 4-byte CRC. IHDR is first, and its colour type is the byte at
 * offset 25.
 *
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function readPngHasAlpha(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const colourType = view.getUint8(25);
  if (colourType === 4 || colourType === 6) return true;

  let offset = 8;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
    if (type === 'tRNS') return true;
    // Transparency is declared before the pixels, so nothing after IDAT matters.
    if (type === 'IDAT' || type === 'IEND') return false;
    offset += 12 + length;
  }
  return false;
}

function digest(algorithm, bytes) {
  return createHash(algorithm).update(bytes).digest('hex');
}

/**
 * Reads one shelf in listing order.
 *
 * Throws one error naming every problem found, before the caller has made a
 * single network call. `expectedSize` pins the shelf's exact pixel size when the
 * caller knows it (Play does, from SHELVES). Without it the frames must still
 * all share ONE size, which the App Store path then resolves against Apple's
 * reference data, so the iOS size is not declared a third time here.
 *
 * @param {string} directory
 * @param {{
 *   expectedSize?: { width: number, height: number },
 *   maxCount?: number,
 *   shotNames?: readonly string[],
 * }} [options]
 * @returns {ListingFrame[]}
 */
export function readListingFrames(directory, { expectedSize, maxCount, shotNames = SHOT_NAMES } = {}) {
  if (!existsSync(directory)) {
    throw new Error(`No listing frames at ${directory}: the directory does not exist.`);
  }

  const expectedFiles = shotNames.map((shotName) => `${shotName}.png`);
  const presentFiles = readdirSync(directory);
  const problems = [];

  for (const fileName of presentFiles) {
    if (!expectedFiles.includes(fileName)) {
      problems.push(`${fileName} is not one of the shots the capture produces; remove it or add it to SHOT_NAMES`);
    }
  }
  if (maxCount !== undefined && expectedFiles.length > maxCount) {
    problems.push(`${expectedFiles.length} frames is over the store's cap of ${maxCount}`);
  }

  /** @type {ListingFrame[]} */
  const frames = [];
  for (const [index, fileName] of expectedFiles.entries()) {
    if (!presentFiles.includes(fileName)) {
      problems.push(`${fileName} is missing`);
      continue;
    }
    const bytes = readFileSync(join(directory, fileName));
    let size;
    try {
      size = readPngSize(bytes);
    } catch (error) {
      problems.push(`${fileName} is ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }
    if (expectedSize && (size.width !== expectedSize.width || size.height !== expectedSize.height)) {
      problems.push(
        `${fileName} is ${size.width}x${size.height}, expected ${expectedSize.width}x${expectedSize.height}`
      );
    }
    if (readPngHasAlpha(bytes)) {
      problems.push(`${fileName} has an alpha channel, which both stores reject`);
    }
    frames.push({
      name: shotNames[index],
      fileName,
      bytes,
      byteLength: bytes.byteLength,
      sha256: digest('sha256', bytes),
      sha1: digest('sha1', bytes),
      md5: digest('md5', bytes),
      width: size.width,
      height: size.height,
    });
  }

  const sizes = new Set(frames.map((frame) => `${frame.width}x${frame.height}`));
  if (!expectedSize && sizes.size > 1) {
    problems.push(`the frames are not all one size (${[...sizes].join(', ')})`);
  }

  if (problems.length > 0) {
    throw new Error(`The listing frames in ${directory} cannot be uploaded: ${problems.join('; ')}.`);
  }
  return frames;
}

/**
 * Every Play shelf's frames, in listing order.
 *
 * @param {string} [repositoryRoot]
 * @returns {{ name: string, imageType: string, directory: string, frames: ListingFrame[] }[]}
 */
export function readPlayShelves(repositoryRoot = REPOSITORY_ROOT) {
  return PLAY_LISTING_SHELVES.map((shelf) => ({
    name: shelf.name,
    imageType: shelf.imageType,
    directory: shelf.directory,
    frames: readListingFrames(join(repositoryRoot, shelf.directory), {
      expectedSize: { width: shelf.width, height: shelf.height },
      maxCount: PLAY_SCREENSHOT_CAP,
    }),
  }));
}
