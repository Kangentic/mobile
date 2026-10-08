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
import { beforeAll, describe, expect, it } from 'vitest';

import {
  SHELVES,
  SHOT_NAMES,
  describeDimensionMismatch,
  isValidDeviceSerial,
  readPngSize,
} from '../../scripts/storeScreenshots.mjs';
import { CLAUDE_CAPTURE_SHOTS } from '@/devsupport/claudeCapture';
import { renderCaptureCells, renderCaptureRows, type RenderedCell } from '../helpers/renderCapture';

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

  /**
   * Regression cover for the iOS capture of 2026-10-08, which got no frames at
   * all, and for the older race behind it.
   *
   * The session row sits in one of two places depending on whether the mock's
   * tick-20 prompt has landed (Active, below the fold, before; the top of Idle,
   * after, where it stays because the flow leaves the prompt unanswered). The
   * flow once searched DOWN for it, which raced the move, then UP with
   * scrollUntilVisible, which passed only while the search beat tick 20: once
   * the prompt had landed, scrollUntilVisible never matched the row on iOS, nor
   * a fully visible child of it on Android, though both were on screen. Why is
   * not known. So the flow waits for the prompt's "Approve:" teaser, which
   * exists only after the move, and taps the row by id with no scroll at all.
   */
  it('waits for the prompt teaser before tapping the session row, and never scrolls to it', () => {
    const rowTapMatch = /^- tapOn:\n\s+id: "activity-row-mock-session-1"$/m.exec(flowSource.replace(/\r\n/g, '\n'));
    expect(rowTapMatch, 'the flow still taps the session row by id').not.toBeNull();
    const normalized = flowSource.replace(/\r\n/g, '\n');
    const rowTapAt = rowTapMatch?.index ?? -1;

    // The teaser wait is the command immediately before the tap.
    const before = normalized.slice(0, rowTapAt);
    const lastCommandAt = before.lastIndexOf('\n- ');
    const lastCommand = before.slice(lastCommandAt + 1);
    expect(lastCommand).toMatch(/^- extendedWaitUntil:\n\s+visible:\n\s+text: "Approve:\.\*"\n\s+timeout: (\d+)/);
    const timeoutMatch = /timeout: (\d+)/.exec(lastCommand);
    expect(Number(timeoutMatch?.[1])).toBeGreaterThanOrEqual(90_000);

    // Nothing anywhere in the flow scrolls to the row (or to anything of it).
    expect(normalized).not.toMatch(/scrollUntilVisible:\n\s+element:\n\s+id: "activity-row-mock-session-1/);
  });

  /**
   * Regression cover for the companion fix: SessionScreen resolves its lens
   * as route param -> the task's remembered lens -> a `terminal` default
   * (src/screens/task/SessionScreen.tsx). Until 2026-10-08 this flow tapped the
   * activity row before the mock's tick-20 prompt attached a `mode=chat` route
   * param to it, so the session opened on Terminal and only the flow's own
   * Chat tap could put the permission card on screen. The row is now tapped
   * after the prompt, so it opens on Chat, but the guarded Chat tap stays as
   * the safety net and must still come after the coach-mark is gone and
   * before the card is asserted.
   */
  it('dismisses the coach-mark, pages to Chat, then waits for the permission card - in that order', () => {
    // Non-vacuity guard: every anchor below must actually be found, or the
    // ordering comparison would pass by finding nothing to compare.
    const hintDismissalCompletesAt = flowSource.lastIndexOf('session-mode-hint');
    const chatTapAt = flowSource.indexOf('session-mode-chat');
    const permissionCardAssertedAt = flowSource.indexOf('permission-approve');
    expect(hintDismissalCompletesAt).toBeGreaterThanOrEqual(0);
    expect(chatTapAt).toBeGreaterThanOrEqual(0);
    expect(permissionCardAssertedAt).toBeGreaterThanOrEqual(0);

    // lastIndexOf on the hint id: it appears three times (the runFlow guard,
    // the tap, and the notVisible wait), and what matters is that dismissal
    // has FINISHED, not merely started, before the Chat tap fires.
    expect(hintDismissalCompletesAt).toBeLessThan(chatTapAt);
    expect(chatTapAt).toBeLessThan(permissionCardAssertedAt);
  });

  /**
   * Regression cover for a capture taken mid-transition: the file-diff screen's
   * lines exist as soon as it mounts, which on iOS 26 is before the push
   * animation ends, so a shot straight after the `file-diff-lines` wait caught
   * the page still sliding in (rounded corners, the window background at its
   * edge, the back button half-animated). The wait on the lines is satisfied by
   * the first frame, so only an explicit settle step between it and the shot
   * keeps the frame clean.
   */
  it('settles after the file diff opens and before its screenshot, so the push is not captured', () => {
    // Anchored on the takeScreenshot path, not the bare shot name: comments mention both.
    const shotMatch = /path:\s*\$\{OUTPUT_DIR\}\/06-file-diff/.exec(flowSource);
    expect(shotMatch, 'the flow still takes 06-file-diff').not.toBeNull();
    const shotAt = shotMatch?.index ?? -1;
    const linesWaitAt = flowSource.lastIndexOf('id: "file-diff-lines"', shotAt);
    expect(linesWaitAt, 'the flow still waits for file-diff-lines before the shot').toBeGreaterThanOrEqual(0);

    // Only a command line counts: a comment that mentions the step must not satisfy this.
    const settleCommand = /^[ \t]*- waitForAnimationToEnd:/m;
    expect(flowSource.slice(linesWaitAt, shotAt)).toMatch(settleCommand);
  });

  /**
   * Regression cover for Android's scrollbar flash. A scrollable flashes its
   * scrollbar on first layout or after a programmatic scroll and fades it about
   * a second later, and the settle step before each shot calls that thin strip
   * settled. 2026-10-08 shipped it twice on the phone's file diff (the diff is
   * wider than a phone, so a horizontal bar) and once on the 7-inch board (the
   * column-chip tap pages the list, so a vertical thumb). The scrollbar is not a
   * hierarchy node, so the flow waits a bounded time on a selector that never
   * exists; it must be OPTIONAL, or the wait would fail the flow instead of
   * merely elapsing.
   */
  it.each(['05-board', '06-file-diff'])('waits out the scrollbar flash after the settle and before %s', (shotName) => {
    const shotMatch = new RegExp(`path:\\s*\\$\\{OUTPUT_DIR\\}/${shotName}`).exec(flowSource);
    expect(shotMatch, `the flow still takes ${shotName}`).not.toBeNull();
    const shotAt = shotMatch?.index ?? -1;
    const settleAt = flowSource.lastIndexOf('- waitForAnimationToEnd:', shotAt);
    expect(settleAt, 'the settle step still precedes the shot').toBeGreaterThanOrEqual(0);

    const between = flowSource.slice(settleAt, shotAt);
    const fadeWait = /^[ \t]*- extendedWaitUntil:\n[ \t]+visible:\n[ \t]+id: "store-capture-scrollbar-fade"\n[ \t]+timeout: (\d+)\n[ \t]+optional: true$/m.exec(
      between.replace(/\r\n/g, '\n'),
    );
    expect(fadeWait, 'an optional bounded wait sits between the settle and the shot').not.toBeNull();
    expect(Number(fadeWait?.[1])).toBeGreaterThanOrEqual(1500);
  });
});

/**
 * The terminal mirror draws every grid of 48 rows or fewer in ONE reference
 * cell: the cell at which the desktop's resting grid (210x48) fills the pane's
 * HEIGHT (scripts/xterm-page/state.js, fontGeometry.js). So how many columns a
 * shelf shows is a property of the SHELF, not of the grid, and a grid fills a
 * shelf only if it has the reference rows and at least the shelf's visible
 * columns. Anything less leaves terminal background below and to the right.
 *
 * This used to model the OLD fit, where the font came from the grid's own rows.
 * Under that model a 44x38 capture "fit" every target; under the real one it
 * filled 49-64% of the pane's width (44 of 69 to 90 visible columns) and 79%
 * of its height on every shelf, with every diff line wrapped mid-identifier,
 * and the test stayed green until a human looked at a re-capture (task #100). The PNG was the right size and the
 * flow passed, which is this repo's green-but-worthless-artifact shape, so the
 * check is mechanical rather than an eye on every capture.
 *
 * The fixture meets it by being recorded NARROW and widened to the resting grid
 * (scripts/buildTerminalFixture.mjs): prose keeps the breaks it was recorded
 * with, inside the narrowest shelf, while rules and diff bands run out to 210.
 */
describe('the recorded terminal fills every shelf at the reference cell', () => {
  // The grid, the font clamps and the cell ratios are scripts/xterm-page/state.js's;
  // the 0.97 texture budget is an inline literal in heightFit.js's
  // textureCappedFontPx(). Duplicated deliberately: the page fragments are
  // browser scripts with no importable export, so the alternative is no check
  // at all.
  const REFERENCE_GRID_COLS = 210;
  const REFERENCE_GRID_ROWS = 48;
  const MIN_AUTO_FONT_PX = 6;
  const MAX_AUTO_FIT_FONT_PX = 20;
  const CELL_WIDTH_RATIO = 0.6;
  const CELL_HEIGHT_RATIO = 1.2;
  const TEXTURE_BUDGET_RATIO = 0.97;

  interface ShelfPane {
    readonly name: string;
    /** The terminal pane's height in CSS px: what the reference rows are fitted to. */
    readonly fitHeightPx: number;
    /** The pane's width in DEVICE px. The cell is floored to device pixels, so this is the honest unit. */
    readonly paneWidthDevicePx: number;
    readonly devicePixelRatio: number;
    /** The WebGL texture limit, or null where it is too high to bind the reference grid. */
    readonly maxTextureSize: number | null;
    /** The cell width MEASURED off a real capture, in device px. */
    readonly measuredCellWidthDevicePx: number;
  }

  /**
   * MEASURED, not estimated. The pane bounds and the cell are read pixel by
   * pixel off task #99's re-captures of 02-session-terminal (2026-10-06, the
   * first captures taken after the reference cell landed): the pane is the
   * terminal-background run between the header and the quick-key bar, and the
   * cell is the then-committed 44x38 fixture's diff band divided by its 44
   * columns.
   *
   * The 10-inch shelf's 18px cell is what pins its texture limit: the height fit
   * alone gives font 17 (a 20px cell), and only a 4096 limit caps the 210-column
   * reference grid to font 15. iOS's font 11 is above what a 4096 limit allows
   * (10), so its limit is higher and does not bind.
   */
  const SHELF_PANES: readonly ShelfPane[] = [
    {
      name: 'iPhone 6.9-inch',
      fitHeightPx: 681,
      paneWidthDevicePx: 1320,
      devicePixelRatio: 3,
      maxTextureSize: null,
      measuredCellWidthDevicePx: 19,
    },
    {
      name: 'Android phone',
      fitHeightPx: 410,
      paneWidthDevicePx: 1080,
      devicePixelRatio: 3,
      maxTextureSize: 4096,
      measuredCellWidthDevicePx: 12,
    },
    {
      name: 'Android 7-inch',
      fitHeightPx: 825,
      paneWidthDevicePx: 1080,
      devicePixelRatio: 1.75,
      maxTextureSize: 4096,
      measuredCellWidthDevicePx: 14,
    },
    {
      name: 'Android 10-inch',
      fitHeightPx: 998,
      paneWidthDevicePx: 1440,
      devicePixelRatio: 2,
      maxTextureSize: 4096,
      measuredCellWidthDevicePx: 18,
    },
  ];

  /** The reference cell's font on a shelf: referenceFontPx() and textureCappedFontPx() in the page. */
  function referenceFontPx(shelf: ShelfPane): number {
    const fitted = Math.floor(shelf.fitHeightPx / (REFERENCE_GRID_ROWS * CELL_HEIGHT_RATIO));
    const fontPx = Math.max(MIN_AUTO_FONT_PX, Math.min(MAX_AUTO_FIT_FONT_PX, fitted));
    if (shelf.maxTextureSize === null) return fontPx;
    const budget = shelf.maxTextureSize * TEXTURE_BUDGET_RATIO;
    const widthCap = budget / (REFERENCE_GRID_COLS * CELL_WIDTH_RATIO * shelf.devicePixelRatio);
    const heightCap = budget / (REFERENCE_GRID_ROWS * CELL_HEIGHT_RATIO * shelf.devicePixelRatio);
    return Math.min(fontPx, Math.max(1, Math.floor(Math.min(widthCap, heightCap))));
  }

  /** xterm floors the cell to whole device pixels; the epsilon keeps 18.0000001 from reading as 18. */
  function cellWidthDevicePx(shelf: ShelfPane): number {
    return Math.floor(referenceFontPx(shelf) * CELL_WIDTH_RATIO * shelf.devicePixelRatio + 1e-9);
  }

  function visibleColumns(shelf: ShelfPane): number {
    return Math.floor(shelf.paneWidthDevicePx / cellWidthDevicePx(shelf));
  }

  const narrowestVisibleColumns = Math.min(...SHELF_PANES.map(visibleColumns));
  const widestVisibleColumns = Math.max(...SHELF_PANES.map(visibleColumns));

  const HORIZONTAL_RULE_GLYPHS = '─━┄┅┈┉╌╍═';

  /**
   * A diff line's colour band: Claude Code paints it from a column or so in,
   * under the line-number gutter, so a background anywhere in the first few
   * cells marks the row. Returns the band's colour, or null.
   */
  function bandBackground(row: readonly RenderedCell[]): string | null {
    const painted = row.slice(0, 4).find((cell) => cell.background !== 'default');
    return painted ? painted.background : null;
  }

  function rowText(row: readonly RenderedCell[]): string {
    return row.map((cell) => cell.glyph).join('');
  }

  /** The settled capture cell by cell, rendered once for every test below that reads cells. */
  let settledCells: RenderedCell[][] = [];
  beforeAll(async () => {
    settledCells = await renderCaptureCells(CLAUDE_CAPTURE_SHOTS);
  });

  it("still uses the page's own grid, font clamps, cell ratios and texture budget", () => {
    // The constants above are copies, so this model would go stale without a sound the day one of
    // them is retuned in the page: every column count below would then describe a terminal the
    // phone no longer draws. Read the page scripts as text (they are browser fragments with no
    // export to import) and compare each declaration with the copy.
    const pageDirectory = '../../scripts/xterm-page/';
    const stateSource = readFileSync(fileURLToPath(new URL(`${pageDirectory}state.js`, import.meta.url)), 'utf8');
    const heightFitSource = readFileSync(fileURLToPath(new URL(`${pageDirectory}heightFit.js`, import.meta.url)), 'utf8');

    /** The number a `var NAME = <number>;` declaration gives, or null when there is no such declaration. */
    function declaredNumber(source: string, name: string): number | null {
      const match = new RegExp(`\\bvar ${name} = ([0-9.]+);`).exec(source);
      return match === null ? null : Number(match[1]);
    }

    const modelled = {
      REFERENCE_GRID_COLS,
      REFERENCE_GRID_ROWS,
      MIN_AUTO_FONT_PX,
      MAX_AUTO_FIT_FONT_PX,
      CELL_WIDTH_RATIO,
      CELL_HEIGHT_RATIO,
    };
    const declared = Object.fromEntries(
      Object.keys(modelled).map((name) => [name, declaredNumber(stateSource, name)]),
    );
    expect(declared).toEqual(modelled);

    // textureCappedFontPx's budget is an inline literal, not a named constant.
    const budgetMatch = /var budget = maxGlTextureSize \* ([0-9.]+);/.exec(heightFitSource);
    expect(budgetMatch, 'heightFit.js still computes `var budget = maxGlTextureSize * <ratio>;`').not.toBeNull();
    expect(Number(budgetMatch?.[1])).toBe(TEXTURE_BUDGET_RATIO);
  });

  it('reproduces the cell measured on every shelf', () => {
    // Anchors the model to the captures. If this drifts, a pane measurement is
    // wrong and every column count below is wrong with it.
    expect(
      SHELF_PANES.map((shelf) => ({ shelf: shelf.name, cell: cellWidthDevicePx(shelf) })),
    ).toEqual(SHELF_PANES.map((shelf) => ({ shelf: shelf.name, cell: shelf.measuredCellWidthDevicePx })));
  });

  it('has the reference rows, so the frame fills the pane height exactly', () => {
    // Fewer rows leave a band of terminal background below the frame; more
    // would refit the cell to the grid's own rows and shrink it.
    expect(CLAUDE_CAPTURE_SHOTS.rows).toBe(REFERENCE_GRID_ROWS);
  });

  it('reaches the right edge of every shelf without moving the cell', () => {
    for (const shelf of SHELF_PANES) {
      expect({ shelf: shelf.name, reachesEdge: CLAUDE_CAPTURE_SHOTS.cols >= visibleColumns(shelf) }).toEqual({
        shelf: shelf.name,
        reachesEdge: true,
      });
    }
    // Wider than the reference grid moves the texture cap, and so the cell.
    expect(CLAUDE_CAPTURE_SHOTS.cols).toBeLessThanOrEqual(REFERENCE_GRID_COLS);
  });

  it('keeps every word inside the narrowest shelf, and the same fill at every shelf edge', () => {
    // Across the band of columns where some shelf's right edge falls - from the
    // narrowest shelf's last visible column to the widest's - every cell of a
    // row must look the same. Text there would be cut mid-word on iOS, and a
    // band or rule that stopped there would end mid-pane on a wider shelf.
    // Columns past the widest shelf are on no screen until panned to, which is
    // where a real 210-column session puts its padding and borders too.
    const cells = settledCells;
    const offenders: string[] = [];
    cells.forEach((row, rowIndex) => {
      const edges = row.slice(narrowestVisibleColumns - 1, widestVisibleColumns);
      const distinct = new Set(edges.map((cell) => `${cell.glyph}|${cell.background}`));
      if (distinct.size > 1) offenders.push(`row ${rowIndex}: ${[...distinct].join(' / ')}`);
    });
    expect(offenders).toEqual([]);
  });

  it('runs every diff band and every rule past the widest shelf edge', () => {
    const cells = settledCells;
    const widestEdge = widestVisibleColumns - 1;
    const bandRows = cells.filter((row) => bandBackground(row) !== null);
    const ruleRows = cells.filter((row) => new RegExp(`[${HORIZONTAL_RULE_GLYPHS}]{8}`).test(rowText(row)));
    // Non-vacuity: the capture is a diff under a permission dialog, so both
    // kinds of row must exist for the assertions below to mean anything.
    expect(bandRows.length).toBeGreaterThan(0);
    expect(ruleRows.length).toBeGreaterThanOrEqual(2);

    // Optional reads: a grid narrower than the widest shelf has no cell there,
    // which is a short band or rule, not a crash.
    const shortBands = bandRows
      .filter((row) => row[widestEdge]?.background !== bandBackground(row))
      .map((row) => rowText(row).trimEnd());
    expect(shortBands).toEqual([]);
    const shortRules = ruleRows
      .filter((row) => !HORIZONTAL_RULE_GLYPHS.includes(row[widestEdge]?.glyph ?? ''))
      .map((row) => rowText(row).trimEnd());
    expect(shortRules).toEqual([]);
  });

  it('wraps no diff line', () => {
    // Claude Code wraps a code line that is wider than its diff box onto a
    // continuation row with no line number - "-n.pathname" under
    // "window.locatio" - painted in the same added/removed colour. So the diff
    // colours are the ones on rows that DO open on a line number, and every row
    // in one of those colours must open on its own. (The submitted prompt is a
    // band too, in its own colour, and wraps like any prose.)
    const cells = settledCells;
    const lineNumbered = /^\s*\d+\s*[-+]/;
    const diffColours = new Set(
      cells.filter((row) => lineNumbered.test(rowText(row))).map((row) => bandBackground(row)),
    );
    diffColours.delete(null);
    expect(diffColours.size).toBeGreaterThan(0);
    const continuationRows = cells
      .filter((row) => diffColours.has(bandBackground(row)))
      .map((row) => rowText(row).trimEnd())
      .filter((text) => !lineNumbered.test(text));
    expect(continuationRows).toEqual([]);
  });

  // No font-size floor. At the reference cell the Android phone shelf renders
  // at about 7px, and no fixture can change that: one cell for every open is a
  // product rule (maintainer decision, 2026-10). If 7px reads too small in the
  // listing, that is a product question, not something to work around here.

  it('renders no row wider than the grid it reports', async () => {
    // A capture replayed at a grid it was not recorded at overflows its own
    // columns, and the phone shows borders sliced mid-glyph rather than a wide
    // frame.
    const rows = await renderCaptureRows(CLAUDE_CAPTURE_SHOTS);
    const tooWide = rows
      .filter((row) => [...row].length > CLAUDE_CAPTURE_SHOTS.cols)
      .map((row) => `${[...row].length} cols: ${row}`);
    expect(tooWide).toEqual([]);
  });
});
