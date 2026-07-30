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
  isValidDeviceSerial,
  readPngSize,
} from '../../scripts/storeScreenshots.mjs';
import { CLAUDE_CAPTURE_SHOTS } from '@/devsupport/claudeCapture';
import { renderCaptureRows } from '../helpers/renderCapture';

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

describe('isValidDeviceSerial', () => {
  it('accepts the serial shapes adb actually reports', () => {
    expect(isValidDeviceSerial('emulator-5554')).toBe(true);
    expect(isValidDeviceSerial('192.168.1.5:5555')).toBe(true);
    expect(isValidDeviceSerial('R58M12345AB')).toBe(true);
  });

  it('rejects a serial carrying cmd.exe command separators', () => {
    // The serial is the one value in this script that reaches a shell:
    // runMaestro and assertNoDevToolsBubble spawn with `shell: true` on
    // Windows, and Node does not escape an args array once a shell is in play.
    expect(isValidDeviceSerial('emulator-5554 & calc')).toBe(false);
    expect(isValidDeviceSerial('emulator-5554|whoami')).toBe(false);
    expect(isValidDeviceSerial('emulator-5554^x')).toBe(false);
    expect(isValidDeviceSerial('"emulator-5554"')).toBe(false);
  });

  it('rejects an empty or absent serial rather than treating it as valid', () => {
    expect(isValidDeviceSerial('')).toBe(false);
    expect(isValidDeviceSerial(undefined)).toBe(false);
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
 * The terminal mirror renders the desktop's real grid and pans the overflow, so
 * how much is VISIBLE depends on the auto-fitted font - and that font is fitted
 * to the terminal pane's HEIGHT, never its width. A taller pane picks a bigger
 * font and therefore shows FEWER columns, which makes the 6.9-inch iPhone the
 * binding case rather than the widest device.
 *
 * The first iOS store capture clipped its header mid-word. Nothing failed: the
 * PNG was the right size and the flow was green, so this is the repo's
 * green-but-worthless-artifact shape again, and it is worth a mechanical check
 * rather than an eye on every future capture.
 *
 * This used to scrape string literals out of mockDesktop.ts and measure their
 * `.length`. That only ever worked because the fixture was an array of plain
 * strings; it is now a RECORDED capture, where bytes and columns are unrelated
 * (escape sequences have no width, and words are split by cursor moves). So the
 * budget is re-derived from the fit math and checked against the real grid.
 */
describe('the recorded terminal fits the narrowest capture device', () => {
  // From scripts/buildXtermHtml.mjs. Duplicated deliberately: that file is a
  // generated-asset builder with no importable export, so the alternative is
  // no check at all.
  const MAX_AUTO_FIT_FONT_PX = 20;
  const MIN_AUTO_FONT_PX = 6;
  const CELL_WIDTH_RATIO = 0.6;
  const CELL_HEIGHT_RATIO = 1.2;

  /**
   * Terminal-pane sizes MEASURED off the committed store captures, not guessed.
   *
   * On store/screenshots/ios/iphone-6.9/02-session-terminal.png the cell is
   * 11.8pt wide and 23.9pt tall at the 30-row grid that shipped it. A 11.8pt
   * cell means font 20 (11.8 / 0.6), which needs a pane at least 720pt tall;
   * a 23.9pt row means the line-height stretch is 1.0, which caps the pane at
   * 720pt. The two bracket it exactly. The Android phone shelf works out the
   * same way from its own capture.
   */
  const CAPTURE_TARGETS = [
    { name: 'iPhone 6.9-inch', paneWidth: 440, paneHeight: 720 },
    { name: 'Android phone shelf', paneWidth: 360, paneHeight: 440 },
  ];

  function visibleColumns(target: { paneWidth: number; paneHeight: number }, rows: number): number {
    const fitted = Math.floor(target.paneHeight / (rows * CELL_HEIGHT_RATIO));
    const fontPx = Math.max(MIN_AUTO_FONT_PX, Math.min(MAX_AUTO_FIT_FONT_PX, fitted));
    return Math.floor(target.paneWidth / (fontPx * CELL_WIDTH_RATIO));
  }

  it('reproduces the 36 columns the shipped iOS capture actually shows', () => {
    // Anchors the model to an artifact in the repo. If this drifts, the pane
    // measurements above are wrong and every budget below is wrong with them.
    expect(visibleColumns(CAPTURE_TARGETS[0], 30)).toBe(36);
  });

  it('keeps the store-capture grid inside every target device', () => {
    for (const target of CAPTURE_TARGETS) {
      const budget = visibleColumns(target, CLAUDE_CAPTURE_SHOTS.rows);
      expect({
        target: target.name,
        gridCols: CLAUDE_CAPTURE_SHOTS.cols,
        fitsWithin: CLAUDE_CAPTURE_SHOTS.cols <= budget,
      }).toEqual({ target: target.name, gridCols: CLAUDE_CAPTURE_SHOTS.cols, fitsWithin: true });
    }
  });

  it('renders no row wider than the grid it reports', async () => {
    // The grid fitting the screen is only half of it: a capture replayed at a
    // grid it was not recorded at overflows its own columns, and the phone
    // shows borders sliced mid-glyph rather than a wide frame.
    const rows = await renderCaptureRows(CLAUDE_CAPTURE_SHOTS);
    const tooWide = rows
      .filter((row) => [...row].length > CLAUDE_CAPTURE_SHOTS.cols)
      .map((row) => `${[...row].length} cols: ${row}`);
    expect(tooWide).toEqual([]);
  });
});
