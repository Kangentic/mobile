#!/usr/bin/env node
/**
 * DEVELOPER UTILITY - not run in CI.
 *
 * Turns a raw PTY capture from `scripts/captureClaudeFrames.mjs` into the
 * committed fixture module the mock desktop replays.
 *
 *   node scripts/buildTerminalFixture.mjs \
 *     --capture capture-66x48.jsonl --cols 66 --rows 48 \
 *     --grid-cols 210 --grid-rows 48 \
 *     --seed-end <N> --end <N - 1> --export CLAUDE_CAPTURE_SHOTS
 *
 * where N is the capture's chunk count: a SEED-ONLY fixture whose seed is the
 * settled final frame, which is what the committed one is.
 *
 * `--cols/--rows` are the grid the capture was RECORDED at, and the only grid
 * its bytes replay correctly into. `--grid-cols/--grid-rows` are the grid the
 * mock ANNOUNCES (default: the recorded one), and the seed frame is widened to
 * it. The committed fixture is recorded narrow enough for its text to sit
 * inside the narrowest store shelf, and announced at the desktop's resting
 * grid, 210x48, so it fills the mirror's reference cell edge to edge on every
 * shelf (src/connection/mockDesktop.ts, above activeCapture(), has the
 * numbers; tests/unit/storeScreenshots.test.ts enforces them).
 *
 * WHY A SEED FRAME AND NOT JUST THE CHUNKS
 *
 * Claude Code repaints incrementally with cursor addressing, so there is no
 * mid-session boundary where the byte stream alone reconstructs the screen -
 * a capture sliced anywhere but chunk 0 renders into a fresh terminal as
 * fragments. So the slice before `--seed-end` is replayed into a headless
 * xterm and SERIALIZED into one self-contained frame, and only chunks after it
 * stream. That is how the desktop seeds a real phone too.
 *
 * The frame is written as PHYSICAL ROWS (scripts/terminalFrame.mjs), one per
 * buffer row, rather than by @xterm/addon-serialize, which the desktop's phone
 * seed uses. At the recorded grid the two render identically; only physical
 * rows survive being widened, because the addon joins a soft-wrapped row onto
 * the one above and relies on the terminal wrapping at exactly the recorded
 * width. The terminal MODES the addon would carry (bracketed paste, focus, mouse
 * reporting) are appended the way the addon writes them, because the phone
 * acts on them, and the cursor is hidden if the recording last hid it. Like the
 * addon's, the seed puts the cursor back with RELATIVE moves rather than one
 * absolute position, because the phone's live-tail cleaner reads an absolute
 * position as a full repaint and would show the chat lens an empty tail.
 *
 * WHY WIDENING DOES NOT BREAK "NEVER REWRITE THE CAPTURE"
 *
 * Widening re-serializes a recorded buffer: it adds cells past the recorded
 * width (a rule run on, a diff band grown, a right border moved out) and never
 * authors or moves a displayed character inside it. That is checked on every
 * build rather than argued, in two steps:
 *
 * - the seed at the RECORDED grid must reproduce the raw capture's screen
 *   text exactly (the round trip below);
 * - the widened seed must then match that recorded-grid seed cell for cell,
 *   glyph and style, inside the recorded width, except for a right border
 *   that moved out and the blank cells after a row's last glyph (the CLI's
 *   right padding, which a band or rule crosses on its way to the new edge).
 *   Past the recorded width only fill may appear.
 *
 * "Identical" is to the serialized screen, not to every byte of the capture:
 * the serializer writes a space that draws nothing (a foreground colour and no
 * background) as a plain space, see looksBlank() in terminalFrame.mjs, and it
 * drops trailing padding. Neither changes a pixel. A frame with a right-aligned
 * label (which widening moves out to the new edge, off every phone screen)
 * fails the check by design: pick another frame.
 *
 * WHY THIS VERIFIES INSTEAD OF SANITIZING
 *
 * The obvious design - rewrite `\Users\<name>\` and the operator's email out of
 * the bytes, the way the desktop's replay-fixture sanitizer does - is WRONG
 * here, and measurably so. Those files are line-oriented logs; this is a
 * cursor-addressed TUI, where a replacement of a different length shifts every
 * cell after it on that row and the following relative cursor moves land in the
 * wrong column. The observed result is scrambled words ("has one caller"
 * rendering as "xhaseonedcaller,n"), not a visibly broken frame. An
 * unsanitized round-trip reproduces the captured screen exactly; a sanitized one
 * does not.
 *
 * So cleanliness is a property of the RECORDING, not a post-process: capture
 * against a throwaway storefront fixture repo, and pick a window whose frames
 * carry no identity (the startup banner shows the operator's name, org email
 * and home path, so windows containing it are rejected). This script fails
 * rather than writes if anything slips through, and
 * tests/unit/mockDesktopFixtures.test.ts re-checks the committed result.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { isAbsolute, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
  HORIZONTAL_RULE_GLYPHS,
  VERTICAL_EDGE_GLYPHS,
  serializeModes,
  serializePhysicalRows,
  widenFrame,
  withRelativeCursor,
} from './terminalFrame.mjs';

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');

/**
 * Scrollback the PARSER retains. Matches the desktop's own
 * SERIALIZED_SCROLLBACK_LINES so the fixture cannot be shaped by a limit the
 * real path does not have.
 *
 * Nothing above the SCREEN is ever written into the seed (serializePhysicalRows
 * keeps the visible rows only). Claude Code runs full-screen in the alt
 * buffer, which has no scrollback of its own, so everything the session shows
 * is on screen; what sits above it is the NORMAL buffer's shell output from
 * before the TUI took over, which on the recording machine is the startup
 * banner carrying the operator's name, org email and home directory. Seeding
 * it would ship identity that is one scroll-up away on the phone.
 */
const SERIALIZED_SCROLLBACK_LINES = 500;

/**
 * What widening may put past the recorded width: blanks, rules run on, and
 * borders moved out. Taken from the widener's own glyph sets, so the check
 * accepts exactly what terminalFrame.mjs can draw there.
 */
const WIDENING_FILL_GLYPHS = ` ${HORIZONTAL_RULE_GLYPHS}${VERTICAL_EDGE_GLYPHS}`;
/** The right-edge glyphs widening MOVES out to the new edge, so they may vanish from inside the recorded width. */
const MOVABLE_EDGE_GLYPHS = VERTICAL_EDGE_GLYPHS;
/**
 * Private modes a chunk may still toggle after a widened seed: cursor keys and
 * blink, cursor visibility, mouse and focus reporting, bracketed paste and
 * synchronized output. None of them paints a cell. An alternate-screen swap
 * (47, 1047, 1049), a column-mode switch or reverse video repaints the screen,
 * so it is not on the list.
 */
const CELL_FREE_PRIVATE_MODES = new Set([1, 12, 25, 1000, 1002, 1003, 1004, 1005, 1006, 1015, 2004, 2026]);

/**
 * Terms that must never reach a committed fixture. Kept in step with
 * KANGENTIC_DOMAIN_TERMS in tests/unit/mockDesktopFixtures.test.ts - this is
 * the build-time half of the same guard, so a bad capture fails here rather
 * than at review.
 */
const BANNED_TERMS = [
  'relay', 'pairing', 'paired', 'noise', 'maestro', 'expo', 'react native',
  'capability', 'register-push', 'push token', 'push-notification', 'pty',
  'scrollback', 'sas', 'qr', 'kangentic',
  // Words that admit the content is not real. Kept in step with
  // KANGENTIC_DOMAIN_TERMS in tests/unit/mockDesktopFixtures.test.ts, which
  // asserts the two lists are identical.
  'mock', 'demo',
];

/**
 * Personal and machine-specific markers. Matched, never rewritten - see the
 * header. A hit means the window is wrong, not that the text needs fixing.
 */
const PERSONAL_MARKERS = [
  /Welcome back \w/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/,
  // Separator-tolerant on purpose. A TUI cursor-addresses between glyphs, so
  // after escape sequences are flattened a path arrives as "AppData Local Temp"
  // or even "AppDataLocalTemp". Requiring a real `\` or `/` here is how an
  // earlier version of this check passed a file that did contain the operator's
  // home directory.
  /Users\W*(?!dev\b|Public\b)[A-Za-z0-9._-]+/i,
  /AppData\W*Local\W*Temp/i,
  /\d+%\W*of\W*your\W*weekly\W*limit/i,
];

function fail(message) {
  console.error(`buildTerminalFixture: ${message}`);
  process.exit(1);
}

/**
 * The ONE rewrite that is safe on a cursor-addressed capture.
 *
 * Claude Code wraps tool targets in OSC 8 hyperlinks, whose payload is the
 * ABSOLUTE file URI even though the visible text is a relative path:
 *   ESC ] 8 ; id=... ; file:///C:/Users/<name>/... ESC \  src\auth\login.ts
 * So a frame that reads clean on screen still carries the recording machine's
 * home directory in its bytes, and this repo is public.
 *
 * Rewriting it is safe precisely because an OSC sequence occupies ZERO cells:
 * changing its length cannot move anything on the grid, which is what makes
 * this different from rewriting displayed text. The round-trip check downstream
 * proves it, rather than taking the argument on trust.
 */
function rewriteHyperlinkTargets(text) {
  return text.replace(/(\x1b\]8;[^;\x1b\x07]*;)([^\x1b\x07]*)([\x1b\x07])/g, (_match, open, uri, terminator) => {
    const relative = /\/((?:src|tests|app|scripts)\/.*)$/.exec(uri);
    const rewritten = relative ? `file:///C:/code/storefront-web/${relative[1]}` : '';
    return `${open}${rewritten}${terminator}`;
  });
}

/**
 * Escape-stripped view of a frame, for the ban check. Without this the check
 * reads SGR parameter bytes as text and a term split across a cursor-move
 * would slip past.
 */
function stripSequences(raw, separator) {
  return raw
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, separator)
    .replace(/\x1b\[[0-9;?<>]*[ -/]*[@-~]/g, separator)
    .replace(/\x1b[@-Z\\-_]/g, separator);
}

/**
 * The two checks need OPPOSITE flattening, which is why they are separate.
 *
 * Vocabulary is a whole-word test, so sequences must collapse to NOTHING:
 * a TUI splits words for kerning, and `expo` + move + `rt` has to rejoin as
 * `export` or every `export` in a captured diff reads as the banned term
 * `expo`. Identity is a multi-token test, so sequences must collapse to a
 * SPACE: `AppData` + move + `Local` has to stay two tokens to match. Running
 * either check against the other's flattening produces exactly one of those
 * two failures, and both were observed while building this.
 */
function findOffenders(text) {
  const rejoined = stripSequences(text, '');
  const separated = stripSequences(text, ' ');
  const offenders = BANNED_TERMS.filter((term) => new RegExp(`\\b${term}\\b`, 'i').test(rejoined));
  for (const marker of PERSONAL_MARKERS) {
    // Raw bytes too: an OSC hyperlink target renders nothing but still ships.
    const match = marker.exec(separated) ?? marker.exec(text);
    if (match) offenders.push(match[0].trim());
  }
  return offenders;
}

function assertClean(label, text) {
  const offenders = [...new Set(findOffenders(text))];
  if (offenders.length > 0) {
    fail(
      `${label} contains ${offenders.join(', ')}.\n` +
        '  This is a WINDOW problem, not a text problem: rewriting the bytes would shift the TUI layout.\n' +
        '  Pick a window past the startup banner, or re-record against the storefront fixture repo.',
    );
  }
}

/** Emit a TS string literal: single-quoted, with control bytes as \xNN / \uNNNN. */
function toTypeScriptLiteral(text) {
  let out = "'";
  for (const character of text) {
    const code = character.codePointAt(0);
    if (character === "'") out += "\\'";
    else if (character === '\\') out += '\\\\';
    else if (code === 0x0a) out += '\\n';
    else if (code === 0x0d) out += '\\r';
    else if (code < 0x20 || code === 0x7f) out += `\\x${code.toString(16).padStart(2, '0')}`;
    else out += character;
  }
  return `${out}'`;
}

const { values } = parseArgs({
  options: {
    capture: { type: 'string' },
    cols: { type: 'string' },
    rows: { type: 'string' },
    'grid-cols': { type: 'string' },
    'grid-rows': { type: 'string' },
    'seed-end': { type: 'string' },
    end: { type: 'string' },
    export: { type: 'string' },
    out: { type: 'string', default: 'src/devsupport/claudeCapture.ts' },
  },
});

if (!values.capture) fail('--capture is required');
const cols = Number.parseInt(values.cols ?? '', 10);
const rows = Number.parseInt(values.rows ?? '', 10);
if (!Number.isInteger(cols) || !Number.isInteger(rows)) fail('--cols and --rows are required');
if (!values.export) fail('--export is required (the exported constant name)');
const gridCols = Number.parseInt(values['grid-cols'] ?? String(cols), 10);
const gridRows = Number.parseInt(values['grid-rows'] ?? String(rows), 10);
if (!Number.isInteger(gridCols) || !Number.isInteger(gridRows)) fail('--grid-cols and --grid-rows must be integers');
if (gridRows !== rows) fail(`--grid-rows ${gridRows} must equal --rows ${rows}: a frame is widened, never made taller`);
if (gridCols < cols) fail(`--grid-cols ${gridCols} is narrower than --cols ${cols}: a frame is widened, never cut`);
const widening = gridCols !== cols;

const capturePath = isAbsolute(values.capture) ? values.capture : resolve(process.cwd(), values.capture);
// Hyperlink targets are rewritten at LOAD, so the seed, the streamed chunks and
// the expected-grid comparison all run on identical bytes.
const allChunks = readFileSync(capturePath, 'utf8')
  .trim()
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line))
  .map((chunk) => ({ offsetMs: chunk.offsetMs, data: rewriteHyperlinkTargets(chunk.data) }));

// `--seed-end` is EXCLUSIVE: the seed is chunks [0, seed-end) and the stream is
// [seed-end, end]. So `--seed-end <end + 1>` is a SEED-ONLY fixture, which is
// what a widened capture usually wants: everything after the settled frame was
// recorded for the narrow grid.
const seedEnd = Number.parseInt(values['seed-end'] ?? String(Math.floor(allChunks.length * 0.9)), 10);
const end = Number.parseInt(values.end ?? String(allChunks.length - 1), 10);
if (!(seedEnd > 0 && seedEnd <= end + 1 && end < allChunks.length)) {
  fail(`--seed-end/--end out of range for ${allChunks.length} chunks`);
}

function createTerminal(terminalCols, terminalRows) {
  return new Terminal({
    cols: terminalCols,
    rows: terminalRows,
    scrollback: SERIALIZED_SCROLLBACK_LINES,
    allowProposedApi: true,
  });
}

/**
 * xterm parses writes on a macrotask, so reading a buffer without this barrier
 * snapshots a stale grid. A zero-length write's callback fires only once every
 * queued chunk ahead of it has been parsed.
 */
function settle(terminal) {
  return new Promise((resolveFlush) => terminal.write('', resolveFlush));
}

/**
 * Whether the recording left the cursor HIDDEN by the end of `[0, candidateEnd)`:
 * the last DECTCEM toggle wins. The serializers carry no cursor visibility, and
 * Claude Code hides the cursor while it draws, so a seed without this shows a
 * stray cursor block wherever the TUI last stopped writing.
 */
function cursorHiddenAt(candidateEnd) {
  let hidden = false;
  for (let index = 0; index < candidateEnd; index += 1) {
    for (const match of allChunks[index].data.matchAll(/\x1b\[\?((?:\d+;)*25(?:;\d+)*)([hl])/g)) {
      hidden = match[2] === 'l';
    }
  }
  return hidden;
}

/**
 * The settled screen must be cells this pipeline counts exactly: one code
 * point, one cell. Widening counts cells by code point (scripts/terminalFrame.mjs),
 * and the phone's xterm runs Unicode 6 widths, so a wide or combining glyph is
 * where the two could disagree. Failing here is cheaper than finding out in a
 * store image.
 */
function assertNarrowCells(terminal) {
  const buffer = terminal.buffer.active;
  const scratchCell = buffer.getNullCell();
  for (let row = 0; row < terminal.rows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    if (!line) continue;
    for (let column = 0; column < terminal.cols; column += 1) {
      const cell = line.getCell(column, scratchCell);
      if (!cell) continue;
      const characters = cell.getChars();
      if (cell.getWidth() !== 1 || [...characters].length > 1) {
        fail(
          `row ${row}, column ${column} holds "${characters}" (width ${cell.getWidth()}). ` +
            'Only one-cell, one-code-point glyphs survive widening exactly; pick a frame without it.',
        );
      }
    }
  }
}

/**
 * The seed at the RECORDED grid, as it stands after replaying `[0, candidateEnd)`:
 * physical rows, then the modes the recording left on, then the cursor's
 * visibility. Also returns the bare physical-row frame, which is what widening
 * takes.
 */
async function buildSeedFrame(candidateEnd) {
  const terminal = createTerminal(cols, rows);
  for (let index = 0; index < candidateEnd; index += 1) terminal.write(allChunks[index].data);
  await settle(terminal);
  const physicalRows = serializePhysicalRows(terminal);
  const tail = serializeModes(terminal) + (cursorHiddenAt(candidateEnd) ? '\x1b[?25l' : '');
  return { terminal, physicalRows, tail, seedFrame: withRelativeCursor(physicalRows) + tail };
}

/**
 * Render a byte stream at a grid and read the visible cells back as text.
 *
 * Trailing whitespace is trimmed, not just trailing EMPTY cells (which is all
 * `translateToString(true)` drops): the raw capture pads rows with written
 * spaces, and the physical-row seed leaves those cells empty instead. The two
 * look identical, and a row's background is not text either way, so the
 * widening check below compares cells, styles included.
 */
async function renderToText(writes, terminalCols = cols, terminalRows = rows) {
  const target = createTerminal(terminalCols, terminalRows);
  for (const write of writes) target.write(write);
  await settle(target);
  const buffer = target.buffer.active;
  const lines = [];
  for (let y = buffer.baseY; y < buffer.baseY + terminalRows; y += 1) {
    const line = buffer.getLine(y);
    lines.push(line ? line.translateToString(true).trimEnd() : '');
  }
  target.dispose();
  return lines.join('\n');
}

// The whole point of the seed is that seed + streamed chunks reconstructs the
// screen the full capture ends on. Prove it rather than discovering a
// fragment-rendering fixture in a store screenshot.
//
// Not every boundary round-trips, so search outward from the requested index
// for the nearest that does rather than making the caller hunt for one.
const expectedGrid = await renderToText(allChunks.slice(0, end + 1).map((chunk) => chunk.data));

const SEED_SEARCH_RADIUS = 60;
let seed = null;
let resolvedSeedEnd = null;
for (let offset = 0; offset <= SEED_SEARCH_RADIUS && resolvedSeedEnd === null; offset += 1) {
  for (const candidate of offset === 0 ? [seedEnd] : [seedEnd - offset, seedEnd + offset]) {
    if (candidate < 1 || candidate > end + 1) continue;
    const candidateSeed = await buildSeedFrame(candidate);
    const replayed = await renderToText([
      candidateSeed.seedFrame,
      ...allChunks.slice(candidate, end + 1).map((chunk) => chunk.data),
    ]);
    if (replayed === expectedGrid) {
      seed = candidateSeed;
      resolvedSeedEnd = candidate;
      break;
    }
    candidateSeed.terminal.dispose();
  }
}

if (resolvedSeedEnd === null) {
  fail(
    `no seed boundary within ${SEED_SEARCH_RADIUS} chunks of ${seedEnd} reproduces the captured screen. ` +
      'Pick a different --seed-end, ideally just before a full repaint.',
  );
}
if (resolvedSeedEnd !== seedEnd) {
  console.log(`buildTerminalFixture: --seed-end ${seedEnd} does not round-trip; using ${resolvedSeedEnd}`);
}

const streamed = allChunks.slice(resolvedSeedEnd, end + 1);
const baseOffset = streamed.length > 0 ? streamed[0].offsetMs : 0;
const chunks = streamed.map((chunk) => ({ offsetMs: chunk.offsetMs - baseOffset, data: chunk.data }));

console.log(`buildTerminalFixture: seed + chunks reproduces the captured screen (seed-end ${resolvedSeedEnd})`);

if (widening) {
  assertNarrowCells(seed.terminal);
  // A live chunk was recorded for the RECORDED grid: its cursor addressing and
  // its wrapping are wrong inside a wider one. Only cell-free chunks (a mode
  // toggle such as synchronized output) may follow a widened seed.
  for (const [index, chunk] of chunks.entries()) {
    const paints = chunk.data.replace(/\x1b\[\?[0-9;]*[hl]/g, '').length > 0;
    const togglesScreen = [...chunk.data.matchAll(/\x1b\[\?([0-9;]*)[hl]/g)].some((match) =>
      match[1].split(';').some((mode) => !CELL_FREE_PRIVATE_MODES.has(Number(mode))),
    );
    if (paints || togglesScreen) {
      fail(
        `chunk ${index} after the seed paints, moves the cursor or swaps the screen, and was recorded at ${cols} columns. ` +
          'A widened fixture must be seed-only: set --seed-end to the settled frame.',
      );
    }
  }
}
const seedFrame = widening
  ? withRelativeCursor(widenFrame(seed.physicalRows, { cols: gridCols, rows: gridRows }, { cols, rows })) + seed.tail
  : seed.seedFrame;
seed.terminal.dispose();

/** Every cell of a rendered screen: glyph, colours and attributes, comparable as one string. */
async function renderCells(writes, terminalCols, terminalRows) {
  const target = createTerminal(terminalCols, terminalRows);
  for (const write of writes) target.write(write);
  await settle(target);
  const buffer = target.buffer.active;
  const scratchCell = buffer.getNullCell();
  const screen = [];
  for (let row = 0; row < terminalRows; row += 1) {
    const line = buffer.getLine(buffer.baseY + row);
    const cells = [];
    for (let column = 0; column < terminalCols; column += 1) {
      const cell = line?.getCell(column, scratchCell);
      const glyph = cell?.getChars() || ' ';
      const style = cell
        ? [
            cell.getFgColorMode(),
            cell.getFgColor(),
            cell.getBgColorMode(),
            cell.getBgColor(),
            cell.isBold(),
            cell.isDim(),
            cell.isItalic(),
            cell.isUnderline(),
            cell.isInverse(),
            cell.isStrikethrough(),
          ].join(',')
        : '';
      cells.push({ glyph, style });
    }
    screen.push(cells);
  }
  target.dispose();
  return screen;
}

// Widening adds cells and moves nothing - checked, not argued. The baseline is
// the seed at the RECORDED grid, which the round trip above has already proved
// against the raw capture. Inside the recorded width every cell must match it,
// glyph and style, with two exceptions that are the widening itself: a
// right-hand border may leave (it moves out to the new edge), and the blank
// cells AFTER a row's last glyph - the CLI's own right padding - may take the
// fill a band or rule brings through them on its way to the new edge. Past the
// recorded width, only fill may appear.
if (widening) {
  const streamedData = chunks.map((chunk) => chunk.data);
  const recordedScreen = await renderCells([seed.seedFrame, ...streamedData], cols, rows);
  const widenedScreen = await renderCells([seedFrame, ...streamedData], gridCols, gridRows);
  for (let row = 0; row < rows; row += 1) {
    let lastRecordedGlyph = -1;
    for (let column = 0; column < cols; column += 1) {
      const glyph = recordedScreen[row][column].glyph;
      if (glyph !== ' ' && !MOVABLE_EDGE_GLYPHS.includes(glyph)) lastRecordedGlyph = column;
    }
    for (let column = 0; column < gridCols; column += 1) {
      const widenedCell = widenedScreen[row][column];
      if (column < cols) {
        const recordedCell = recordedScreen[row][column];
        // Only the border AFTER the row's last glyph moves out. One before it
        // (a box's left side, a table's column rule) must stay exactly where
        // it was recorded.
        if (column > lastRecordedGlyph && MOVABLE_EDGE_GLYPHS.includes(recordedCell.glyph)) continue;
        // Trailing padding only: a blank between two words that changed would
        // be a background leaking into the text, which is exactly what this
        // check exists to catch, along with text that moved.
        const inTrailingPadding = column > lastRecordedGlyph && recordedCell.glyph === ' ';
        if (inTrailingPadding && WIDENING_FILL_GLYPHS.includes(widenedCell.glyph)) continue;
        if (widenedCell.glyph !== recordedCell.glyph || widenedCell.style !== recordedCell.style) {
          fail(
            `widening changed row ${row}, column ${column} ("${recordedCell.glyph}" -> "${widenedCell.glyph}"). ` +
              'Usually a right-aligned label moved out to the new edge, off every phone screen: pick another frame.',
          );
        }
      } else if (!WIDENING_FILL_GLYPHS.includes(widenedCell.glyph)) {
        fail(`widening put "${widenedCell.glyph}" at row ${row}, column ${column}, past the recorded ${cols} columns`);
      }
    }
  }
  console.log(`buildTerminalFixture: widened ${cols}x${rows} -> ${gridCols}x${gridRows}, recorded cells unchanged`);
}

/** The settled screen as a viewer reads it: one line of text per row. */
async function visibleScreen(terminal) {
  await settle(terminal);
  const buffer = terminal.buffer.active;
  const visible = [];
  for (let lineIndex = buffer.baseY; lineIndex < buffer.baseY + gridRows; lineIndex += 1) {
    const line = buffer.getLine(lineIndex);
    visible.push(line ? line.translateToString(true) : '');
  }
  return visible.join('\n');
}

// Check what the viewer SEES, frame by frame, not just the endpoints. A banner
// carrying the operator's name can be on screen for the opening seconds of the
// window and gone by the last chunk, and a store capture takes its shot
// somewhere in the middle. The seed is a frame of its own, and for a seed-only
// fixture the only one: the raw-byte check alone misses a banned word that
// follows a cursor-forward gap, which rejoins onto its neighbour once the
// sequences are stripped.
assertClean('the raw fixture bytes', seedFrame + chunks.map((chunk) => chunk.data).join(''));
const progressive = createTerminal(gridCols, gridRows);
progressive.write(seedFrame);
assertClean('the seed frame', await visibleScreen(progressive));
for (const [index, chunk] of chunks.entries()) {
  progressive.write(chunk.data);
  assertClean(`the frame after chunk ${index} (${chunk.offsetMs}ms)`, await visibleScreen(progressive));
}
progressive.dispose();
console.log(`buildTerminalFixture: all ${chunks.length + 1} rendered frames are clean`);

const spanMs = chunks.length > 0 ? chunks[chunks.length - 1].offsetMs : 0;
const gridArguments = widening ? ` --grid-cols ${gridCols} --grid-rows ${gridRows}` : '';
const windowArguments = chunks.length === 0 ? '--seed-end <N> --end <N - 1>' : '--seed-end <n> --end <n>';
const provenance = widening
  ? `Recorded at ${cols}x${rows} from a real session against a throwaway
 * storefront fixture repo, then widened to the ${gridCols}x${gridRows} grid the mock
 * announces (scripts/terminalFrame.mjs): rules and diff bands run to the new
 * edge, every recorded cell stays where it was.`
  : `Captured at ${cols}x${rows} from a real session against a throwaway
 * storefront fixture repo.`;
const body = `import type { RecordedTerminalCapture } from './recordedTerminal';

/**
 * RECORDED Claude Code output. Do not hand-edit - regenerate with:
 *   node scripts/buildTerminalFixture.mjs --capture <file> --cols ${cols} --rows ${rows} \\
 *     ${gridArguments.trim() ? `${gridArguments.trim()} ` : ''}${windowArguments} --export ${values.export}
 *
 * ${provenance}
 *
 * The prose is a customer's work rather than this product's. See
 * scripts/captureClaudeFrames.mjs for how, and why the recording environment
 * matters.
 */
export const ${values.export}: RecordedTerminalCapture = {
  cols: ${gridCols},
  rows: ${gridRows},
  seedFrame:
    ${toTypeScriptLiteral(seedFrame)},
  chunks: ${
    chunks.length === 0
      ? '[]'
      : `[\n${chunks.map((chunk) => `    { offsetMs: ${chunk.offsetMs}, data: ${toTypeScriptLiteral(chunk.data)} },`).join('\n')}\n  ]`
  },
};
`;

const outPath = isAbsolute(values.out) ? values.out : resolve(process.cwd(), values.out);
writeFileSync(outPath, body);
console.log(
  `buildTerminalFixture: ${values.export} = seed ${seedFrame.length} chars + ` +
    `${chunks.length} chunks over ${(spanMs / 1000).toFixed(1)}s -> ${outPath}`,
);
