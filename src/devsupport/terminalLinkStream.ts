/**
 * A PROBE-ONLY terminal stream that keeps https links on screen while it
 * streams at the pipeline's full rate (task #147).
 *
 * WHY IT EXISTS. scripts/xterm-page/links.js rescans the whole screen for
 * links on every xterm render, with no cache. Its first release-build A/B
 * (docs/architecture.md, "What the scan costs") had no link on screen, and no
 * mock terminal could put one there while streaming: the codex and gemini
 * TUIs repaint every 2 s, and the Claude replay is recorded bytes, finite, and
 * never edited. This is the stream that A/B lacked.
 *
 * FULL RATE. TerminalPane batches terminal chunks every 32 ms
 * (CHUNK_BATCH_INTERVAL_MS), so the page sees at most one write, and so one
 * render and scan, per batch. A tick every 16 ms is faster than the batch, so
 * every batch carries a write: the most this pipeline draws. Read from the
 * source, that is about 31 a second; measured on the release build
 * (docs/architecture.md), the page's `renders` count read about 20, because
 * the batch's timer period runs long.
 *
 * TWO SCENARIOS, because they cost the page different things:
 *  - still: the links never move and only the bottom rows repaint. Every
 *    render rescans, but the underline overlay's signature does not change,
 *    so no DOM is written.
 *  - scroll: lines stream in at the bottom, about one in four carrying a link,
 *    so every link moves on every write. Every render rescans AND rebuilds the
 *    overlay.
 * Both carry every shape the finder joins: a link on a hard row, a URL longer
 * than the row (a soft wrap, isWrapped), a URL a TUI wrapped onto an indented
 * row itself (linkContinuesOnNextRow, the expensive path), and rows padded to
 * the full width and joined by autowrap, the TUI shape that can make a whole
 * screen read as one logical line.
 *
 * AUTHORED probe load, labelled as such on its own first row: not an agent's
 * output, and nothing a store capture or a fixture test reads. The mock
 * desktop plays it only on its `/link-stream` command, which it honours only
 * in a build compiled with the retention probe (src/connection/mockDesktop.ts).
 */

export type TerminalLinkStreamMode = 'still' | 'scroll';

/** What a `/link-stream` command asks for: a scenario, or the stream stopped. */
export type TerminalLinkStreamCommand = TerminalLinkStreamMode | 'off';

export interface TerminalLinkStreamGrid {
  readonly cols: number;
  readonly rows: number;
}

/** One tick every 16 ms: faster than the host's 32 ms batch, so the page is written every window. */
export const TERMINAL_LINK_STREAM_TICK_MS = 16;

const ESCAPE = '\u001b';
const CLEAR_SCREEN = `${ESCAPE}[H${ESCAPE}[2J`;
const ERASE_LINE_TAIL = `${ESCAPE}[K`;
const SPINNER_GLYPHS = ['|', '/', '-', '\\'];
/** How far short of the row's edge the TUI-wrapped URL breaks, as a TUI's own wrap does. */
const TUI_WRAP_GAP_CELLS = 3;
/** The indent on the row a TUI carries a wrapped URL onto. */
const TUI_WRAP_INDENT = '    ';
/** How many link rows the still screen's padded block holds. */
const PADDED_BLOCK_LINKS = 4;
/** Rows between two links in the padded block. */
const PADDED_BLOCK_SPACING = 5;

const PULL_REQUEST_URL = 'https://github.com/Kangentic/kangentic-mobile/pull/146';
const CHECK_RUN_URL = 'https://github.com/Kangentic/kangentic-mobile/actions/runs/19284750123/job/55012345678';
const SOFT_WRAP_URL_BASE = 'https://github.com/Kangentic/kangentic-mobile/compare/main...link-stream-probe?expand=1';
const TUI_WRAP_URL_BASE = 'https://kangentic.com/review/terminal-links/streaming-probe';

/**
 * Compared as literals, never looked up as object keys: a key lookup would
 * also find inherited members, so `/link-stream constructor` would parse as
 * a command.
 */
const LINK_STREAM_COMMANDS: readonly TerminalLinkStreamCommand[] = ['still', 'scroll', 'off'];

function isLinkStreamCommand(word: string): word is TerminalLinkStreamCommand {
  return LINK_STREAM_COMMANDS.some((command) => command === word);
}

/** `/link-stream still`, `/link-stream scroll` or `/link-stream off`, or null for any other message. */
export function parseLinkStreamCommand(text: string): TerminalLinkStreamCommand | null {
  const match = /^\/link-stream\s+(\S+)$/.exec(text.trim());
  if (match === null) return null;
  const word = match[1];
  return isLinkStreamCommand(word) ? word : null;
}

/** A URL grown, one path segment at a time, to at least `minimumLength` characters. */
function urlOfAtLeast(base: string, minimumLength: number): string {
  const queryIndex = base.indexOf('?');
  const path = queryIndex === -1 ? base : base.slice(0, queryIndex);
  const query = queryIndex === -1 ? '' : base.slice(queryIndex);
  let grown = path;
  let segment = 1;
  while (grown.length + query.length < minimumLength) {
    grown += `/segment-${segment}`;
    segment += 1;
  }
  return grown + query;
}

/** Longer than a row, so the terminal itself wraps it onto the next (isWrapped). */
function softWrapUrl(grid: TerminalLinkStreamGrid): string {
  return urlOfAtLeast(SOFT_WRAP_URL_BASE, grid.cols + 40);
}

function paddedBlockUrl(index: number): string {
  return `https://github.com/Kangentic/kangentic-mobile/issues/${140 + index}`;
}

/** Exactly one row wide: cut to the grid, then padded with spaces to its edge. */
function padToRow(text: string, grid: TerminalLinkStreamGrid): string {
  return text.slice(0, grid.cols).padEnd(grid.cols, ' ');
}

const TUI_WRAP_LABEL = '  Design review: ';
const TUI_WRAP_TOKEN_ALPHABET = 'a1b2c3d4e5f6g7h8i9j0';

/**
 * A URL a TUI wrapped itself over three rows, none of them isWrapped. Each
 * row stops TUI_WRAP_GAP_CELLS short of the edge, and the next carries on at
 * a small indent. The first row ends in the URL's path, which holds its
 * separators. The middle row is ALL query string with no separator, so the
 * finder accepts it only by asking whether the row above wrapped into it:
 * the recursive branch of linkContinuesOnNextRow, its most expensive path.
 * The rows come without the line breaks between them, which the caller places.
 */
function tuiWrappedLink(grid: TerminalLinkStreamGrid): { url: string; rows: readonly [string, string, string] } {
  const headLength = Math.max(grid.cols - TUI_WRAP_GAP_CELLS - TUI_WRAP_LABEL.length, 'https://x/'.length);
  const middleLength = Math.max(grid.cols - TUI_WRAP_GAP_CELLS - TUI_WRAP_INDENT.length, 1);
  const head = urlOfAtLeast(TUI_WRAP_URL_BASE, headLength).slice(0, headLength);
  let query = '?signature=';
  while (query.length < middleLength + 40) query += TUI_WRAP_TOKEN_ALPHABET;
  return {
    url: head + query,
    rows: [
      TUI_WRAP_LABEL + head,
      TUI_WRAP_INDENT + query.slice(0, middleLength),
      TUI_WRAP_INDENT + query.slice(middleLength),
    ],
  };
}

function cursorTo(row: number): string {
  return `${ESCAPE}[${row};1H`;
}

/**
 * Every link the still screen shows, in screen order: what the finder must
 * read whole from it, wrapped forms included.
 */
export function linkStreamStillUrls(grid: TerminalLinkStreamGrid): readonly string[] {
  const urls = [PULL_REQUEST_URL, CHECK_RUN_URL, softWrapUrl(grid), tuiWrappedLink(grid).url];
  for (let index = 0; index < PADDED_BLOCK_LINKS; index += 1) urls.push(paddedBlockUrl(index));
  return urls;
}

/** The still screen: eight links in every wrapped shape, above a live region the ticks repaint. */
function stillSeed(grid: TerminalLinkStreamGrid): string {
  const tuiWrapped = tuiWrappedLink(grid).rows;
  const paddedRows: string[] = [];
  const paddedRowCount = PADDED_BLOCK_LINKS * PADDED_BLOCK_SPACING;
  for (let index = 0; index < paddedRowCount; index += 1) {
    const linkIndex = index / PADDED_BLOCK_SPACING;
    paddedRows.push(
      padToRow(
        Number.isInteger(linkIndex)
          ? `  Filed as ${paddedBlockUrl(linkIndex)}`
          : `  Notes row ${index + 1}, padded to the full width the way a TUI pads every row.`,
        grid,
      ),
    );
  }
  return (
    CLEAR_SCREEN +
    cursorTo(1) +
    'Link stream probe (still): eight links stay put while the rows below repaint every tick.' +
    cursorTo(3) +
    `  Opened the pull request: ${PULL_REQUEST_URL}` +
    cursorTo(4) +
    `  Checks: ${CHECK_RUN_URL}` +
    // Written in one go from column 1: the terminal wraps it onto row 7.
    cursorTo(6) +
    `  Compare: ${softWrapUrl(grid)}` +
    cursorTo(9) +
    tuiWrapped[0] +
    cursorTo(10) +
    tuiWrapped[1] +
    cursorTo(11) +
    tuiWrapped[2] +
    // One continuous write: each full row wraps into the next, so the whole
    // block is one logical line of autowrapped rows.
    cursorTo(13) +
    paddedRows.join('') +
    stillLiveRegion(grid, 0)
  );
}

/** The bottom three rows, the only thing a still tick changes: a spinner, a streaming line, a status bar. */
function stillLiveRegion(grid: TerminalLinkStreamGrid, tick: number): string {
  const spinner = SPINNER_GLYPHS[tick % SPINNER_GLYPHS.length];
  const streamingText = 'Streaming a reply token by token while the links above hold still. ';
  const shown = streamingText.repeat(3).slice(0, (tick % (streamingText.length * 2)) + 1);
  return (
    cursorTo(grid.rows - 2) +
    `${spinner} Working (tick ${tick})`.slice(0, grid.cols) +
    ERASE_LINE_TAIL +
    cursorTo(grid.rows - 1) +
    shown.slice(0, grid.cols) +
    ERASE_LINE_TAIL +
    cursorTo(grid.rows) +
    `link stream probe, still, tick ${tick}`.slice(0, grid.cols) +
    ERASE_LINE_TAIL
  );
}

/**
 * Entry `index` of the scroll stream, with no line break at either end. One
 * in four carries a link, cycling through the four shapes; the rest are log
 * lines that hold none.
 */
function scrollEntry(index: number, grid: TerminalLinkStreamGrid): string {
  const cyclePosition = index % 16;
  switch (cyclePosition) {
    case 0:
      return `  Opened the pull request: ${PULL_REQUEST_URL}`;
    case 4:
      return `  Compare: ${softWrapUrl(grid)}`;
    case 8:
      return tuiWrappedLink(grid).rows.join('\r\n');
    case 12:
      // A full row, then the text that wraps onto the next one.
      return padToRow(`  Checks: ${CHECK_RUN_URL}`, grid) + '  (padded to the full width and joined by autowrap)';
    default:
      return `  [${(index * 0.016).toFixed(3)}s] PASS tests/unit/case-${index % 97}.test.ts (${(index % 23) + 1} tests)`;
  }
}

/**
 * The screen a subscriber is handed: everything the stream has to draw at
 * once. For scroll, the first `rows` entries, so links fill the screen from
 * the first frame.
 */
export function linkStreamSeedFrame(mode: TerminalLinkStreamMode, grid: TerminalLinkStreamGrid): string {
  if (mode === 'still') return stillSeed(grid);
  const entries: string[] = [];
  for (let index = 0; index < grid.rows; index += 1) entries.push(scrollEntry(index, grid));
  return CLEAR_SCREEN + entries.join('\r\n');
}

/** The bytes tick `tick` (1 onward) writes on top of the seed and every tick before it. */
export function linkStreamTickFrame(mode: TerminalLinkStreamMode, tick: number, grid: TerminalLinkStreamGrid): string {
  if (mode === 'still') return stillLiveRegion(grid, tick);
  return '\r\n' + scrollEntry(grid.rows - 1 + tick, grid);
}
