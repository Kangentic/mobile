import { Terminal } from '@xterm/headless';

import type { RecordedTerminalCapture } from '@/devsupport/recordedTerminal';

/** A headless terminal at the capture's own grid, which is the only grid its bytes replay correctly into. */
function createCaptureTerminal(capture: RecordedTerminalCapture): Terminal {
  return new Terminal({
    cols: capture.cols,
    rows: capture.rows,
    scrollback: 500,
    allowProposedApi: true,
  });
}

/**
 * xterm parses writes on a macrotask, so reading the buffer straight after
 * the last write() snapshots a STALE grid. A zero-length write's callback
 * fires only once every queued chunk ahead of it has been parsed, which is
 * exactly the barrier needed - and is why these helpers are async.
 */
function settle(terminal: Terminal): Promise<void> {
  return new Promise<void>((resolveFlush) => terminal.write('', resolveFlush));
}

/**
 * Replay a recorded capture through a headless xterm and read back the visible
 * grid as plain text, one string per row.
 *
 * Tests assert on THIS, never on the capture's bytes. A terminal fixture's
 * bytes and its screen are different things: escape sequences carry no width,
 * a line can be written and overwritten before anyone sees it, and words are
 * split by cursor moves rather than spaces. Measuring a line's length in the
 * source is how the previous fixture's column budget was checked, and it could
 * only ever work because that fixture was a plain array of strings.
 *
 * `translateToString(true)` returns cell TEXT with trailing blanks trimmed, so
 * no escape sequence can reach an assertion.
 */
export async function renderCaptureRows(
  capture: RecordedTerminalCapture,
  throughChunk?: number,
): Promise<string[]> {
  const terminal = createCaptureTerminal(capture);

  terminal.write(capture.seedFrame);
  const lastChunk = throughChunk ?? capture.chunks.length - 1;
  for (let index = 0; index <= lastChunk && index < capture.chunks.length; index += 1) {
    terminal.write(capture.chunks[index].data);
  }
  await settle(terminal);

  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  for (let lineIndex = buffer.baseY; lineIndex < buffer.baseY + capture.rows; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    rows.push(line ? line.translateToString(true) : '');
  }
  terminal.dispose();
  return rows;
}

/** One rendered cell: what it shows and what it paints behind it. */
export interface RenderedCell {
  /** The cell's text, with a never-written cell read as a space: both look blank. */
  readonly glyph: string;
  /** `default`, `palette:<n>` or `rgb:<hex>`. Two cells look alike only if this matches. */
  readonly background: string;
}

/**
 * The settled grid cell by cell, glyph AND background, for assertions that
 * text alone cannot make: a diff line's colour band is a run of blank cells
 * whose only content is the background, so it is invisible to
 * `translateToString`.
 */
export async function renderCaptureCells(capture: RecordedTerminalCapture): Promise<RenderedCell[][]> {
  const terminal = createCaptureTerminal(capture);

  terminal.write(capture.seedFrame);
  for (const chunk of capture.chunks) terminal.write(chunk.data);
  await settle(terminal);

  const buffer = terminal.buffer.active;
  const scratchCell = buffer.getNullCell();
  const rows: RenderedCell[][] = [];
  for (let lineIndex = buffer.baseY; lineIndex < buffer.baseY + capture.rows; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    const cells: RenderedCell[] = [];
    for (let column = 0; column < capture.cols; column += 1) {
      const cell = line?.getCell(column, scratchCell);
      if (!cell) {
        cells.push({ glyph: ' ', background: 'default' });
        continue;
      }
      let background = 'default';
      if (cell.isBgRGB()) background = `rgb:${cell.getBgColor().toString(16).padStart(6, '0')}`;
      else if (cell.isBgPalette()) background = `palette:${cell.getBgColor()}`;
      cells.push({ glyph: cell.getChars() === '' ? ' ' : cell.getChars(), background });
    }
    rows.push(cells);
  }
  terminal.dispose();
  return rows;
}

/**
 * Every distinct row the capture puts on screen at any point during the replay.
 *
 * For a STREAMING capture the final frame is not the whole session: a
 * permission dialog covers the tool results above it, so asserting only on the
 * end state misses most of the chrome a viewer sees scroll past. The committed
 * capture is currently a single settled frame, which makes this the deduped
 * rows of that frame - equivalent, not redundant, and it keeps the assertions
 * that use it correct if a re-record streams again.
 */
export async function renderCaptureAllRows(capture: RecordedTerminalCapture): Promise<string[]> {
  const terminal = createCaptureTerminal(capture);
  const seen = new Set<string>();

  const collectVisibleRows = async (): Promise<void> => {
    await settle(terminal);
    const buffer = terminal.buffer.active;
    for (let lineIndex = buffer.baseY; lineIndex < buffer.baseY + capture.rows; lineIndex += 1) {
      const line = buffer.getLine(lineIndex);
      const text = line ? line.translateToString(true) : '';
      if (text.trim().length > 0) seen.add(text);
    }
  };

  terminal.write(capture.seedFrame);
  await collectVisibleRows();
  for (const chunk of capture.chunks) {
    terminal.write(chunk.data);
    await collectVisibleRows();
  }

  terminal.dispose();
  return [...seen];
}
