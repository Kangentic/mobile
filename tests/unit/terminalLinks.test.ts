import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { decodeTerminalMessage } from '@/terminal/terminalBridge';
import { httpsUrlOrNull } from '@/lib/httpsUrl';
import { linkStreamSeedFrame, linkStreamStillUrls, linkStreamTickFrame } from '@/devsupport/terminalLinkStream';

/**
 * Tappable links in the terminal mirror (task #144), run from the page
 * fragment itself, scripts/xterm-page/links.js, the way xtermPageScripts.test.ts
 * runs the other fragments: its source inside a Function with the page globals
 * it reads injected. The cases under "parseHttpsUrls" and "readLinkLogicalLine"
 * are ported from the desktop's tests/unit/terminal-link-parse.test.ts (kangentic
 * 44ea91522), narrowed to https, and run against @xterm/headless at the page's
 * own widths: the page loads no unicode11 addon, so these are xterm's default
 * Unicode 6 widths, where the desktop's run at Unicode 11.
 */

const linksSource = readFileSync(join(__dirname, '..', '..', 'scripts', 'xterm-page', 'links.js'), 'utf8');

interface LinkSegment {
  row: number;
  bufferRow: number;
  startColumn: number;
  endColumn: number;
}

interface FoundLink {
  url: string;
  key: string;
  segments: LinkSegment[];
}

interface LogicalLine {
  text: string;
  firstRow: number;
  lastRow: number;
}

interface BufferSegment {
  bufferRow: number;
  startColumn: number;
  endColumn: number;
}

interface FakeCell {
  isFgDefault: () => boolean;
  isFgRGB: () => boolean;
  isFgPalette: () => boolean;
  getFgColor: () => number;
}

/** What the page reads off a terminal: its grid, its active buffer and its theme. */
interface PageTerminal {
  cols: number;
  rows: number;
  buffer: Terminal['buffer'];
  options: { theme: Record<string, string> };
}

/** Just enough DOM for the overlay and the hit test: a box, children, a textContent reset. */
class FakeElement {
  style = { cssText: '' };
  children: FakeElement[] = [];
  attributes: Record<string, string> = {};
  isConnected = true;
  rect = { left: 0, top: 0, width: 0, height: 0 };

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  appendChild(child: FakeElement): FakeElement {
    this.children.push(child);
    return child;
  }

  get firstChild(): FakeElement | null {
    return this.children[0] ?? null;
  }

  get textContent(): string {
    return '';
  }

  set textContent(value: string) {
    if (value === '') this.children = [];
  }

  getBoundingClientRect(): { left: number; top: number; width: number; height: number } {
    return this.rect;
  }
}

interface LinksPage {
  setTerminal: (terminal: PageTerminal | null) => void;
  setEnabled: (enabled: boolean) => void;
  parseHttpsUrls: (text: string) => { url: string; start: number; end: number }[];
  readLinkLogicalLine: (buffer: Terminal['buffer']['active'], row: number, columns: number) => LogicalLine;
  linkSegmentsOf: (line: LogicalLine, start: number, end: number) => BufferSegment[];
  findLinksInRows: (buffer: Terminal['buffer']['active'], firstVisibleRow: number, rowCount: number, columns: number) => FoundLink[];
  linkAtPoint: (links: FoundLink[], pointX: number, pointY: number, cellWidthPx: number, cellHeightPx: number) => FoundLink | null;
  linkCellColor: (cell: FakeCell | null) => string;
  pressLinkAt: (clientX: number, clientY: number) => void;
  releaseLinkPress: () => void;
  postCleanTap: (touchEvent: { preventDefault: () => void } | null) => void;
  refreshTerminalLinks: () => void;
  clearTerminalLinks: () => void;
  setScreenPresent: (present: boolean) => void;
  pressedLink: () => FoundLink | null;
  linkStats: () => { scans: number; visible: number; opened: number };
  armLinkStatsWindow: (windowMs: unknown) => void;
  reportLinkWindowStats: () => void;
  linkStatsWindowArmed: () => boolean;
  setOverlayRebuild: (rebuild: boolean) => void;
  reachPx: number;
}

function buildLinksPage(): {
  page: LinksPage;
  screen: FakeElement;
  posted: unknown[];
  createdElements: () => number;
} {
  const posted: unknown[] = [];
  const screen = new FakeElement();
  let createdElements = 0;
  let screenPresent = true;
  const fakeDocument = {
    querySelector: (selector: string) => (selector === '.xterm-screen' && screenPresent ? screen : null),
    createElement: () => {
      createdElements += 1;
      return new FakeElement();
    },
  };
  const build = new Function(
    'document',
    'postToHost',
    'performance',
    `var terminal = null;
     ${linksSource}
     return {
       setTerminal: function (next) { terminal = next; },
       setEnabled: function (enabled) { terminalLinksEnabled = enabled; },
       parseHttpsUrls: parseHttpsUrls,
       readLinkLogicalLine: readLinkLogicalLine,
       linkSegmentsOf: linkSegmentsOf,
       findLinksInRows: findLinksInRows,
       linkAtPoint: linkAtPoint,
       linkCellColor: linkCellColor,
       pressLinkAt: pressLinkAt,
       releaseLinkPress: releaseLinkPress,
       postCleanTap: postCleanTap,
       refreshTerminalLinks: refreshTerminalLinks,
       clearTerminalLinks: clearTerminalLinks,
       pressedLink: function () { return pressedLink; },
       linkStats: function () { return linkStats; },
       armLinkStatsWindow: armLinkStatsWindow,
       reportLinkWindowStats: reportLinkWindowStats,
       linkStatsWindowArmed: function () { return linkStatsWindowTimer !== null; },
       setOverlayRebuild: function (rebuild) { linkOverlayRebuild = rebuild; },
       reachPx: LINK_TAP_REACH_PX,
     };`,
  ) as (...dependencies: unknown[]) => LinksPage;
  const page = build(
    fakeDocument,
    (message: unknown) => {
      posted.push(message);
    },
    globalThis.performance,
  );
  page.setScreenPresent = (present: boolean) => {
    screenPresent = present;
  };
  return { page, screen, posted, createdElements: () => createdElements };
}

async function terminalWith(text: string, cols = 40, rows = 6): Promise<Terminal> {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true });
  await new Promise<void>((resolve) => terminal.write(text, resolve));
  return terminal;
}

/** Rows that are not `isWrapped`, as every agent's own renderer draws them. */
function hardRows(rows: readonly string[]): string {
  return rows.map((row, index) => `\x1b[${index + 1};1H${row}`).join('');
}

/** The text a link's cells hold, read back through the terminal rather than the string. */
function textInSegments(terminal: Terminal, segments: readonly BufferSegment[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    const line = terminal.buffer.active.getLine(segment.bufferRow);
    for (let column = segment.startColumn; column < segment.endColumn; column += 1) {
      parts.push(line?.getCell(column)?.getChars() ?? '');
    }
  }
  return parts.join('');
}

const { page } = buildLinksPage();

function firstUrl(terminal: Terminal, row = 0): string | undefined {
  return page.parseHttpsUrls(page.readLinkLogicalLine(terminal.buffer.active, row, terminal.cols).text)[0]?.url;
}

describe('parseHttpsUrls', () => {
  it.each([
    ['a sentence end', 'see https://example.com/docs.', 'https://example.com/docs'],
    ['a comma', 'https://example.com/a, then more', 'https://example.com/a'],
    ['prose parens', '(see https://example.com/a)', 'https://example.com/a'],
    ['a balanced paren in the URL', 'https://example.com/wiki/Foo_(bar) ok', 'https://example.com/wiki/Foo_(bar)'],
    ['a TUI border', 'https://example.com/a│', 'https://example.com/a'],
    ['a query string', 'https://example.com/x?a=1&b=2', 'https://example.com/x?a=1&b=2'],
    ['a quote', 'open "https://example.com/a" now', 'https://example.com/a'],
  ])('stops at %s', (_label, text, expected) => {
    expect(page.parseHttpsUrls(text).map((parsed) => parsed.url)).toEqual([expected]);
  });

  /**
   * Agent output is untrusted text, so only https is a link (decision B1 on
   * the design review): http is out too, since a dev server's http link on
   * the desktop names the phone's own localhost here.
   *
   * Mutation that reddens this: widen both the pattern and the scheme check
   * after it to `https?://` (either one alone still refuses http).
   */
  it('skips every other scheme, plain http and a bare scheme', () => {
    expect(
      page.parseHttpsUrls(
        'ftp://example.com javascript:alert(1) https:// mailto:a@example.com http://localhost:5173/ ' +
          'file:///etc/hosts intent://scan#Intent;end kangentic-pair://demo data:text/html,x',
      ),
    ).toEqual([]);
  });

  /**
   * The page and the host must agree, or the page would underline a link a
   * tap then refuses. Every URL the parser finds passes the host's check,
   * including one in capitals (the scheme is case-insensitive on both sides).
   */
  it('finds only URLs the host would open', () => {
    const text = 'a https://example.com/a and HTTPS://EXAMPLE.COM/B and https://github.com/x/y/pull/1.';
    const urls = page.parseHttpsUrls(text).map((parsed) => parsed.url);
    expect(urls).toEqual(['https://example.com/a', 'HTTPS://EXAMPLE.COM/B', 'https://github.com/x/y/pull/1']);
    for (const url of urls) expect(httpsUrlOrNull(url)).toBe(url);
  });

  it('finds every link on one line, with string ranges that slice back to the URL', () => {
    const text = 'PR https://example.com/pull/1 and run https://example.com/runs/2';
    const parsed = page.parseHttpsUrls(text);
    expect(parsed.map((entry) => text.slice(entry.start, entry.end))).toEqual([
      'https://example.com/pull/1',
      'https://example.com/runs/2',
    ]);
  });
});

describe('readLinkLogicalLine at the page widths', () => {
  it.each([
    ['an emoji', '✅ https://example.com/a'],
    ['a wide CJK run', '日本語 https://example.com/a'],
    ['an astral emoji', '\u{1f680}\u{1f680} https://example.com/a'],
    ['a combining mark', 'éé https://example.com/a'],
  ])('keeps the link on its cells after %s', async (_label, text) => {
    const terminal = await terminalWith(text);
    const line = page.readLinkLogicalLine(terminal.buffer.active, 0, terminal.cols);
    const [parsed] = page.parseHttpsUrls(line.text);
    expect(textInSegments(terminal, page.linkSegmentsOf(line, parsed.start, parsed.end))).toBe('https://example.com/a');
  });

  it('ends a segment past the second cell of a wide last glyph', async () => {
    const terminal = await terminalWith('https://example.com/日');
    const line = page.readLinkLogicalLine(terminal.buffer.active, 0, terminal.cols);
    const lastGlyph = line.text.lastIndexOf('日');
    const [segment] = page.linkSegmentsOf(line, lastGlyph, lastGlyph + 1);
    expect(segment.endColumn - segment.startColumn).toBe(2);
  });

  it('joins a soft wrap, and the link covers both rows', async () => {
    const url = `https://example.com/${'a'.repeat(50)}`;
    const terminal = await terminalWith(`✅ ${url}`);
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);
    for (const readFromRow of [0, 1]) {
      const line = page.readLinkLogicalLine(terminal.buffer.active, readFromRow, terminal.cols);
      const [parsed] = page.parseHttpsUrls(line.text);
      expect(parsed.url).toBe(url);
      expect(page.linkSegmentsOf(line, parsed.start, parsed.end).map((segment) => segment.bufferRow)).toEqual([0, 1]);
    }
  });

  it('stops at a run of wrapped rows rather than reading a whole padded screen', async () => {
    const terminal = await terminalWith('x'.repeat(40 * 5));
    expect(page.readLinkLogicalLine(terminal.buffer.active, 0, terminal.cols).text.length).toBe(40 * 5);
    const tall = await terminalWith('y'.repeat(10 * 20), 10, 30);
    expect(page.readLinkLogicalLine(tall.buffer.active, 10, tall.cols).text.length).toBeLessThanOrEqual(10 * 9);
  });
});

describe('readLinkLogicalLine across a wrap a TUI drew itself', () => {
  it('joins an indented continuation, from either row, without its indent', async () => {
    const head = `https://example.com/${'b'.repeat(20)}`;
    const terminal = await terminalWith(hardRows([head, '  rest-of-it and then prose']));
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(false);
    expect(firstUrl(terminal, 0)).toBe(`${head}rest-of-it`);
    expect(firstUrl(terminal, 1)).toBe(`${head}rest-of-it`);
  });

  it('follows a URL across three rows', async () => {
    const head = `https://example.com/${'c'.repeat(20)}`;
    const middle = `  ${'d'.repeat(38)}`;
    const terminal = await terminalWith(hardRows([head, middle, '  end']));
    expect(firstUrl(terminal, 2)).toBe(`${head}${'d'.repeat(38)}end`);
  });

  it('joins a row that stops one cell short, as Claude Code wraps its prompt echo', async () => {
    const head = `https://example.com/${'e'.repeat(19)}`;
    const terminal = await terminalWith(hardRows([head, '-continued']));
    expect(firstUrl(terminal)).toBe(`${head}-continued`);
  });

  describe('Copilot CLI 1.0.105, rows captured from a real session at 120 columns', () => {
    const FULL_URL =
      'https://code.claude.com/docs/en/fullscreen?kangentic-link-check=this-url-is-deliberately-long-so-it-runs-past-the-right-edge-of-the-terminal-and-breaks-across-rows-then-keeps-going-until-it-has-wrapped-at-least-one-full-terminal-row-on-any-reasonable-window-width-0123456789-abcdefghij';

    it('reads the prompt echo, which wraps seven cells short of its panel border', async () => {
      const terminal = await terminalWith(
        hardRows([
          '   https://code.claude.com/docs/en/fullscreen?kangentic-link-check=this-url-is-deliberately-long-so-it-runs-past       ┃',
          '   -the-right-edge-of-the-terminal-and-breaks-across-rows-then-keeps-going-until-it-has-wrapped-at-least-one-ful       ┃',
          '   l-terminal-row-on-any-reasonable-window-width-0123456789-abcdefghij                                                 ┃',
          '   src/app.ts:12                                                                                                       ┃',
        ]),
        120,
      );
      for (const row of [0, 1, 2]) expect(firstUrl(terminal, row)).toBe(FULL_URL);
    });

    it('reads a response row that runs to the border', async () => {
      const terminal = await terminalWith(
        hardRows([
          ' ● https://code.claude.com/docs/en/fullscreen?kangentic-link-check=this-url-is-deliberately-long-so-it-runs-past-the-r ┃',
          '   ight-edge-of-the-terminal-and-breaks-across-rows-then-keeps-going-until-it-has-wrapped-at-least-one-full-terminal-r ┃',
          '   ow-on-any-reasonable-window-width-0123456789-abcdefghij                                                             ┃',
        ]),
        120,
      );
      expect(firstUrl(terminal, 1)).toBe(FULL_URL);
    });
  });

  it('leaves a line that ends in a URL alone when the next word would have fit beside it', async () => {
    const head = `see https://example.com/${'i'.repeat(8)}`;
    const terminal = await terminalWith(hardRows([head, 'Then run it']));
    expect(firstUrl(terminal)).toBe(`https://example.com/${'i'.repeat(8)}`);
  });

  it('keeps the cells right, so the link ends on the continuation', async () => {
    const head = `https://example.com/${'f'.repeat(20)}`;
    const terminal = await terminalWith(hardRows([head, '  tail']));
    const line = page.readLinkLogicalLine(terminal.buffer.active, 0, terminal.cols);
    const [parsed] = page.parseHttpsUrls(line.text);
    expect(page.linkSegmentsOf(line, parsed.start, parsed.end)).toEqual([
      { bufferRow: 0, startColumn: 0, endColumn: 40 },
      { bufferRow: 1, startColumn: 2, endColumn: 6 },
    ]);
  });

  /**
   * The margin is 12 cells: a row stopping 12 short of the edge can still be a
   * TUI wrap, 13 short cannot, even when the next word is far longer than the
   * gap (so the word-length test alone does not decide it).
   *
   * Mutation that reddens the 13 case: raise the cut to `gap > 999`.
   * Mutation that reddens the 12 case: lower it to `gap > 11`.
   */
  it.each([
    ['12 cells short joins', 28, true],
    ['13 cells short does not', 27, false],
  ])('cuts the wrap at the margin: a row %s', async (_label, headLength, joins) => {
    const head = `https://example.com/${'m'.repeat(headLength - 20)}`;
    const terminal = await terminalWith(hardRows([head, `  ${'n'.repeat(20)}`]));
    const expected = joins ? `${head}${'n'.repeat(20)}` : head;
    expect(firstUrl(terminal)).toBe(expected);
  });

  /**
   * A TUI-wrapped URL longer than the reach: separators on every row, so only
   * the reach of 4 rows each way stops the read.
   *
   * Mutation that reddens this: replace the two
   * `... - row < LINK_MAX_WRAPPED_ROWS_EACH_WAY` reach tests with 999.
   */
  it('reads four rows each way from the row it starts on, and no further', async () => {
    const middleRow = `${'d'.repeat(19)}/${'d'.repeat(20)}`;
    const terminal = await terminalWith(
      hardRows([`https://example.com/${'a'.repeat(20)}`, ...Array.from({ length: 11 }, () => middleRow)]),
      40,
      12,
    );
    const line = page.readLinkLogicalLine(terminal.buffer.active, 5, terminal.cols);
    expect(line.firstRow).toBe(1);
    expect(line.lastRow).toBe(9);
  });

  /**
   * A middle row with no separator counts only while a row that has one is
   * within 4 rows back. Reading from row 5, row 5 would need the separator at
   * row 0, five back, so the chain stops there.
   *
   * Mutation that reddens this: drop `depth < LINK_MAX_WRAPPED_ROWS_EACH_WAY &&`
   * from isWholeRowOfALink (the read then runs on to row 9).
   */
  it('stops following separator-free rows more than four rows from their separator', async () => {
    const terminal = await terminalWith(
      hardRows([`https://example.com/${'a'.repeat(20)}`, ...Array.from({ length: 11 }, () => 'd'.repeat(40))]),
      40,
      12,
    );
    const line = page.readLinkLogicalLine(terminal.buffer.active, 5, terminal.cols);
    expect(line.firstRow).toBe(1);
    expect(line.lastRow).toBe(5);
  });

  it('leaves a link short of the edge alone', async () => {
    const terminal = await terminalWith(hardRows(['https://example.com/a', 'next']));
    expect(firstUrl(terminal)).toBe('https://example.com/a');
  });

  it('does not run two wrapped words of prose together', async () => {
    const terminal = await terminalWith(hardRows(['x'.repeat(40), 'yyy']));
    expect(page.readLinkLogicalLine(terminal.buffer.active, 0, terminal.cols).text).not.toContain('yyy');
  });

  it('stops at a bullet or a border, which cannot be part of a link', async () => {
    const head = `https://example.com/${'g'.repeat(20)}`;
    const terminal = await terminalWith(hardRows([head, '  ● next item']));
    expect(firstUrl(terminal)).toBe(head);
  });

  it('stops at text indented like a different block', async () => {
    const head = `https://example.com/${'h'.repeat(20)}`;
    const terminal = await terminalWith(hardRows([head, `${' '.repeat(12)}aside`]));
    expect(firstUrl(terminal)).toBe(head);
  });
});

describe('findLinksInRows', () => {
  /**
   * The design review's case 2: a 61-column grid where the TUI broke a CI
   * run's URL after `runs/`. One link, both rows, in viewport rows.
   */
  it('finds a wrapped link once, with a segment on each of its rows', async () => {
    const terminal = await terminalWith(
      hardRows([
        '● Opened the pull request. CI is running:',
        '  https://github.com/kangentic/kangentic-mobile/actions/runs/',
        '  19283746501',
        '',
        '  I will report back when the checks finish.',
      ]),
      61,
    );

    const links = page.findLinksInRows(terminal.buffer.active, 0, 6, 61);

    expect(links.map((link) => link.url)).toEqual(['https://github.com/kangentic/kangentic-mobile/actions/runs/19283746501']);
    expect(links[0].segments).toEqual([
      { row: 1, bufferRow: 1, startColumn: 2, endColumn: 61 },
      { row: 2, bufferRow: 2, startColumn: 2, endColumn: 13 },
    ]);
  });

  it('leaves an http link plain beside an https one', async () => {
    const terminal = await terminalWith(
      hardRows(['  Local:   http://localhost:5173/', '', '  PR: https://github.com/kangentic/kangentic-mobile/pull/146']),
      80,
    );

    expect(page.findLinksInRows(terminal.buffer.active, 0, 6, 80).map((link) => link.url)).toEqual([
      'https://github.com/kangentic/kangentic-mobile/pull/146',
    ]);
  });

  /**
   * A link that starts in the rows just above the screen and wraps onto it is
   * still a link: its visible tail is underlined and tappable, and the row
   * numbers are the SCREEN's, not the buffer's.
   */
  it('finds a link that starts above the screen, with only its visible segments', async () => {
    const terminal = await terminalWith(hardRows([`https://example.com/${'k'.repeat(20)}`, '  tail', 'prose']));

    const links = page.findLinksInRows(terminal.buffer.active, 1, 2, 40);

    expect(links).toHaveLength(1);
    expect(links[0].url).toBe(`https://example.com/${'k'.repeat(20)}tail`);
    expect(links[0].segments).toEqual([{ row: 0, bufferRow: 1, startColumn: 2, endColumn: 6 }]);
  });

  /**
   * Mutation that reddens this: drop the next-row look-ahead in rowMayHoldLink
   * (`text += following...`), which leaves `htt` and `ps://` each without a scheme.
   */
  it('finds a link whose scheme a soft wrap split across two rows', async () => {
    const terminal = await terminalWith(`${'x'.repeat(37)}https://example.com/abc`);
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);

    const links = page.findLinksInRows(terminal.buffer.active, 0, 6, 40);

    expect(links.map((link) => link.url)).toEqual(['https://example.com/abc']);
    expect(links[0].segments.map((segment) => segment.row)).toEqual([0, 1]);
  });

  /**
   * Mutation that reddens this: drop `segment.bufferRow > lastVisibleRow`
   * from the visibility filter.
   */
  it('clips a link whose tail runs below the last visible row to its visible segments', async () => {
    const terminal = await terminalWith(`https://example.com/${'a'.repeat(50)}`);
    expect(terminal.buffer.active.getLine(1)?.isWrapped).toBe(true);

    const links = page.findLinksInRows(terminal.buffer.active, 0, 1, 40);

    expect(links).toHaveLength(1);
    expect(links[0].segments).toEqual([{ row: 0, bufferRow: 0, startColumn: 0, endColumn: 40 }]);
  });

  it('finds nothing on a screen with no https link', async () => {
    const terminal = await terminalWith(hardRows(['plain text', 'src/app.ts:12', 'http://localhost:3000']));
    expect(page.findLinksInRows(terminal.buffer.active, 0, 6, 40)).toEqual([]);
  });
});

/**
 * The link-scan probe's stream (src/devsupport/terminalLinkStream.ts, task
 * #147), written into a headless terminal at the mock's 210x48 grid and read
 * back through the page's real finder. The stream only measures what it
 * claims to if the finder actually walks every wrapped shape in it, so these
 * pin that it does, rather than trusting the generator's comments.
 */
describe('the link-scan probe stream, through the real finder', () => {
  const grid = { cols: 210, rows: 48 };

  async function write(terminal: Terminal, data: string): Promise<void> {
    await new Promise<void>((resolve) => terminal.write(data, resolve));
  }

  function visibleLinks(terminal: Terminal): FoundLink[] {
    const buffer = terminal.buffer.active;
    return page.findLinksInRows(buffer, buffer.viewportY, grid.rows, grid.cols);
  }

  it('still: finds every link whole, each wrapped shape included, and none moves as it ticks', async () => {
    const terminal = await terminalWith(linkStreamSeedFrame('still', grid), grid.cols, grid.rows);
    const expectedUrls = linkStreamStillUrls(grid);
    // The shapes the stream exists to carry: a URL longer than a row, and one
    // a TUI wrapped over three rows whose middle row holds no separator.
    expect(expectedUrls.some((url) => url.length > grid.cols)).toBe(true);
    expect(terminal.buffer.active.getLine(6)?.isWrapped).toBe(true);
    for (const row of [9, 10]) expect(terminal.buffer.active.getLine(row)?.isWrapped).toBe(false);
    // The padded block is one logical line of autowrapped rows.
    expect(terminal.buffer.active.getLine(13)?.isWrapped).toBe(true);

    const seedLinks = visibleLinks(terminal);
    expect(seedLinks.map((link) => link.url)).toEqual(expectedUrls);
    const tuiWrapped = seedLinks.find((link) => link.url === expectedUrls[3]);
    expect(tuiWrapped?.segments.map((segment) => segment.row)).toEqual([8, 9, 10]);

    for (let tick = 1; tick <= 5; tick += 1) await write(terminal, linkStreamTickFrame('still', tick, grid));
    expect(visibleLinks(terminal)).toEqual(seedLinks);
    // The ticks did write: the live region shows the last one.
    expect(terminal.buffer.active.getLine(grid.rows - 1)?.translateToString(true)).toContain('tick 5');
  });

  it('scroll: keeps links on screen in every shape, and every tick moves them', async () => {
    const terminal = await terminalWith(linkStreamSeedFrame('scroll', grid), grid.cols, grid.rows);
    let previousRows = visibleLinks(terminal).map((link) => link.segments[0].bufferRow - terminal.buffer.active.viewportY);
    const urlsSeen = new Set<string>();

    for (let tick = 1; tick <= 40; tick += 1) {
      await write(terminal, linkStreamTickFrame('scroll', tick, grid));
      const links = visibleLinks(terminal);
      expect(links.length).toBeGreaterThanOrEqual(8);
      for (const link of links) urlsSeen.add(link.url);
      const rows = links.map((link) => link.segments[0].bufferRow - terminal.buffer.active.viewportY);
      expect(rows).not.toEqual(previousRows);
      previousRows = rows;
    }
    // Every shape went past whole: the hard row, the padded pair, and both wraps.
    const stillUrls = linkStreamStillUrls(grid);
    for (const url of stillUrls.slice(0, 4)) expect(urlsSeen.has(url)).toBe(true);
  });
});

describe('linkAtPoint (the tap reach)', () => {
  // A 10 x 20 px cell; the link covers columns 5-14 of viewport row 3.
  const link: FoundLink = {
    url: 'https://example.com/a',
    key: 'a',
    segments: [{ row: 3, bufferRow: 3, startColumn: 5, endColumn: 15 }],
  };
  const rowTop = 3 * 20;
  const rowBottom = rowTop + 20;

  it('opens on the cells, and within the reach above and below them', () => {
    expect(page.linkAtPoint([link], 100, rowTop + 10, 10, 20)).toBe(link);
    expect(page.linkAtPoint([link], 100, rowTop - page.reachPx, 10, 20)).toBe(link);
    expect(page.linkAtPoint([link], 100, rowBottom + page.reachPx, 10, 20)).toBe(link);
  });

  it('reaches 12 px above and below, as the design review approved', () => {
    expect(page.reachPx).toBe(12);
  });

  it('does not open past the reach', () => {
    expect(page.linkAtPoint([link], 100, rowTop - page.reachPx - 1, 10, 20)).toBeNull();
    expect(page.linkAtPoint([link], 100, rowBottom + page.reachPx + 1, 10, 20)).toBeNull();
  });

  it('reaches one cell to either side and no further', () => {
    expect(page.linkAtPoint([link], 50 - 10, rowTop + 10, 10, 20)).toBe(link);
    expect(page.linkAtPoint([link], 150 + 10, rowTop + 10, 10, 20)).toBe(link);
    expect(page.linkAtPoint([link], 50 - 11, rowTop + 10, 10, 20)).toBeNull();
    expect(page.linkAtPoint([link], 150 + 11, rowTop + 10, 10, 20)).toBeNull();
  });

  /**
   * Two links on adjacent rows: the nearer wins, so the reach of one never
   * steals a tap squarely on the other.
   *
   * Mutation that reddens this: return the first link in reach instead of the nearest.
   */
  it('gives a tap between two links to the nearer one', () => {
    const below: FoundLink = {
      url: 'https://example.com/b',
      key: 'b',
      segments: [{ row: 4, bufferRow: 4, startColumn: 5, endColumn: 15 }],
    };
    expect(page.linkAtPoint([link, below], 100, rowBottom + 3, 10, 20)).toBe(below);
    expect(page.linkAtPoint([link, below], 100, rowBottom - 3, 10, 20)).toBe(link);
    expect(page.linkAtPoint([below, link], 100, rowBottom - 3, 10, 20)).toBe(link);
  });
});

describe('linkCellColor (the underline takes the link text colour)', () => {
  const theme = { foreground: '#f0e9dd', blue: '#5da9e0', brightRed: '#f08a8a' };
  const colorPage = buildLinksPage().page;
  colorPage.setTerminal({ cols: 1, rows: 1, buffer: {} as Terminal['buffer'], options: { theme } });

  function cell(kind: 'default' | 'palette' | 'rgb', color = 0): FakeCell {
    return {
      isFgDefault: () => kind === 'default',
      isFgPalette: () => kind === 'palette',
      isFgRGB: () => kind === 'rgb',
      getFgColor: () => color,
    };
  }

  it.each([
    ['the default foreground', cell('default'), '#f0e9dd'],
    ['an ANSI palette colour', cell('palette', 4), '#5da9e0'],
    ['a bright ANSI colour', cell('palette', 9), '#f08a8a'],
    ['a 256-colour cube entry', cell('palette', 196), 'rgb(255,0,0)'],
    ['a 256-colour grey', cell('palette', 244), 'rgb(128,128,128)'],
    ['a true colour', cell('rgb', 0x00ff7f), '#00ff7f'],
    ['no cell at all', null, '#f0e9dd'],
  ])('resolves %s', (_label, input, expected) => {
    expect(colorPage.linkCellColor(input)).toBe(expected);
  });
});

describe('a tap on the page', () => {
  const PR_URL = 'https://github.com/kangentic/kangentic-mobile/pull/146';

  /**
   * A page whose screen is a 60 x 6 grid of 10 x 20 px cells at the top-left
   * corner, holding the 54-character PR link on row 1, columns 2-55: x 20-560,
   * y 20-40.
   */
  async function pageWithLink(): Promise<ReturnType<typeof buildLinksPage> & { terminal: Terminal }> {
    const harness = buildLinksPage();
    const terminal = await terminalWith(hardRows(['  The branch is pushed:', `  ${PR_URL}`, '', '  Design: waiting on you']), 60);
    harness.page.setTerminal({ cols: 60, rows: 6, buffer: terminal.buffer, options: { theme: { foreground: '#f0e9dd', cursor: '#e8a33d' } } });
    harness.screen.rect = { left: 0, top: 0, width: 600, height: 120 };
    return { ...harness, terminal };
  }

  function touchEvent(): { preventDefault: () => void; prevented: () => boolean } {
    let prevented = false;
    return {
      preventDefault: () => {
        prevented = true;
      },
      prevented: () => prevented,
    };
  }

  /**
   * THE TAP. A clean tap that landed on a link opens it and is nothing else:
   * the page posts 'open-link' (which the host decodes to the URL) and NOT
   * 'tapped' (which would also toggle the keyboard), and it cancels the
   * touchend, so no compatibility mouse event follows it into xterm's mouse
   * reporting or the container's focus click.
   *
   * Mutation that reddens this: make postCleanTap post 'tapped' first and
   * return, or drop the preventDefault call.
   */
  it('opens the link a clean tap landed on, instead of toggling the keyboard', async () => {
    const harness = await pageWithLink();
    const event = touchEvent();

    harness.page.pressLinkAt(200, 30);
    harness.page.postCleanTap(event);

    expect(harness.posted).toEqual([{ type: 'open-link', url: PR_URL }]);
    expect(decodeTerminalMessage(JSON.stringify(harness.posted[0]))).toEqual({ type: 'open-link', url: PR_URL });
    expect(event.prevented()).toBe(true);
    expect(harness.page.linkStats().opened).toBe(1);
  });

  it('toggles the keyboard on a tap away from any link, as before', async () => {
    const harness = await pageWithLink();
    const event = touchEvent();

    harness.page.pressLinkAt(200, 100);
    harness.page.postCleanTap(event);

    expect(harness.posted).toEqual([{ type: 'tapped' }]);
    expect(event.prevented()).toBe(false);
  });

  it('opens nothing once the press is released (a drag, a second finger, a pinch)', async () => {
    const harness = await pageWithLink();

    harness.page.pressLinkAt(200, 30);
    expect(harness.page.pressedLink()?.url).toBe(PR_URL);
    harness.page.releaseLinkPress();
    harness.page.postCleanTap(touchEvent());

    expect(harness.posted).toEqual([{ type: 'tapped' }]);
  });

  it('finds the link through the pan and the vertical follow, from the grid box', async () => {
    const harness = await pageWithLink();
    // Panned 300 px left and translated 40 px up: the link's cells moved with the box.
    harness.screen.rect = { left: -300, top: -40, width: 600, height: 120 };

    harness.page.pressLinkAt(200 - 300, 30 - 40);

    expect(harness.page.pressedLink()?.url).toBe(PR_URL);
  });

  it('is a plain tap when the host turned links off (the probe control arm)', async () => {
    const harness = await pageWithLink();
    harness.page.setEnabled(false);

    harness.page.pressLinkAt(200, 30);
    harness.page.postCleanTap(touchEvent());

    expect(harness.posted).toEqual([{ type: 'tapped' }]);
  });

  describe('the underline overlay', () => {
    /** The boxes on screen: a reused slot with nothing to draw is hidden, not removed. */
    function shownBoxes(overlay: FakeElement): FakeElement[] {
      return overlay.children.filter((child) => !child.style.cssText.startsWith('display:none'));
    }

    /** A box's transform: where it sits, in cells and rows, and how many cells it spans. */
    function boxTransform(startColumn: number, row: number, cells: number): string {
      return `transform:translate(${startColumn * 100}%,${row * 100}%) scaleX(${cells})`;
    }

    it('underlines each link in cells of the grid, inside the screen element', async () => {
      const harness = await pageWithLink();

      harness.page.refreshTerminalLinks();

      expect(harness.screen.children).toHaveLength(1);
      const overlay = harness.screen.children[0];
      expect(overlay.style.cssText).toContain('pointer-events:none');
      expect(overlay.style.cssText).toContain('z-index:2');
      expect(overlay.children).toHaveLength(1);
      const underline = overlay.children[0].style.cssText;
      // One cell of a 60x6 grid, moved to column 2 of row 1 and stretched
      // across columns 2-56.
      expect(underline).toContain(`width:${(1 / 60) * 100}%`);
      expect(underline).toContain(`height:${(1 / 6) * 100}%`);
      expect(underline).toContain(boxTransform(2, 1, 54));
      expect(underline).toContain('transform-origin:0 0');
      expect(underline).toContain('will-change:transform');
      expect(underline).toContain('border-bottom:1px solid #f0e9dd');
      expect(harness.page.linkStats().visible).toBe(1);
    });

    it('tints the pressed link, and clears the tint on release', async () => {
      const harness = await pageWithLink();
      harness.page.refreshTerminalLinks();
      const overlay = harness.screen.children[0];

      harness.page.pressLinkAt(200, 30);
      expect(shownBoxes(overlay)).toHaveLength(2);
      // The tint first, so the underline draws over it.
      expect(overlay.children[0].style.cssText).toContain('background:#e8a33d');
      expect(overlay.children[1].style.cssText).toContain('border-bottom:1px solid #f0e9dd');

      harness.page.releaseLinkPress();
      expect(shownBoxes(overlay)).toHaveLength(1);
      expect(shownBoxes(overlay)[0].style.cssText).not.toContain('background');
    });

    /**
     * THE COST THIS OVERLAY EXISTS TO AVOID (task #147). A scrolling stream
     * moves every link on every write, and rebuilding the underlines for each
     * one was measured costing the WebView's GPU thread 15-19% of a core
     * against 2-4% without links (a release build on an emulator, one
     * diagnostic thread sample of 6 readings per arm; docs/architecture.md).
     * A moved link reuses its element, and its style string differs from the
     * last one in the transform alone.
     *
     * Mutation that reddens this: route the slot path through
     * rebuildLinkOverlay (the element is replaced and a new one made).
     */
    it('moves a link that scrolled with its own element, rewriting only the transform', async () => {
      const harness = await pageWithLink();
      harness.page.refreshTerminalLinks();
      const overlay = harness.screen.children[0];
      const underline = overlay.children[0];
      const cssBefore = underline.style.cssText;
      const createdBefore = harness.createdElements();

      // A line inserted at the top pushes the link down a row.
      await new Promise<void>((resolve) => harness.terminal.write('\x1b[1;1H\x1b[L', resolve));
      harness.page.refreshTerminalLinks();

      expect(harness.createdElements()).toBe(createdBefore);
      expect(overlay.children).toEqual([underline]);
      expect(underline.style.cssText).toBe(cssBefore.replace(boxTransform(2, 1, 54), boxTransform(2, 2, 54)));
    });

    /**
     * The retention probe's control arm keeps the overlay as it first
     * shipped, so the A/B measures the slots against it in one build.
     */
    it('rebuilds every element on a move under the rebuild arm, boxed by left and top', async () => {
      const harness = await pageWithLink();
      harness.page.setOverlayRebuild(true);
      harness.page.refreshTerminalLinks();
      const overlay = harness.screen.children[0];
      const underline = overlay.children[0];
      expect(underline.style.cssText).toContain(`left:${(2 / 60) * 100}%`);
      expect(underline.style.cssText).toContain(`width:${(54 / 60) * 100}%`);
      expect(underline.style.cssText).toContain(`top:${(1 / 6) * 100}%`);
      const createdBefore = harness.createdElements();

      await new Promise<void>((resolve) => harness.terminal.write('\x1b[1;1H\x1b[L', resolve));
      harness.page.refreshTerminalLinks();

      expect(harness.createdElements()).toBe(createdBefore + 1);
      expect(overlay.children).toHaveLength(1);
      expect(overlay.children[0]).not.toBe(underline);
      expect(overlay.children[0].style.cssText).toContain(`top:${(2 / 6) * 100}%`);
    });

    /**
     * A render fires every frame a stream is drawing, and most of those frames
     * change no link: the overlay must not be rebuilt for them.
     *
     * Mutation that reddens this: drop the signature comparison.
     */
    it('touches no DOM on a render whose links did not change', async () => {
      const harness = await pageWithLink();
      harness.page.refreshTerminalLinks();
      const createdAfterFirst = harness.createdElements();

      harness.page.refreshTerminalLinks();
      harness.page.refreshTerminalLinks();

      expect(harness.createdElements()).toBe(createdAfterFirst);
      expect(harness.page.linkStats().scans).toBe(3);
    });

    /**
     * The release-build readout (task #147): one window's counts, posted as
     * numbers only and then zeroed, so each A/B arm reads its own. `renders`
     * counts the control arm's renders too, where nothing is scanned.
     *
     * Mutations that redden this: drop the reset in reportLinkWindowStats
     * (the second report repeats the first), or count `renders` after the
     * enabled check (the control arm reports 0 renders).
     */
    it('reports a window of counts, then starts the next from zero', async () => {
      const harness = await pageWithLink();
      harness.page.armLinkStatsWindow(0);
      harness.page.refreshTerminalLinks();
      harness.page.refreshTerminalLinks();
      harness.page.refreshTerminalLinks();

      harness.page.reportLinkWindowStats();
      expect(harness.posted).toHaveLength(1);
      const first = harness.posted[0] as Record<string, unknown>;
      expect(Object.keys(first).sort()).toEqual(
        ['overlayWrites', 'renders', 'scanMsMax', 'scanMsTotal', 'scans', 'type', 'visible', 'windowMs'].sort(),
      );
      expect(first).toMatchObject({ type: 'link-stats', renders: 3, scans: 3, overlayWrites: 1, visible: 1 });
      expect(decodeTerminalMessage(JSON.stringify(first))?.type).toBe('link-stats');

      harness.page.setEnabled(false);
      harness.page.refreshTerminalLinks();
      harness.page.reportLinkWindowStats();
      expect(harness.posted[1]).toMatchObject({ type: 'link-stats', renders: 1, scans: 0, scanMsTotal: 0, overlayWrites: 0 });
    });

    /**
     * Mutation that reddens this: arm the timer whatever the interval, so a
     * store build's page runs a report timer for nothing.
     */
    it('runs the report timer only for a positive interval, and replaces it on every init', async () => {
      const harness = await pageWithLink();
      try {
        harness.page.armLinkStatsWindow(0);
        expect(harness.page.linkStatsWindowArmed()).toBe(false);
        harness.page.armLinkStatsWindow(undefined);
        expect(harness.page.linkStatsWindowArmed()).toBe(false);
        harness.page.armLinkStatsWindow(10_000);
        expect(harness.page.linkStatsWindowArmed()).toBe(true);
        harness.page.armLinkStatsWindow(0);
        expect(harness.page.linkStatsWindowArmed()).toBe(false);
      } finally {
        harness.page.armLinkStatsWindow(0);
      }
    });

    it('draws nothing and makes no overlay on a screen with no link', async () => {
      const harness = buildLinksPage();
      const terminal = await terminalWith(hardRows(['plain text only']));
      harness.page.setTerminal({ cols: 40, rows: 6, buffer: terminal.buffer, options: { theme: {} } });

      harness.page.refreshTerminalLinks();

      expect(harness.screen.children).toHaveLength(0);
    });

    /**
     * Every init clears the links before the new grid's first render: no press
     * and no underline may survive it, and the next render must redraw rather
     * than trust a signature that matches what was just wiped.
     *
     * Mutations that redden this: empty clearTerminalLinks (the first three
     * assertions), or drop its `linkOverlaySignature = ''` (the redraw).
     */
    it('clearTerminalLinks drops the press and the underline, and the next render redraws', async () => {
      const harness = await pageWithLink();
      harness.page.refreshTerminalLinks();
      harness.page.pressLinkAt(200, 30);
      const overlay = harness.screen.children[0];
      expect(overlay.children).toHaveLength(2);
      expect(harness.page.pressedLink()).not.toBeNull();

      harness.page.clearTerminalLinks();

      expect(harness.page.pressedLink()).toBeNull();
      expect(overlay.children).toHaveLength(0);

      harness.page.refreshTerminalLinks();
      expect(overlay.children).toHaveLength(1);
    });

    /**
     * With no press the signature before and after a clear is identical, so
     * only resetting it makes the next render draw into the emptied overlay.
     *
     * Mutation that reddens this: drop `linkOverlaySignature = ''` from clearTerminalLinks.
     */
    it('redraws after a clear even though the links are the same as before it', async () => {
      const harness = await pageWithLink();
      harness.page.refreshTerminalLinks();
      const overlay = harness.screen.children[0];

      harness.page.clearTerminalLinks();
      expect(overlay.children).toHaveLength(0);
      harness.page.refreshTerminalLinks();

      expect(overlay.children).toHaveLength(1);
    });

    /**
     * Mutation that reddens this: return early on `drawn.length === 0`
     * (dropping the `linkOverlayElement === null` half), which leaves the old
     * underline on a screen whose link scrolled away.
     */
    it('empties the overlay once the link is gone from the screen', async () => {
      const harness = await pageWithLink();
      harness.page.refreshTerminalLinks();
      const overlay = harness.screen.children[0];
      expect(overlay.children).toHaveLength(1);

      await new Promise<void>((resolve) => harness.terminal.write('\x1b[2J\x1b[Hno links here', resolve));
      harness.page.refreshTerminalLinks();

      // The slot stays for the next link, hidden.
      expect(shownBoxes(overlay)).toHaveLength(0);
      expect(harness.screen.children).toHaveLength(1);
    });

    /**
     * A spare slot is hidden in place and kept, and a link that returns takes
     * the same element back: slots are created only past the high-water mark.
     *
     * Mutations that redden this: remove the spare element instead of hiding
     * it (the children length drops to 0), or always create a new slot element
     * (the created count rises and the element is a different one).
     */
    it('hides a spare slot with display:none and reuses that same element when the link returns', async () => {
      const harness = await pageWithLink();
      harness.page.refreshTerminalLinks();
      const overlay = harness.screen.children[0];
      const slotElement = overlay.children[0];
      const createdAfterFirst = harness.createdElements();

      await new Promise<void>((resolve) => harness.terminal.write('\x1b[2J\x1b[Hno links here', resolve));
      harness.page.refreshTerminalLinks();

      expect(overlay.children).toHaveLength(1);
      expect(overlay.children[0]).toBe(slotElement);
      expect(slotElement.style.cssText).toBe('display:none;');

      await new Promise<void>((resolve) => harness.terminal.write(`\x1b[2J${hardRows(['', `  ${PR_URL}`])}`, resolve));
      harness.page.refreshTerminalLinks();

      expect(harness.createdElements()).toBe(createdAfterFirst);
      expect(overlay.children).toHaveLength(1);
      expect(overlay.children[0]).toBe(slotElement);
      expect(slotElement.style.cssText).toContain(boxTransform(2, 1, 54));
    });

    /**
     * Two links, one of which moves while the other keeps its box: only the
     * moved slot's style is assigned again.
     *
     * Mutation that reddens this: drop the `css !== slot.css` comparison in
     * writeLinkOverlaySlots (always assign), which gives the unchanged slot a
     * second write.
     */
    it('does not rewrite the style of a slot whose box did not change', async () => {
      const harness = await pageWithLink();
      await new Promise<void>((resolve) => harness.terminal.write('\x1b[4;1H\x1b[2K  https://example.com/second', resolve));
      harness.page.refreshTerminalLinks();
      const overlay = harness.screen.children[0];
      expect(overlay.children).toHaveLength(2);
      expect(overlay.children[0].style.cssText).toContain(boxTransform(2, 1, 54));
      expect(overlay.children[1].style.cssText).toContain(boxTransform(2, 3, 26));

      const writes = [0, 0];
      overlay.children.forEach((child, index) => {
        let current = child.style.cssText;
        Object.defineProperty(child.style, 'cssText', {
          configurable: true,
          get: () => current,
          set: (value: string) => {
            writes[index] += 1;
            current = value;
          },
        });
      });

      // The first link moves to column 4 of its row; the second stays put.
      await new Promise<void>((resolve) => harness.terminal.write(`\x1b[2;1H\x1b[2K    ${PR_URL}`, resolve));
      harness.page.refreshTerminalLinks();

      expect(overlay.children[0].style.cssText).toContain(boxTransform(4, 1, 54));
      expect(writes).toEqual([1, 0]);
    });

    describe('the stats window timer and values', () => {
      let currentNow = 0;

      afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
      });

      function fakeIntervals(): void {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      }

      /** Mutation that reddens this: pass a no-op as the interval's callback. */
      it('posts one link-stats report each period the window was armed for', async () => {
        fakeIntervals();
        const harness = await pageWithLink();
        harness.page.armLinkStatsWindow(1000);
        harness.page.refreshTerminalLinks();
        harness.page.refreshTerminalLinks();
        expect(harness.posted).toHaveLength(0);

        vi.advanceTimersByTime(1000);

        expect(harness.posted).toHaveLength(1);
        expect(harness.posted[0]).toMatchObject({ type: 'link-stats', renders: 2 });
        harness.page.armLinkStatsWindow(0);
      });

      /** Mutation that reddens this: drop the clearInterval in armLinkStatsWindow (the period posts twice). */
      it('clears the previous interval when it is armed again', async () => {
        fakeIntervals();
        const harness = await pageWithLink();
        harness.page.armLinkStatsWindow(1000);
        harness.page.armLinkStatsWindow(1000);

        vi.advanceTimersByTime(1000);

        expect(harness.posted).toHaveLength(1);
        harness.page.armLinkStatsWindow(0);
      });

      /** Mutation that reddens this: drop `linkWindowStats = freshLinkWindowStats()` from armLinkStatsWindow. */
      it('starts a fresh window when it is armed', async () => {
        const harness = await pageWithLink();
        harness.page.refreshTerminalLinks();
        harness.page.refreshTerminalLinks();

        harness.page.armLinkStatsWindow(0);
        harness.page.reportLinkWindowStats();

        expect(harness.posted[0]).toMatchObject({ type: 'link-stats', renders: 0, scans: 0 });
      });

      it.each([[0], [-5], [Number.NaN], ['1000'], [undefined]])(
        'arms no timer for the interval %s',
        async (windowMs) => {
          fakeIntervals();
          const harness = await pageWithLink();
          harness.page.armLinkStatsWindow(windowMs);

          vi.advanceTimersByTime(60_000);

          expect(harness.posted).toHaveLength(0);
          expect(harness.page.linkStatsWindowArmed()).toBe(false);
        },
      );

      /**
       * Mutations that redden this: flip the subtraction in windowMs (it goes
       * negative), or never update linkWindowStats.scanMsMax (it reads 0).
       */
      it('reports the clock delta between windows, the rounded scan times, and visible 0 after a links-off render', async () => {
        const harness = await pageWithLink();
        const nowSpy = vi.spyOn(globalThis.performance, 'now');
        currentNow = 1000;
        nowSpy.mockImplementation(() => currentNow);
        harness.page.armLinkStatsWindow(0);

        // Each scan reads the clock twice: before and after.
        nowSpy.mockReturnValueOnce(2000).mockReturnValueOnce(2012.504);
        harness.page.refreshTerminalLinks();
        nowSpy.mockReturnValueOnce(2100).mockReturnValueOnce(2103.254);
        harness.page.refreshTerminalLinks();

        currentNow = 5000;
        harness.page.reportLinkWindowStats();

        expect(harness.posted[0]).toMatchObject({
          type: 'link-stats',
          windowMs: 4000,
          scans: 2,
          scanMsTotal: 15.76,
          scanMsMax: 12.5,
          visible: 1,
        });

        harness.page.setEnabled(false);
        harness.page.refreshTerminalLinks();
        currentNow = 7000;
        harness.page.reportLinkWindowStats();

        expect(harness.posted[1]).toMatchObject({ windowMs: 2000, renders: 1, scans: 0, scanMsMax: 0, visible: 0 });
      });
    });

    /**
     * Mutation that reddens this: make the signature comparison always match
     * (`if (linkOverlayElement) return` in place of the signature test).
     */
    it('redraws when the link moves to another row', async () => {
      const harness = await pageWithLink();
      harness.page.refreshTerminalLinks();
      const overlay = harness.screen.children[0];
      expect(overlay.children[0].style.cssText).toContain(boxTransform(2, 1, 54));

      await new Promise<void>((resolve) => harness.terminal.write(`\x1b[2J${hardRows(['', '', '', `  ${PR_URL}`])}`, resolve));
      harness.page.refreshTerminalLinks();

      expect(overlay.children).toHaveLength(1);
      expect(overlay.children[0].style.cssText).toContain(boxTransform(2, 3, 54));
    });

    it('redraws when the grid changes under an unmoved link', async () => {
      const harness = await pageWithLink();
      harness.page.refreshTerminalLinks();
      const overlay = harness.screen.children[0];

      harness.page.setTerminal({
        cols: 60,
        rows: 8,
        buffer: harness.terminal.buffer,
        options: { theme: { foreground: '#f0e9dd', cursor: '#e8a33d' } },
      });
      harness.page.refreshTerminalLinks();

      // Still row 1, now a row of an 8-row grid.
      expect(overlay.children[0].style.cssText).toContain(`height:${(1 / 8) * 100}%`);
      expect(overlay.children[0].style.cssText).toContain(boxTransform(2, 1, 54));
    });

    /**
     * A hard re-init empties the grid host, taking the overlay with it. The
     * signature still matches, so only the isConnected test recreates it.
     *
     * Mutation that reddens this: drop `&& linkOverlayElement.isConnected`
     * from the signature test in renderLinkOverlay.
     */
    it('recreates an overlay that was detached, even when the links did not change', async () => {
      const harness = await pageWithLink();
      harness.page.refreshTerminalLinks();
      harness.screen.children[0].isConnected = false;
      const createdBefore = harness.createdElements();

      harness.page.refreshTerminalLinks();

      expect(harness.screen.children).toHaveLength(2);
      expect(harness.createdElements()).toBeGreaterThan(createdBefore);
      expect(harness.screen.children[1].children).toHaveLength(1);
    });

    /**
     * Mutation that reddens this: make refreshTerminalLinks reset
     * `pressedLink = null` before it renders.
     */
    it('keeps the press tint through a refresh while the finger is down', async () => {
      const harness = await pageWithLink();
      harness.page.refreshTerminalLinks();
      harness.page.pressLinkAt(200, 30);
      const overlay = harness.screen.children[0];
      expect(overlay.children).toHaveLength(2);
      const createdBefore = harness.createdElements();

      harness.page.refreshTerminalLinks();

      expect(harness.page.pressedLink()?.url).toBe(PR_URL);
      expect(overlay.children).toHaveLength(2);
      expect(harness.createdElements()).toBe(createdBefore);
    });

    /**
     * Mutation that reddens this: drop the `!terminalLinksEnabled` early
     * return in refreshTerminalLinks (the scan counter then rises).
     */
    it('does not scan or draw while links are off', async () => {
      const harness = await pageWithLink();
      harness.page.setEnabled(false);

      harness.page.refreshTerminalLinks();

      expect(harness.page.linkStats().scans).toBe(0);
      expect(harness.screen.children).toHaveLength(0);
    });
  });

  describe('the hit test needs a real grid box', () => {
    /**
     * Mutation that reddens this: drop the `if (!screen) return null` guard
     * (the lookup then throws on null).
     */
    it('presses nothing when the screen element is missing', async () => {
      const harness = await pageWithLink();
      harness.page.setScreenPresent(false);

      harness.page.pressLinkAt(200, 30);

      expect(harness.page.pressedLink()).toBeNull();
    });

    /**
     * With a zero-size box the cell size is 0 and the point maps to (0, 0),
     * which would sit exactly on a zero-width link cell, so only the guard
     * keeps these null.
     *
     * Mutation that reddens this: drop the `rect.width > 0` or
     * `rect.height > 0` test from linkAtClientPoint.
     */
    it.each([
      ['no width', { left: 0, top: 0, width: 0, height: 120 }, 0, 30],
      ['no height', { left: 0, top: 0, width: 600, height: 0 }, 25, 0],
    ])('presses nothing when the grid box has %s', async (_label, rect, pointX, pointY) => {
      const harness = await pageWithLink();
      harness.screen.rect = rect;

      harness.page.pressLinkAt(pointX, pointY);

      expect(harness.page.pressedLink()).toBeNull();
    });
  });
});

describe('bootstrap.js wires the tap through links.js', () => {
  const bootstrapSource = readFileSync(join(__dirname, '..', '..', 'scripts', 'xterm-page', 'bootstrap.js'), 'utf8');
  const listenerBody = (eventName: string): string => {
    const start = bootstrapSource.indexOf(`addEventListener('${eventName}'`);
    expect(start, `bootstrap.js registers ${eventName}`).toBeGreaterThan(-1);
    return bootstrapSource.slice(start, bootstrapSource.indexOf('});', start) + 3);
  };

  it('presses a link where a single finger lands, and releases it on a second finger', () => {
    const body = listenerBody('touchstart');
    expect(body).toContain('pressLinkAt(tapStartX, tapStartY)');
    expect(body).toContain('releaseLinkPress()');
  });

  it('releases the press when the gesture moves past the slop or is cancelled', () => {
    expect(listenerBody('touchmove')).toContain('releaseLinkPress()');
    expect(listenerBody('touchcancel')).toContain('releaseLinkPress()');
  });

  /**
   * The touchend listener has to be able to cancel a link tap's compatibility
   * mouse events, so it must not be passive, and the clean tap goes through
   * postCleanTap, which alone decides between 'open-link' and 'tapped'.
   *
   * Mutation that reddens this: register touchend `{ passive: true }`, or post
   * 'tapped' from it directly.
   */
  it('ends a clean tap through postCleanTap on a listener that can cancel it', () => {
    const start = bootstrapSource.indexOf("addEventListener('touchend'");
    const end = bootstrapSource.indexOf("addEventListener('click'");
    const registration = bootstrapSource.slice(start, end);
    expect(registration).toContain('postCleanTap(touchEvent)');
    expect(registration).not.toContain("type: 'tapped'");
    expect(registration).toContain('{ passive: false }');
  });
});

describe('bootstrap.js touch listeners, executed against a fake container', () => {
  const bootstrapSource = readFileSync(join(__dirname, '..', '..', 'scripts', 'xterm-page', 'bootstrap.js'), 'utf8');
  const listenersStart = bootstrapSource.indexOf("container.addEventListener('touchstart'");
  const listenersEnd = bootstrapSource.indexOf("container.addEventListener('click'");

  interface TouchPoint {
    clientX: number;
    clientY: number;
  }

  interface TouchListenerEvent {
    touches: TouchPoint[];
  }

  type Listener = (touchEvent: TouchListenerEvent) => void;

  /** The container block of bootstrap.js with every global it reads replaced by a recording fake. */
  function buildTouchListeners(): {
    fire: (eventName: string, touchEvent: TouchListenerEvent) => void;
    calls: string[];
    tapDirty: () => boolean;
    advanceClock: (milliseconds: number) => void;
  } {
    expect(listenersStart).toBeGreaterThan(-1);
    expect(listenersEnd).toBeGreaterThan(listenersStart);
    const calls: string[] = [];
    const listeners: Record<string, Listener> = {};
    const container = {
      addEventListener: (eventName: string, listener: Listener) => {
        listeners[eventName] = listener;
      },
    };
    const touchCounts = { start: 0, move: 0, end: 0, cancel: 0 };
    let clock = 1_000_000;
    const build = new Function(
      'container',
      'calls',
      'touchCounts',
      'now',
      `var pinnedToStart = true;
       var manualPanUntil = 0;
       var MANUAL_PAN_PAUSE_MS = 4000;
       var dragSamples = [1];
       var pinchActive = true;
       var tapDirty = false;
       var tapStartX = 0;
       var tapStartY = 0;
       var tapStartAt = 0;
       var TAP_SLOP_PX = 12;
       var TAP_MAX_MS = 350;
       var historyDragAnchorY = null;
       var historyDragStartX = null;
       var historyDragAxis = null;
       var Date = { now: now };
       function stopHistoryFling() {}
       function consumeHistoryDrag() {}
       function maybeStartHistoryFling() {}
       function pressLinkAt(x, y) { calls.push('pressLinkAt'); }
       function releaseLinkPress() { calls.push('releaseLinkPress'); }
       function postCleanTap() { calls.push('postCleanTap'); }
       ${bootstrapSource.slice(listenersStart, listenersEnd)}
       return { tapDirty: function () { return tapDirty; } };`,
    ) as (...dependencies: unknown[]) => { tapDirty: () => boolean };
    const built = build(container, calls, touchCounts, () => clock);
    return {
      fire: (eventName, touchEvent) => listeners[eventName](touchEvent),
      calls,
      tapDirty: built.tapDirty,
      advanceClock: (milliseconds) => {
        clock += milliseconds;
      },
    };
  }

  const finger = (clientX: number, clientY: number): TouchPoint => ({ clientX, clientY });

  it('presses a link where one finger lands', () => {
    const rig = buildTouchListeners();

    rig.fire('touchstart', { touches: [finger(10, 10)] });

    expect(rig.calls).toEqual(['pressLinkAt']);
  });

  /**
   * Mutation that reddens this: delete the releaseLinkPress() in the
   * multi-finger else branch of touchstart.
   */
  it('releases the press when a second finger lands, and presses nothing', () => {
    const rig = buildTouchListeners();

    rig.fire('touchstart', { touches: [finger(10, 10), finger(50, 50)] });

    expect(rig.calls).toEqual(['releaseLinkPress']);
    expect(rig.tapDirty()).toBe(true);
  });

  /**
   * Mutation that reddens this: delete the releaseLinkPress() in the touchmove
   * slop branch (a 13 px drag then leaves the tint on).
   */
  it('releases the press once a drag passes the tap slop, and not before', () => {
    const rig = buildTouchListeners();
    rig.fire('touchstart', { touches: [finger(10, 10)] });
    rig.calls.length = 0;

    rig.fire('touchmove', { touches: [finger(10, 10 + 12)] });
    expect(rig.calls).toEqual([]);
    expect(rig.tapDirty()).toBe(false);

    rig.fire('touchmove', { touches: [finger(10, 10 + 13)] });
    expect(rig.calls).toEqual(['releaseLinkPress']);
    expect(rig.tapDirty()).toBe(true);
  });

  /**
   * Mutation that reddens this: delete the releaseLinkPress() in the touchmove
   * dirty / multi-touch early return.
   */
  it.each([
    ['a second finger moving', { touches: [finger(10, 10), finger(50, 50)] }],
    ['any move after the tap went dirty', null],
  ])('releases the press on %s', (_label, secondMove) => {
    const rig = buildTouchListeners();
    rig.fire('touchstart', { touches: [finger(10, 10)] });
    if (secondMove === null) {
      rig.fire('touchmove', { touches: [finger(10, 40)] });
    }
    rig.calls.length = 0;

    rig.fire('touchmove', secondMove ?? { touches: [finger(10, 10)] });

    expect(rig.calls).toEqual(['releaseLinkPress']);
  });

  /**
   * Mutation that reddens this: delete the releaseLinkPress() in touchcancel.
   */
  it('releases the press when the browser cancels the gesture', () => {
    const rig = buildTouchListeners();
    rig.fire('touchstart', { touches: [finger(10, 10)] });
    rig.calls.length = 0;

    rig.fire('touchcancel', { touches: [] });

    expect(rig.calls).toEqual(['releaseLinkPress']);
  });

  /**
   * postCleanTap reads the pressed link that releaseLinkPress nulls, so the
   * tap must come first or a link tap would never post open-link.
   *
   * Mutation that reddens this: swap the postCleanTap and releaseLinkPress
   * lines in the touchend listener.
   */
  it('posts the tap before it releases the press, and releases after a clean tap', () => {
    const rig = buildTouchListeners();
    rig.fire('touchstart', { touches: [finger(10, 10)] });
    rig.calls.length = 0;

    rig.fire('touchend', { touches: [] });

    expect(rig.calls).toEqual(['postCleanTap', 'releaseLinkPress']);
    expect(rig.tapDirty()).toBe(true);
  });

  it('releases without posting a tap when the gesture was a drag or a long press', () => {
    const dragged = buildTouchListeners();
    dragged.fire('touchstart', { touches: [finger(10, 10)] });
    dragged.fire('touchmove', { touches: [finger(10, 60)] });
    dragged.calls.length = 0;
    dragged.fire('touchend', { touches: [] });
    expect(dragged.calls).toEqual(['releaseLinkPress']);

    const held = buildTouchListeners();
    held.fire('touchstart', { touches: [finger(10, 10)] });
    held.calls.length = 0;
    held.advanceClock(351);
    held.fire('touchend', { touches: [] });
    expect(held.calls).toEqual(['releaseLinkPress']);
  });

  it('does nothing at the end of a gesture while another finger is still down', () => {
    const rig = buildTouchListeners();
    rig.fire('touchstart', { touches: [finger(10, 10)] });
    rig.calls.length = 0;

    rig.fire('touchend', { touches: [finger(50, 50)] });

    expect(rig.calls).toEqual([]);
  });
});
