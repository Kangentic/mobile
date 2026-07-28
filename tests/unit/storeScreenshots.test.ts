/**
 * Covers scripts/storeScreenshots.mjs, which captures the Play Store listing
 * images.
 *
 * The dimension gate is the part that matters. A capture at the wrong size is
 * rejected by the store at upload time, long after the emulator has been torn
 * down and the geometry restored - and until then it looks exactly like a good
 * one. That is this repo's known green-but-worthless-artifact shape, so the
 * check that prevents it is worth testing rather than trusting.
 *
 * The shelf table is tested too, because Play's constraints are unobvious: it
 * demands 16:9 or 9:16 on ALL THREE Android shelves, tablets included, and a
 * real tablet is not 9:16. The geometry below only satisfies that by setting
 * resolution and density independently, which is easy to "tidy" into something
 * that no longer complies.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  SHELVES,
  SHOT_NAMES,
  describeDimensionMismatch,
  readPngSize,
} from '../../scripts/storeScreenshots.mjs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Builds the smallest byte sequence readPngSize is meant to understand. */
function fakePngHeader(width: number, height: number): Buffer {
  const chunkLength = Buffer.alloc(4);
  chunkLength.writeUInt32BE(13);
  const dimensions = Buffer.alloc(8);
  dimensions.writeUInt32BE(width, 0);
  dimensions.writeUInt32BE(height, 4);
  return Buffer.concat([PNG_SIGNATURE, chunkLength, Buffer.from('IHDR', 'ascii'), dimensions]);
}

describe('readPngSize', () => {
  it('reads width and height out of the IHDR chunk', () => {
    expect(readPngSize(fakePngHeader(1080, 1920))).toEqual({ width: 1080, height: 1920 });
    expect(readPngSize(fakePngHeader(1440, 2560))).toEqual({ width: 1440, height: 2560 });
  });

  it('rejects a file that is not a PNG', () => {
    const notAPng = Buffer.concat([Buffer.from('GIF89a', 'ascii'), Buffer.alloc(32)]);
    expect(() => readPngSize(notAPng)).toThrow(/signature/);
  });

  it('rejects a truncated file rather than reading past the end', () => {
    // Buffer.readUInt32BE would throw its own out-of-range error here; the point
    // is that the failure is explained rather than raw.
    expect(() => readPngSize(PNG_SIGNATURE)).toThrow(/shorter than/);
  });

  it('rejects a PNG whose first chunk is not IHDR', () => {
    const wrongChunk = fakePngHeader(1080, 1920);
    wrongChunk.write('IDAT', 12, 'ascii');
    expect(() => readPngSize(wrongChunk)).toThrow(/IHDR/);
  });
});

describe('describeDimensionMismatch', () => {
  const shelf = SHELVES.phone;

  it('passes a capture at the shelf size', () => {
    expect(describeDimensionMismatch('01-agents', { width: shelf.width, height: shelf.height }, shelf)).toBeNull();
  });

  it('names the shot, the actual size and the expected size when it is wrong', () => {
    const message = describeDimensionMismatch('01-agents', { width: 1080, height: 2400 }, shelf);
    expect(message).toContain('01-agents');
    expect(message).toContain('1080x2400');
    expect(message).toContain(`${shelf.width}x${shelf.height}`);
  });

  it('rejects a transposed capture rather than accepting the same pixel count', () => {
    // Landscape at the same area is still a rejected upload.
    expect(describeDimensionMismatch('01-agents', { width: shelf.height, height: shelf.width }, shelf)).not.toBeNull();
  });
});

type ShelfName = keyof typeof SHELVES;

describe('the shelf geometry satisfies Play', () => {
  const shelfNames = Object.keys(SHELVES) as ShelfName[];

  it('covers all three Android shelves', () => {
    // Non-vacuity guard: every assertion below iterates this list, so an empty
    // or renamed table would pass them all silently.
    expect(shelfNames).toEqual(['phone', 'seven-inch', 'ten-inch']);
  });

  it('is exactly 9:16 everywhere, tablets included', () => {
    for (const name of shelfNames) {
      const { width, height } = SHELVES[name];
      expect(`${name}:${width * 16}`).toBe(`${name}:${height * 9}`);
    }
  });

  it('keeps every side inside its shelf bounds', () => {
    // Phone and 7-inch: 320-3840 per side. 10-inch: 1080-7680 per side.
    for (const name of ['phone', 'seven-inch'] as ShelfName[]) {
      const { width, height } = SHELVES[name];
      expect(Math.min(width, height)).toBeGreaterThanOrEqual(320);
      expect(Math.max(width, height)).toBeLessThanOrEqual(3840);
    }
    const tenInch = SHELVES['ten-inch'];
    expect(Math.min(tenInch.width, tenInch.height)).toBeGreaterThanOrEqual(1080);
    expect(Math.max(tenInch.width, tenInch.height)).toBeLessThanOrEqual(7680);
  });

  it('keeps the phone shelf eligible for Play promotion, which needs 1080px+', () => {
    expect(Math.min(SHELVES.phone.width, SHELVES.phone.height)).toBeGreaterThanOrEqual(1080);
  });

  it('gives each shelf its own output directory', () => {
    const directories = shelfNames.map((name) => SHELVES[name].outputDirectory);
    expect(new Set(directories).size).toBe(directories.length);
  });

  it('lands the tablet shelves above the 600dp large-screen breakpoint', () => {
    // This is what makes the tablet captures a real layout rather than an
    // upscaled phone: dp = px / (density / 160).
    for (const name of ['seven-inch', 'ten-inch'] as ShelfName[]) {
      const { width, density } = SHELVES[name];
      expect(Math.round(width / (density / 160))).toBeGreaterThanOrEqual(600);
    }
    const phone = SHELVES.phone;
    expect(Math.round(phone.width / (phone.density / 160))).toBeLessThan(600);
  });
});

describe('the shot list matches the capture flow', () => {
  const flowSource = readFileSync(
    fileURLToPath(new URL('../../.maestro/screenshots/store-capture.yaml', import.meta.url)),
    'utf8',
  );
  const flowShotNames = [...flowSource.matchAll(/path:\s*\$\{OUTPUT_DIR\}\/(\S+)/g)].map((match) => match[1]);

  it('finds takeScreenshot paths in the flow at all', () => {
    // Non-vacuity guard: the comparison below is trivially satisfiable if the
    // regex silently stops matching, which is the drift that would hurt.
    expect(flowShotNames.length).toBeGreaterThan(0);
  });

  it('names exactly the shots the flow captures', () => {
    // The script verifies and collects by name, so a shot added to the flow and
    // not to SHOT_NAMES is captured and then never checked or moved.
    expect([...flowShotNames].sort()).toEqual([...SHOT_NAMES].sort());
  });

  it('orders the names so the stores display them as intended', () => {
    // Both stores show screenshots in upload order, and the upload tools sort by
    // filename, so the numeric prefixes are load-bearing rather than decorative.
    expect([...SHOT_NAMES]).toEqual([...SHOT_NAMES].sort());
  });
});

/**
 * The terminal mirror renders the desktop's real 120-column grid and pans the
 * overflow, so how much is VISIBLE depends on the auto-fitted font - and that
 * font is fitted to the screen HEIGHT. A taller phone picks a bigger font and
 * therefore shows FEWER columns, which makes the 6.9-inch iPhone (tall enough
 * to hit the 20px auto-fit ceiling, leaving 36-37 columns) the binding case,
 * not the widest device.
 *
 * The first iOS store capture clipped its header mid-word. Nothing failed: the
 * PNG was the right size and the flow was green, so this is the repo's
 * green-but-worthless-artifact shape again, and it is worth a mechanical check
 * rather than an eye on every future capture.
 */
describe('the mock terminal script fits the narrowest device', () => {
  const VISIBLE_COLUMN_BUDGET = 34;
  const mockSource = readFileSync(
    fileURLToPath(new URL('../../src/connection/mockDesktop.ts', import.meta.url)),
    'utf8',
  );

  /** Pulls the string literals out of a named array declaration in the source. */
  function arrayLiterals(declaration: string): string[] {
    const block = new RegExp(`${declaration}[^[]*\\[([^\\]]*)\\]`).exec(mockSource);
    if (block === null) return [];
    return [...block[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1]);
  }

  const scriptLines = arrayLiterals('MOCK_TERMINAL_LINES');
  const headerLines = arrayLiterals('const header =');

  it('finds the script and header lines at all', () => {
    // Non-vacuity guard: every assertion below passes trivially against an
    // empty array, so a regex that stops matching would read as success.
    expect(scriptLines.length).toBeGreaterThan(10);
    expect(headerLines.length).toBeGreaterThan(0);
  });

  it('keeps every line inside the visible column budget', () => {
    const tooWide = [...scriptLines, ...headerLines]
      .filter((line) => line.length > VISIBLE_COLUMN_BUDGET)
      .map((line) => `${line.length} cols: ${line}`);
    // Named individually: a bare count tells whoever broke it nothing, and the
    // failure is invisible on the Android emulator they are probably using.
    expect(tooWide).toEqual([]);
  });

  it('counts the indent, because a wrapped line is cut and not re-flowed', () => {
    // The indented continuation lines are the ones that actually overflowed:
    // they read as short in source and are two columns longer than they look.
    const indented = scriptLines.filter((line) => line.startsWith('  '));
    expect(indented.length).toBeGreaterThan(0);
    for (const line of indented) {
      expect(line.length).toBeLessThanOrEqual(VISIBLE_COLUMN_BUDGET);
    }
  });
});
