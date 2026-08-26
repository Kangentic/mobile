#!/usr/bin/env node
/**
 * DEVELOPER UTILITY - not run in CI.
 *
 * Turns a raw PTY capture from `scripts/captureClaudeFrames.mjs` into the
 * committed fixture module the mock desktop replays.
 *
 *   node scripts/buildTerminalFixture.mjs \
 *     --capture capture-44x38.jsonl --cols 44 --rows 38 \
 *     --seed-end 2500 --end 2677 --export CLAUDE_CAPTURE_SHOTS
 *
 * The grid in that example is the one actually committed. Copy-pasting an
 * older one regenerates the fixture at a grid the app does not report, which
 * renders as borders sliced mid-glyph and is caught only by a human looking at
 * a store image.
 *
 * WHY A SEED FRAME AND NOT JUST THE CHUNKS
 *
 * Claude Code repaints incrementally with cursor addressing, so there is no
 * mid-session boundary where the byte stream alone reconstructs the screen -
 * a capture sliced anywhere but chunk 0 renders into a fresh terminal as
 * fragments. So the slice before `--seed-end` is replayed into a headless
 * xterm and SERIALIZED into one self-contained frame, and only chunks after it
 * stream. That is precisely how the desktop seeds a real phone
 * (`HeadlessFrameBuffer.serialize()` in the desktop's pty/buffer module), so
 * the fixture's seed is built the same way the real one is, including the
 * alt-screen and mode preamble the serializer emits.
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

const require = createRequire(import.meta.url);
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

/**
 * Scrollback the PARSER retains. Matches the desktop's own
 * SERIALIZED_SCROLLBACK_LINES so the fixture cannot be shaped by a limit the
 * real path does not have.
 */
const SERIALIZED_SCROLLBACK_LINES = 500;

/**
 * Scrollback written into the SEED, which is deliberately zero.
 *
 * Claude Code runs full-screen in the alt buffer, which has no scrollback of
 * its own, so everything the session ever shows is in the visible grid. What
 * `serialize()` would add above it is the NORMAL buffer: the shell output from
 * before the TUI took over, which on this machine is the startup banner
 * carrying the operator's name, org email and home directory. That is not part
 * of the agent session, and seeding it would ship identity that never appears
 * on screen but is one scroll-up away on the phone.
 */
const SEED_SCROLLBACK_LINES = 0;

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

const capturePath = isAbsolute(values.capture) ? values.capture : resolve(process.cwd(), values.capture);
// Hyperlink targets are rewritten at LOAD, so the seed, the streamed chunks and
// the expected-grid comparison all run on identical bytes.
const allChunks = readFileSync(capturePath, 'utf8')
  .trim()
  .split('\n')
  .filter((line) => line.length > 0)
  .map((line) => JSON.parse(line))
  .map((chunk) => ({ offsetMs: chunk.offsetMs, data: rewriteHyperlinkTargets(chunk.data) }));

const seedEnd = Number.parseInt(values['seed-end'] ?? String(Math.floor(allChunks.length * 0.9)), 10);
const end = Number.parseInt(values.end ?? String(allChunks.length - 1), 10);
if (!(seedEnd > 0 && seedEnd <= end && end < allChunks.length)) {
  fail(`--seed-end/--end out of range for ${allChunks.length} chunks`);
}

/** Serialize the grid as it stands after replaying `[0, candidateEnd)`. */
async function buildSeedFrame(candidateEnd) {
  const terminal = new Terminal({ cols, rows, scrollback: SERIALIZED_SCROLLBACK_LINES, allowProposedApi: true });
  const serializer = new SerializeAddon();
  terminal.loadAddon(serializer);
  for (let index = 0; index < candidateEnd; index += 1) terminal.write(allChunks[index].data);
  // xterm parses writes on a macrotask, so serializing without this barrier
  // snapshots a stale grid. A zero-length write's callback fires only once
  // every queued chunk ahead of it has been parsed.
  await new Promise((resolveFlush) => terminal.write('', resolveFlush));
  // Otherwise emitted exactly as the serializer produces it, so the fixture's
  // seed is the same kind of artifact a real desktop sends. (It already
  // restores the cursor via trailing relative moves, which matters because
  // Claude Code's next repaint resumes with RELATIVE cursor moves.)
  const frame = serializer.serialize({ scrollback: SEED_SCROLLBACK_LINES });

  // Keep only the alt-screen half. The serializer emits the NORMAL buffer
  // first, then `ESC[?1049h`, then the alt frame - and for a full-screen TUI
  // the normal buffer holds the shell output from before the TUI started,
  // which here is the startup banner with the operator's home directory. It is
  // not part of the session and must not ship. Slicing at the switch is safe
  // because entering the alt screen clears it, so everything after that marker
  // reconstructs the grid on its own.
  const altScreenStart = frame.indexOf('\x1b[?1049h');
  return altScreenStart === -1 ? frame : frame.slice(altScreenStart);
}

/** Render a byte stream at the capture grid and read the visible cells back as text. */
async function renderToText(writes) {
  const target = new Terminal({ cols, rows, scrollback: SERIALIZED_SCROLLBACK_LINES, allowProposedApi: true });
  for (const write of writes) target.write(write);
  await new Promise((resolveFlush) => target.write('', resolveFlush));
  const buffer = target.buffer.active;
  const lines = [];
  for (let y = buffer.baseY; y < buffer.baseY + rows; y += 1) {
    const line = buffer.getLine(y);
    lines.push(line ? line.translateToString(true) : '');
  }
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
let seedFrame = null;
let resolvedSeedEnd = null;
for (let offset = 0; offset <= SEED_SEARCH_RADIUS && resolvedSeedEnd === null; offset += 1) {
  for (const candidate of offset === 0 ? [seedEnd] : [seedEnd - offset, seedEnd + offset]) {
    if (candidate < 1 || candidate > end) continue;
    const candidateSeed = await buildSeedFrame(candidate);
    const replayed = await renderToText([candidateSeed, ...allChunks.slice(candidate, end + 1).map((c) => c.data)]);
    if (replayed === expectedGrid) {
      seedFrame = candidateSeed;
      resolvedSeedEnd = candidate;
      break;
    }
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

// Check what the viewer SEES, frame by frame, not just the endpoints. A banner
// carrying the operator's name can be on screen for the opening seconds of the
// window and gone by the last chunk, and a store capture takes its shot
// somewhere in the middle.
assertClean('the raw fixture bytes', seedFrame + chunks.map((chunk) => chunk.data).join(''));
const progressive = new Terminal({ cols, rows, scrollback: SERIALIZED_SCROLLBACK_LINES, allowProposedApi: true });
progressive.write(seedFrame);
for (const [index, chunk] of chunks.entries()) {
  progressive.write(chunk.data);
  await new Promise((resolveFlush) => progressive.write('', resolveFlush));
  const buffer = progressive.buffer.active;
  const visible = [];
  for (let y = buffer.baseY; y < buffer.baseY + rows; y += 1) {
    const line = buffer.getLine(y);
    visible.push(line ? line.translateToString(true) : '');
  }
  assertClean(`the frame after chunk ${index} (${chunk.offsetMs}ms)`, visible.join('\n'));
}
console.log(`buildTerminalFixture: all ${chunks.length + 1} rendered frames are clean`);

const spanMs = chunks.length > 0 ? chunks[chunks.length - 1].offsetMs : 0;
const body = `import type { RecordedTerminalCapture } from './recordedTerminal';

/**
 * RECORDED Claude Code output. Do not hand-edit - regenerate with:
 *   node scripts/buildTerminalFixture.mjs --capture <file> --cols ${cols} --rows ${rows} \\
 *     --seed-end <n> --end <n> --export ${values.export}
 *
 * Captured at ${cols}x${rows} from a real session against a throwaway
 * storefront fixture repo, so the prose is a customer's work rather than this
 * product's. See scripts/captureClaudeFrames.mjs for how, and why the
 * recording environment matters.
 */
export const ${values.export}: RecordedTerminalCapture = {
  cols: ${cols},
  rows: ${rows},
  seedFrame:
    ${toTypeScriptLiteral(seedFrame)},
  chunks: [
${chunks.map((chunk) => `    { offsetMs: ${chunk.offsetMs}, data: ${toTypeScriptLiteral(chunk.data)} },`).join('\n')}
  ],
};
`;

const outPath = isAbsolute(values.out) ? values.out : resolve(process.cwd(), values.out);
writeFileSync(outPath, body);
console.log(
  `buildTerminalFixture: ${values.export} = seed ${seedFrame.length} chars + ` +
    `${chunks.length} chunks over ${(spanMs / 1000).toFixed(1)}s -> ${outPath}`,
);
