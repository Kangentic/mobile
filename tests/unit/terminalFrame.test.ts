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
});
