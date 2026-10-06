/**
 * Covers scripts/terminalFrame.mjs, the port of the desktop's physical-row
 * serializer and frame-widening rules that the store-screenshot terminal
 * fixture is built with.
 *
 * The widening vectors are the desktop's own (kangentic
 * tests/unit/demo-frame-fit.test.ts), restated as (row, extra columns,
 * recorded width): they pin each rule as one input/output pair, which states
 * the rules more exactly than any prose, and keeps the port honest against the
 * implementation it came from.
 */
import { Terminal } from '@xterm/headless';
import { describe, expect, it } from 'vitest';

import {
  ALT_PREFIX,
  parsePhysicalFrame,
  serializeModes,
  serializePhysicalRows,
  widenFrame,
  widenRow,
  withRelativeCursor,
} from '../../scripts/terminalFrame.mjs';

/** fitRow(row, cols, recordedCols) in the desktop's vectors is widenRow(row, cols - recordedCols, recordedCols) here. */
function fitWider(row: string, cols: number, recordedCols: number): string {
  return widenRow(row, cols - recordedCols, recordedCols);
}

describe('widenRow', () => {
  it('moves a right-hand scrollbar to a wider edge, growing the gap before it', () => {
    expect(fitWider('ab\x1b[7C┃', 14, 10)).toBe('ab\x1b[11C┃');
    expect(fitWider('abc      ┃', 14, 10)).toBe('abc\x1b[4X\x1b[4C      ┃');
  });

  it('widens a box before its right side and keeps its left side where it was', () => {
    expect(fitWider('│\x1b[6C│ ┃', 14, 10)).toBe('│\x1b[10C│ ┃');
    expect(fitWider('╰──────╯ ┃', 14, 10)).toBe('╰──────────╯ ┃');
    expect(fitWider(' ▄▄▄▄▄▄▄ ┃', 14, 10)).toBe(' ▄▄▄▄▄▄▄▄▄▄▄ ┃');
    expect(fitWider('│ ab     │', 16, 12)).toBe('│ ab\x1b[4X\x1b[4C     │');
    expect(fitWider('╭────────╮', 16, 12)).toBe('╭────────────╮');
  });

  it('grows a background band that reaches the edge, and leaves one that stops short alone', () => {
    expect(fitWider('\x1b[48;5;236m \x1b[9X\x1b[0m', 14, 10)).toBe('\x1b[48;5;236m \x1b[13X\x1b[0m');
    // A diff line's band, erased and stepped over, a few columns short of the edge.
    expect(fitWider('\x1b[48;5;22m+ a\x1b[4X\x1b[4C\x1b[0m', 14, 10)).toBe('\x1b[48;5;22m+ a\x1b[8X\x1b[8C\x1b[0m');
    expect(fitWider('\x1b[48;5;22m+ a\x1b[2X\x1b[2C\x1b[0m', 40, 30)).toBe('\x1b[48;5;22m+ a\x1b[2X\x1b[2C\x1b[0m');
  });

  it('runs a rule and a panel background on to the new edge, only from rows that reached the old one', () => {
    expect(fitWider('──────────', 14, 10)).toBe('──────────────');
    expect(fitWider('\x1b[48;5;236mab        \x1b[0m', 14, 10)).toBe('\x1b[48;5;236mab            \x1b[0m');
    // A short rule is content: it stays its length.
    expect(fitWider('────', 40, 30)).toBe('────');
    // Plain text that reached the edge is prose the CLI wrapped there: nothing is added.
    expect(fitWider('abcdefghij', 14, 10)).toBe('abcdefghij');
  });

  it('moves right-aligned text out with its gap, and never pulls prose apart', () => {
    expect(fitWider('mode\x1b[4C/rc', 14, 12)).toBe('mode\x1b[6C/rc');
    expect(fitWider('main\x1b[3C\x1b[0m \x1b[90mSession\x1b[0m', 19, 16)).toBe(
      'main\x1b[6C\x1b[0m \x1b[90mSession\x1b[0m',
    );
    expect(fitWider('mode\x1b[1Cagent   \x1b[10C◐\x1b[1Cmedium\x1b[1C·\x1b[1C/effort', 47, 43)).toBe(
      'mode\x1b[1Cagent   \x1b[14C◐\x1b[1Cmedium\x1b[1C·\x1b[1C/effort',
    );
    expect(fitWider('\x1b[9C/rc', 18, 14)).toBe('\x1b[13C/rc');
    expect(fitWider('the\x1b[1Cquick\x1b[1Cbrown', 20, 15)).toBe('the\x1b[1Cquick\x1b[1Cbrown');
    expect(fitWider('     some indented prose', 30, 25)).toBe('     some indented prose');
    expect(fitWider('  f:1:     await a.b(c, d, e, f)', 40, 33)).toBe('  f:1:     await a.b(c, d, e, f)');
    expect(fitWider('ab      cd', 14, 10)).toBe('ab      cd');
  });

  it('keeps right-aligned text against a border, and a truncated line where it was', () => {
    expect(fitWider('ab      10s ┃', 17, 13)).toBe('ab          10s ┃');
    expect(fitWider('│ a =>     bcd… │', 21, 17)).toBe('│ a =>     bcd…\x1b[4X\x1b[4C │');
    expect(fitWider('│ a │     b │', 17, 13)).toBe('│ a │     b\x1b[4X\x1b[4C │');
  });

  it('refuses a row wider than the width it was supposedly recorded at', () => {
    expect(() => widenRow('abcdefghijk', 4, 10)).toThrow(/11-cell row/);
  });
});

function createTerminal(cols: number, rows: number): Terminal {
  return new Terminal({ cols, rows, scrollback: 50, allowProposedApi: true });
}

function flush(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolveFlush) => terminal.write(data, resolveFlush));
}

interface CellSnapshot {
  readonly glyph: string;
  readonly foreground: string;
  readonly background: string;
  readonly bold: boolean;
}

function snapshotScreen(terminal: Terminal): CellSnapshot[][] {
  const buffer = terminal.buffer.active;
  const scratchCell = buffer.getNullCell();
  const screen: CellSnapshot[][] = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    const cells: CellSnapshot[] = [];
    for (let column = 0; column < terminal.cols; column += 1) {
      const cell = line?.getCell(column, scratchCell);
      cells.push({
        glyph: cell?.getChars() || ' ',
        foreground: cell ? `${cell.getFgColorMode()}:${cell.getFgColor()}` : 'none',
        background: cell ? `${cell.getBgColorMode()}:${cell.getBgColor()}` : 'none',
        bold: cell ? cell.isBold() !== 0 : false,
      });
    }
    screen.push(cells);
  }
  return screen;
}

/**
 * Every attribute a cell can carry, none folded away. snapshotScreen above keeps
 * only the glyph, the colours and bold, so a regression that dropped italic,
 * dim, inverse, underline or any other flag from a replay passes it. The tests
 * that depend on those flags (the style diff, the spaces that paint) compare
 * this instead.
 */
interface RichCellSnapshot {
  readonly glyph: string;
  readonly foreground: string;
  readonly background: string;
  readonly inverse: boolean;
  readonly bold: boolean;
  readonly underline: boolean;
  readonly overline: boolean;
  readonly blink: boolean;
  readonly invisible: boolean;
  readonly italic: boolean;
  readonly dim: boolean;
  readonly strikethrough: boolean;
}

type CellFlagName = Exclude<keyof RichCellSnapshot, 'glyph' | 'foreground' | 'background'>;

function snapshotScreenRich(terminal: Terminal): RichCellSnapshot[][] {
  const buffer = terminal.buffer.active;
  const scratchCell = buffer.getNullCell();
  const screen: RichCellSnapshot[][] = [];
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    const cells: RichCellSnapshot[] = [];
    for (let column = 0; column < terminal.cols; column += 1) {
      const cell = line?.getCell(column, scratchCell);
      if (!cell) throw new Error(`no cell at row ${row}, column ${column}`);
      cells.push({
        glyph: cell.getChars() || ' ',
        foreground: `${cell.getFgColorMode()}:${cell.getFgColor()}`,
        background: `${cell.getBgColorMode()}:${cell.getBgColor()}`,
        // The getters return the flag's bit, not a boolean: normalise so a snapshot reads as one.
        inverse: cell.isInverse() !== 0,
        bold: cell.isBold() !== 0,
        underline: cell.isUnderline() !== 0,
        overline: cell.isOverline() !== 0,
        blink: cell.isBlink() !== 0,
        invisible: cell.isInvisible() !== 0,
        italic: cell.isItalic() !== 0,
        dim: cell.isDim() !== 0,
        strikethrough: cell.isStrikethrough() !== 0,
      });
    }
    screen.push(cells);
  }
  return screen;
}

const CELL_FLAG_NAMES: readonly CellFlagName[] = [
  'inverse',
  'bold',
  'underline',
  'overline',
  'blink',
  'invisible',
  'italic',
  'dim',
  'strikethrough',
];
/** What xterm reports for a cell with no colour set. */
const DEFAULT_COLOUR = '0:-1';

/**
 * A row of cells as one string, a cell that carries anything but the default
 * written as `glyph{what it carries}`. Equal strings mean equal cells (nothing is
 * dropped), and an unequal pair fails with a diff of one line per row instead of
 * a wall of per-cell objects.
 */
function describeCells(cells: readonly RichCellSnapshot[]): string {
  return cells
    .map((cell) => {
      const carries: string[] = [];
      if (cell.foreground !== DEFAULT_COLOUR) carries.push(`fg=${cell.foreground}`);
      if (cell.background !== DEFAULT_COLOUR) carries.push(`bg=${cell.background}`);
      for (const flagName of CELL_FLAG_NAMES) if (cell[flagName]) carries.push(flagName);
      return carries.length === 0 ? cell.glyph : `${cell.glyph}{${carries.join(',')}}`;
    })
    .join('');
}

function describeScreen(terminal: Terminal): string[] {
  return snapshotScreenRich(terminal).map(describeCells);
}

interface RoundTrip {
  readonly source: Terminal;
  readonly replay: Terminal;
  readonly frame: string;
}

/** Writes `sourceBytes` to a terminal, serializes its screen, and replays the frame into a second terminal of the same size. */
async function roundTrip(
  sourceBytes: string,
  columns: number = RECORDED_COLUMNS,
  rows: number = RECORDED_ROWS,
): Promise<RoundTrip> {
  const source = createTerminal(columns, rows);
  await flush(source, sourceBytes);
  const frame = serializePhysicalRows(source);
  const replay = createTerminal(columns, rows);
  await flush(replay, frame);
  return { source, replay, frame };
}

/**
 * A small alt-screen TUI frame with the shapes a Claude Code diff frame has: a
 * rule to the edge, prose long enough to soft-wrap, a background band erased to
 * the edge, and a styled word.
 */
const RECORDED_COLUMNS = 20;
const RECORDED_ROWS = 6;
const SAMPLE_TUI =
  '\x1b[?1049h\x1b[H' +
  '─'.repeat(RECORDED_COLUMNS) +
  '\r\n' +
  'a sentence long enough to wrap onto a second row' +
  '\r\n' +
  '\x1b[48;5;22m 9 + const x = 1;\x1b[K\x1b[0m' +
  '\r\n' +
  '\x1b[1mbold\x1b[0m tail' +
  '\x1b[2;5H';

describe('serializePhysicalRows', () => {
  it('replays at the recorded grid to the identical screen, styles included', async () => {
    const source = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    await flush(source, SAMPLE_TUI);
    const frame = serializePhysicalRows(source);

    const replay = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    await flush(replay, frame);
    expect(snapshotScreen(replay)).toEqual(snapshotScreen(source));
    expect(replay.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
    expect(replay.buffer.active.cursorX).toBe(source.buffer.active.cursorX);
  });

  it('writes a soft-wrapped line as two physical rows, so it cannot spill at another width', async () => {
    const source = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    await flush(source, SAMPLE_TUI);
    const parsed = parsePhysicalFrame(serializePhysicalRows(source));
    expect(parsed.isAlternate).toBe(true);
    // Row 0 is the rule; the prose occupies rows 1-3 at 20 columns.
    expect(parsed.rows[1]).toBe('a sentence long enou');
    expect(parsed.rows[2]).toBe('gh to wrap onto a se');
    expect(parsed.cursor).toEqual({ row: 1, column: 4 });
  });
});

describe('widenFrame', () => {
  it('keeps every recorded cell, and adds only fill past the recorded width', async () => {
    const source = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    await flush(source, SAMPLE_TUI);
    const widened = widenFrame(
      serializePhysicalRows(source),
      { cols: 32, rows: RECORDED_ROWS },
      { cols: RECORDED_COLUMNS, rows: RECORDED_ROWS },
    );
    expect(widened.startsWith(ALT_PREFIX)).toBe(true);

    const replay = createTerminal(32, RECORDED_ROWS);
    await flush(replay, widened);
    const recordedScreen = snapshotScreen(source);
    const widenedScreen = snapshotScreen(replay);
    widenedScreen.forEach((row, rowIndex) => {
      expect(row.slice(0, RECORDED_COLUMNS)).toEqual(recordedScreen[rowIndex]);
    });

    // The rule and the band run on to the new edge; the prose rows stay blank past the old one.
    expect(widenedScreen[0].map((cell) => cell.glyph).join('')).toBe('─'.repeat(32));
    const bandRow = widenedScreen.find((row) => row[0].background !== widenedScreen[0][0].background);
    expect(bandRow?.[31].background).toBe(bandRow?.[0].background);
    expect(widenedScreen[1].slice(RECORDED_COLUMNS).every((cell) => cell.glyph === ' ')).toBe(true);
    // The cursor is put back where the CLI left it.
    expect(replay.buffer.active.cursorY).toBe(1);
    expect(replay.buffer.active.cursorX).toBe(4);
    // Autowrap is restored after the rows are written.
    expect(widened).toContain('\x1b[?7l');
    expect(widened.indexOf('\x1b[?7h')).toBeGreaterThan(widened.indexOf('\x1b[?7l'));
  });

  it('widens a band whose row ends in a stray foreground-only space', async () => {
    // Claude Code's full-screen renderer leaves one blank cell with only a
    // foreground colour at the right edge of some diff rows, after the band.
    // Serialized as a styled space it became the row's last painted thing, the
    // panel-padding rule fired instead of the band rule, and the band stopped at
    // the recorded width on two rows of the first 66-column take.
    const source = createTerminal(20, 2);
    await flush(source, '\x1b[48;5;22m + x\x1b[15X\x1b[20G\x1b[0m\x1b[38;5;245m \x1b[0m');
    const widened = widenFrame(serializePhysicalRows(source), { cols: 30, rows: 2 }, { cols: 20, rows: 2 });
    const replay = createTerminal(30, 2);
    await flush(replay, widened);
    const row = snapshotScreen(replay)[0];
    expect(row[28].background).toBe(row[1].background);
  });

  it('refuses a narrower or a differently tall grid rather than guessing', () => {
    const frame = `${ALT_PREFIX}abc\x1b[1;1H`;
    expect(() => widenFrame(frame, { cols: 10, rows: 5 }, { cols: 20, rows: 5 })).toThrow(/only widens/);
    expect(() => widenFrame(frame, { cols: 30, rows: 6 }, { cols: 20, rows: 5 })).toThrow(/row count/);
  });

  it('refuses a frame with no trailing cursor position', () => {
    expect(() => widenFrame('abc', { cols: 30, rows: 5 }, { cols: 20, rows: 5 })).toThrow(/physical-row frame/);
  });
});

describe('withRelativeCursor', () => {
  it('lands the cursor on the same cell with no absolute position left in the frame', async () => {
    const source = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    await flush(source, SAMPLE_TUI);
    const relative = withRelativeCursor(serializePhysicalRows(source));
    // An absolute CUP is what the phone's live-tail cleaner reads as a full
    // repaint and resets on; only the alt-screen prefix's home may remain.
    expect(relative.slice(ALT_PREFIX.length)).not.toMatch(/\x1b\[\d*;?\d*[Hf]/);

    const replay = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    await flush(replay, relative);
    expect(snapshotScreen(replay)).toEqual(snapshotScreen(source));
    expect(replay.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
    expect(replay.buffer.active.cursorX).toBe(source.buffer.active.cursorX);
  });

  it('works on a widened frame, whose last row may run to the grid edge', async () => {
    const source = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    await flush(source, SAMPLE_TUI);
    const widened = widenFrame(
      serializePhysicalRows(source),
      { cols: 32, rows: RECORDED_ROWS },
      { cols: RECORDED_COLUMNS, rows: RECORDED_ROWS },
    );
    const replay = createTerminal(32, RECORDED_ROWS);
    await flush(replay, withRelativeCursor(widened));
    expect(replay.buffer.active.cursorY).toBe(1);
    expect(replay.buffer.active.cursorX).toBe(4);
  });
});

describe('serializeModes', () => {
  it('re-emits the modes the recording left on, in the addon order', async () => {
    const terminal = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    await flush(terminal, '\x1b[?1003h\x1b[?2004h\x1b[?1004h');
    expect(serializeModes(terminal)).toBe('\x1b[?2004h\x1b[?1004h\x1b[?1003h');
  });

  it('emits nothing for a terminal in its default modes', () => {
    expect(serializeModes(createTerminal(RECORDED_COLUMNS, RECORDED_ROWS))).toBe('');
  });

  type TerminalModes = Terminal['modes'];
  interface ModeCase {
    readonly label: string;
    /** What a program writes to turn the mode on (DEC private mode numbers from the xterm control-sequence reference). */
    readonly enable: string;
    /** What a seed must carry to turn it back on in the phone's terminal. */
    readonly expected: string;
    readonly isOn: (modes: TerminalModes) => boolean;
  }
  const MODE_CASES: readonly ModeCase[] = [
    { label: 'application cursor keys', enable: '\x1b[?1h', expected: '\x1b[?1h', isOn: (modes) => modes.applicationCursorKeysMode },
    { label: 'application keypad (DECNKM)', enable: '\x1b[?66h', expected: '\x1b[?66h', isOn: (modes) => modes.applicationKeypadMode },
    { label: 'application keypad (DECKPAM)', enable: '\x1b=', expected: '\x1b[?66h', isOn: (modes) => modes.applicationKeypadMode },
    { label: 'insert mode', enable: '\x1b[4h', expected: '\x1b[4h', isOn: (modes) => modes.insertMode },
    { label: 'origin mode', enable: '\x1b[?6h', expected: '\x1b[?6h', isOn: (modes) => modes.originMode },
    { label: 'reverse wraparound', enable: '\x1b[?45h', expected: '\x1b[?45h', isOn: (modes) => modes.reverseWraparoundMode },
    { label: 'wraparound turned off', enable: '\x1b[?7l', expected: '\x1b[?7l', isOn: (modes) => modes.wraparoundMode === false },
    { label: 'x10 mouse tracking', enable: '\x1b[?9h', expected: '\x1b[?9h', isOn: (modes) => modes.mouseTrackingMode === 'x10' },
    { label: 'vt200 mouse tracking', enable: '\x1b[?1000h', expected: '\x1b[?1000h', isOn: (modes) => modes.mouseTrackingMode === 'vt200' },
    { label: 'drag mouse tracking', enable: '\x1b[?1002h', expected: '\x1b[?1002h', isOn: (modes) => modes.mouseTrackingMode === 'drag' },
  ];

  // Each mode is checked three ways. The source terminal must report it itself, so a
  // mode the headless xterm does not surface fails loudly here instead of passing on
  // an empty serialization. The seed must be the sequence that sets it. And the seed,
  // replayed into a fresh terminal, must leave that terminal reporting the same modes.
  it.each(MODE_CASES)('re-emits $label as the sequence that sets it', async ({ enable, expected, isOn }) => {
    const source = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    await flush(source, enable);
    expect(isOn(source.modes)).toBe(true);

    const serialized = serializeModes(source);
    expect(serialized).toBe(expected);

    const replay = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    await flush(replay, serialized);
    expect(isOn(replay.modes)).toBe(true);
    expect({ ...replay.modes }).toEqual({ ...source.modes });
  });
});

describe('serializePhysicalRows on a normal buffer with scrollback', () => {
  it('keeps only the visible rows, so nothing scrolled off the top reaches a fixture', async () => {
    // On the recording machine the rows above the screen are the shell banner, which names the
    // operator. A fixture is published, so the banner must not survive serialization.
    // Every line fits the 20 columns, so none soft-wraps and the counts below are exact.
    const historyLines = ['banner dev@host', 'history one', 'history two', 'history three', 'history four'];
    const visibleLines = ['visible one', 'visible two', 'visible three', 'visible four', 'visible five', 'visible six'];
    const source = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    // Written with CRLF, then the cursor is moved up two rows and to column 4 so it is neither on the
    // last row nor at column 0, and a frame that placed it by the wrong row or column cannot match.
    await flush(source, `${[...historyLines, ...visibleLines].join('\r\n')}\x1b[2A\x1b[4G`);
    // Non-vacuity: the banner really did scroll off, on the normal buffer.
    expect(source.buffer.active.type).toBe('normal');
    expect(source.buffer.active.baseY).toBe(historyLines.length);
    expect(source.buffer.active.cursorY).toBe(RECORDED_ROWS - 3);
    expect(source.buffer.active.cursorX).toBe(3);

    const frame = serializePhysicalRows(source);
    expect(frame.startsWith(ALT_PREFIX)).toBe(false);
    expect(frame).not.toContain('banner');
    expect(frame).not.toContain('history');
    const parsed = parsePhysicalFrame(frame);
    expect(parsed.isAlternate).toBe(false);
    expect(parsed.rows).toEqual(visibleLines);
    expect(parsed.cursor).toEqual({ row: 3, column: 3 });

    const replay = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
    await flush(replay, frame);
    expect(snapshotScreen(replay)).toEqual(snapshotScreen(source));
    expect(replay.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
    expect(replay.buffer.active.cursorX).toBe(source.buffer.active.cursorX);
  });
});

describe('serializePhysicalRows gaps inside a row', () => {
  it('writes cells that were never written between two words as one cursor-forward, painting nothing', async () => {
    const { source, replay, frame } = await roundTrip('a\x1b[5Cb');
    expect(parsePhysicalFrame(frame).rows[0]).toBe('a\x1b[5Cb');
    expect(describeScreen(replay)).toEqual(describeScreen(source));
  });

  it('does not let the background in force bleed into a gap that a cursor-forward skipped', async () => {
    // Cursor-forward moves without painting, so the three skipped cells keep the DEFAULT background
    // even though a painting one is active on both sides of them.
    const { source, replay, frame } = await roundTrip('\x1b[48;5;22ma\x1b[3Cb\x1b[0m');
    const sourceRow = snapshotScreenRich(source)[0];
    expect(sourceRow[1].background).not.toBe(sourceRow[0].background);
    expect(parsePhysicalFrame(frame).rows[0]).not.toContain('X');
    expect(describeScreen(replay)).toEqual(describeScreen(source));
  });

  it('erases a gap to the background when the gap itself was painted, then steps over it', async () => {
    // Erase-characters paints the cells with the current background, so a bare cursor-forward in the
    // frame would leave them in the default one.
    const { source, replay, frame } = await roundTrip('\x1b[48;5;22ma\x1b[3X\x1b[3Cb\x1b[0m');
    const sourceRow = snapshotScreenRich(source)[0];
    expect(sourceRow[1].background).toBe(sourceRow[0].background);
    expect(parsePhysicalFrame(frame).rows[0]).toContain('\x1b[3X\x1b[3C');
    expect(describeScreen(replay)).toEqual(describeScreen(source));
  });
});

describe('serializePhysicalRows style diff', () => {
  interface StyleCase {
    readonly label: string;
    readonly sgr: string;
    /** The cell field the style changes, which a replay that lost the style would leave at its default. */
    readonly field: keyof RichCellSnapshot;
  }
  const STYLE_CASES: readonly StyleCase[] = [
    { label: 'a normal palette foreground (31)', sgr: '31', field: 'foreground' },
    { label: 'a normal palette background (41)', sgr: '41', field: 'background' },
    { label: 'a bright palette foreground (91)', sgr: '91', field: 'foreground' },
    { label: 'a bright palette background (102)', sgr: '102', field: 'background' },
    { label: 'a 256-colour foreground (38;5;200)', sgr: '38;5;200', field: 'foreground' },
    { label: 'a 256-colour background (48;5;200)', sgr: '48;5;200', field: 'background' },
    { label: 'an RGB foreground (38;2;1;2;3)', sgr: '38;2;1;2;3', field: 'foreground' },
    { label: 'an RGB background (48;2;4;5;6)', sgr: '48;2;4;5;6', field: 'background' },
    { label: 'bold (1)', sgr: '1', field: 'bold' },
    { label: 'dim (2)', sgr: '2', field: 'dim' },
    { label: 'italic (3)', sgr: '3', field: 'italic' },
    { label: 'underline (4)', sgr: '4', field: 'underline' },
    { label: 'blink (5)', sgr: '5', field: 'blink' },
    { label: 'inverse (7)', sgr: '7', field: 'inverse' },
    { label: 'invisible (8)', sgr: '8', field: 'invisible' },
    { label: 'strikethrough (9)', sgr: '9', field: 'strikethrough' },
    { label: 'overline (53)', sgr: '53', field: 'overline' },
  ];

  it.each(STYLE_CASES)('replays $label cell for cell', async ({ sgr, field }) => {
    // 'ab' styled, then a default space and a default word, so the diff runs both ways.
    const { source, replay } = await roundTrip(`\x1b[${sgr}mab\x1b[0m cd`);
    const sourceRow = snapshotScreenRich(source)[0];
    // Non-vacuity: the style reached the source cells and is absent from the plain ones.
    expect(sourceRow[0][field]).not.toEqual(sourceRow[3][field]);
    expect(sourceRow[1][field]).toEqual(sourceRow[0][field]);
    expect(describeScreen(replay)).toEqual(describeScreen(source));
  });

  interface StyleOffCase {
    readonly label: string;
    /** Written before a reset and a plain 'z', which marks a cell with no style at all. */
    readonly bytes: string;
    readonly field: CellFlagName;
    /** Whether a colour stays on after the flag turns off, which is what makes the diff emit an off code and not a reset. */
    readonly keepsColour: boolean;
  }
  const STYLE_OFF_CASES: readonly StyleOffCase[] = [
    { label: 'bold off with a colour kept', bytes: '\x1b[1;31mab\x1b[22mcd', field: 'bold', keepsColour: true },
    { label: 'dim off with a colour kept', bytes: '\x1b[2;35mab\x1b[22mcd', field: 'dim', keepsColour: true },
    { label: 'italic off with a colour kept', bytes: '\x1b[3;32mab\x1b[23mcd', field: 'italic', keepsColour: true },
    { label: 'underline off with a colour kept', bytes: '\x1b[4;33mab\x1b[24mcd', field: 'underline', keepsColour: true },
    { label: 'blink off with a colour kept', bytes: '\x1b[5;31mab\x1b[25mcd', field: 'blink', keepsColour: true },
    { label: 'inverse off with a colour kept', bytes: '\x1b[7;34mab\x1b[27mcd', field: 'inverse', keepsColour: true },
    { label: 'invisible off with a colour kept', bytes: '\x1b[8;31mab\x1b[28mcd', field: 'invisible', keepsColour: true },
    { label: 'strikethrough off with a colour kept', bytes: '\x1b[9;36mab\x1b[29mcd', field: 'strikethrough', keepsColour: true },
    { label: 'overline off with a colour kept', bytes: '\x1b[53;31mab\x1b[55mcd', field: 'overline', keepsColour: true },
    // A style that ends at a blank cell: the space is default, so the diff is a full reset.
    { label: 'a bold word then a plain one', bytes: '\x1b[1mab\x1b[0m cd', field: 'bold', keepsColour: false },
    { label: 'an italic word then a plain one', bytes: '\x1b[3mab\x1b[0m cd', field: 'italic', keepsColour: false },
  ];

  it.each(STYLE_OFF_CASES)('replays $label cell for cell', async ({ bytes, field, keepsColour }) => {
    const { source, replay } = await roundTrip(`${bytes}\x1b[0mz`);
    const sourceRow = snapshotScreenRich(source)[0];
    const styledCell = sourceRow[0];
    const turnedOffCell = sourceRow.find((cell) => cell.glyph === 'c');
    const plainCell = sourceRow.find((cell) => cell.glyph === 'z');
    // Non-vacuity: the flag was on, then genuinely off, and the colour did or did not survive as asked.
    expect(styledCell[field]).toBe(true);
    expect(turnedOffCell?.[field]).toBe(false);
    if (keepsColour) expect(turnedOffCell?.foreground).not.toBe(plainCell?.foreground);
    expect(describeScreen(replay)).toEqual(describeScreen(source));
  });

  // SGR 22 turns off bold AND dim, so a step that drops one and keeps the other must set the
  // survivor again after the 22. @xterm/addon-serialize's _diffStyle, which diffStyle() otherwise
  // mirrors, writes a lone 22 (bold+dim to dim) or `1;22` (dim to bold) and loses it on replay.
  it.each([
    { label: 'keeps dim when bold turns off beside it (bold+dim to dim)', bytes: '\x1b[1;2mab\x1b[22;2mcd\x1b[0m' },
    { label: 'keeps bold when dim turns off and bold turns on in one step (dim to bold)', bytes: '\x1b[2mab\x1b[22;1mcd\x1b[0m' },
    { label: 'keeps bold when dim turns off beside it (bold+dim to bold)', bytes: '\x1b[1;2mab\x1b[22;1mcd\x1b[0m' },
    { label: 'turns both off at once (bold+dim to neither)', bytes: '\x1b[1;2;31mab\x1b[22mcd\x1b[0m' },
  ])('$label', async ({ bytes }) => {
    const { source, replay } = await roundTrip(bytes);
    expect(describeScreen(replay)).toEqual(describeScreen(source));
  });
});

describe('serializePhysicalRows keeps a space that paints', () => {
  // looksBlank() drops a foreground-only space (it draws nothing) but must keep one that
  // paints: a background, an inverse block, or a line through or under the cell.
  interface PaintingSpaceCase {
    readonly label: string;
    readonly sgr: string;
    readonly field: keyof RichCellSnapshot;
  }
  const PAINTING_SPACE_CASES: readonly PaintingSpaceCase[] = [
    { label: 'inverse', sgr: '7', field: 'inverse' },
    { label: 'underline', sgr: '4', field: 'underline' },
    { label: 'strikethrough', sgr: '9', field: 'strikethrough' },
    { label: 'overline', sgr: '53', field: 'overline' },
    { label: 'a background', sgr: '44', field: 'background' },
  ];
  const PLACEMENTS = [
    { placement: 'between two words', bytes: (sgr: string) => `ab\x1b[${sgr}m \x1b[0mcd`, column: 2 },
    // Trailing blanks are dropped from a row, so this is the placement a lazy blank check loses first.
    { placement: 'at the end of the row', bytes: (sgr: string) => `ab\x1b[${sgr}m \x1b[0m`, column: 2 },
  ] as const;

  it.each(PAINTING_SPACE_CASES.flatMap((paintingCase) => PLACEMENTS.map((placement) => ({ ...paintingCase, ...placement }))))(
    'survives serialization when it is $label, $placement',
    async ({ sgr, field, bytes, column }) => {
      const { source, replay } = await roundTrip(bytes(sgr));
      const sourceRow = snapshotScreenRich(source)[0];
      // Non-vacuity: the space itself carries the paint, and its neighbour does not.
      expect(sourceRow[column].glyph).toBe(' ');
      expect(sourceRow[column][field]).not.toEqual(sourceRow[column + 3][field]);
      expect(describeScreen(replay)).toEqual(describeScreen(source));
    },
  );

  it.each(PAINTING_SPACE_CASES.filter((paintingCase) => paintingCase.field !== 'background'))(
    'keeps a space with $label through widening, cell for cell inside the recorded width',
    async ({ sgr }) => {
      // Well short of the edge, so this tests that the cell is kept and not the panel-padding rule
      // that runs a styled tail on to the new edge.
      const source = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
      await flush(source, `ab\x1b[${sgr}m \x1b[0mcd`);
      const widened = widenFrame(
        serializePhysicalRows(source),
        { cols: 32, rows: RECORDED_ROWS },
        { cols: RECORDED_COLUMNS, rows: RECORDED_ROWS },
      );
      const replay = createTerminal(32, RECORDED_ROWS);
      await flush(replay, widened);
      const recordedScreen = snapshotScreenRich(source);
      snapshotScreenRich(replay).forEach((row, rowIndex) => {
        expect(describeCells(row.slice(0, RECORDED_COLUMNS))).toBe(describeCells(recordedScreen[rowIndex]));
      });
    },
  );
});

describe('withRelativeCursor edges', () => {
  interface CursorEdgeCase {
    readonly label: string;
    readonly bytes: string;
    readonly movesUp: boolean;
    readonly movesForward: boolean;
  }
  const CURSOR_EDGE_CASES: readonly CursorEdgeCase[] = [
    { label: 'on the last row, past column 0', bytes: 'first row\r\nsecond row', movesUp: false, movesForward: true },
    { label: 'at column 0, above the last row', bytes: 'first row\r\nsecond row\x1b[1;1H', movesUp: true, movesForward: false },
    { label: 'at column 0 of the last row', bytes: 'first row\r\nsecond row\r', movesUp: false, movesForward: false },
  ];

  // xterm reads a zero parameter as one, so a literal cursor-up or cursor-forward of 0 does not
  // stay put: it moves a cell. The move is omitted, and the cursor must still land on the right cell.
  it.each(CURSOR_EDGE_CASES)(
    'emits no zero-count move and still lands on the same cell, cursor $label',
    async ({ bytes, movesUp, movesForward }) => {
      const { source, frame } = await roundTrip(bytes);
      const relative = withRelativeCursor(frame);
      expect(relative.includes('\x1b[0A')).toBe(false);
      expect(relative.includes('\x1b[0C')).toBe(false);
      // The rows are plain text, so any cursor move left in the frame is the one withRelativeCursor added.
      expect(/\x1b\[\d*A/.test(relative)).toBe(movesUp);
      expect(/\x1b\[\d*C/.test(relative)).toBe(movesForward);

      const replay = createTerminal(RECORDED_COLUMNS, RECORDED_ROWS);
      await flush(replay, relative);
      expect(snapshotScreen(replay)).toEqual(snapshotScreen(source));
      expect(replay.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
      expect(replay.buffer.active.cursorX).toBe(source.buffer.active.cursorX);
    },
  );

  it('refuses a frame with no trailing cursor position', () => {
    expect(() => withRelativeCursor('abc')).toThrow(/no trailing cursor position/);
  });

  it('refuses a frame whose cursor sits below its last row', () => {
    expect(() => withRelativeCursor('abc\x1b[5;1H')).toThrow(/below the frame's last row/);
  });
});

describe('widenRow branches the desktop vectors do not reach', () => {
  it('grows the erase and the forward of a band that ends in a right-hand border, and keeps the border last', () => {
    // A diff band erased and stepped over, then a scrollbar at the recorded edge: both halves of the
    // band take the extra cells, so the band still reaches the border at the new edge.
    const widened = fitWider('\x1b[48;5;22m+ a\x1b[4X\x1b[4C\x1b[0m┃', 14, 10);
    expect(widened).toBe('\x1b[48;5;22m+ a\x1b[8X\x1b[8C\x1b[0m┃');
    expect(widened.endsWith('┃')).toBe(true);
  });

  it('moves a right-aligned tail that is half the row, and leaves one that is wider than half', () => {
    // At 20 columns half is 10. The two rows are the same shape (a word, a 4-cell gap, a tail that ends
    // inside the two cells of padding) and differ only in the tail's width.
    expect(fitWider('abcd\x1b[4Cefghijklmn', 24, 20)).toBe('abcd\x1b[8Cefghijklmn');
    // 11 wide: past half, so it is text the CLI laid out itself and not a label it right-aligned.
    expect(fitWider('abc\x1b[4Cdefghijklmn', 24, 20)).toBe('abc\x1b[4Cdefghijklmn');
    // The tail is three cells, well inside the cap: moves.
    expect(fitWider('abcdefghijk\x1b[4Cxyz', 24, 20)).toBe('abcdefghijk\x1b[8Cxyz');
  });

  it('returns a row byte for byte when there are no extra columns to fill', () => {
    // A parameterless cursor-forward is the sequence a re-render would normalise to \x1b[1C, so
    // an early return is the only way this row comes back as it went in.
    const row = 'ab\x1b[C\x1b[6C┃';
    expect(widenRow(row, 0, 10)).toBe(row);
  });
});
