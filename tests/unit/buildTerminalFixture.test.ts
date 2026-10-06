/**
 * Covers the build-time guards in scripts/buildTerminalFixture.mjs, which turns a
 * recorded terminal capture into the committed store-screenshot fixture.
 *
 * The script is a top-level program, not a module, so it is RUN: spawned against
 * tiny synthetic captures, asserting its exit code, what it says, and whether it
 * wrote a file. What each group pins:
 *
 * - The seed-only rule for a widened fixture (later chunks were recorded for a
 *   narrower grid), the wide-glyph refusal, and the seed frame's own vocabulary
 *   check (the raw-bytes check rejoins a word onto its neighbour across a
 *   cursor-forward gap and misses it). With any of these guards removed the
 *   script exits 0 and writes the fixture, so these tests are the only defence.
 * - The widening check (every recorded cell survives, only fill is added past the
 *   recorded width). A moved right-aligned label is also caught by the fill check
 *   past the recorded width, so that test pins WHICH guard fires first and the
 *   exact cell it reports, not that something fires.
 * - The two argument checks pin the readable early message. Without them
 *   widenFrame still throws and the script still exits 1, with a raw stack trace.
 *
 * The script's default output is the COMMITTED fixture, so runBuilder always passes
 * an explicit --out into a temporary directory: no case here can overwrite it.
 *
 * The synthetic text is deliberately plain. The script bans a vocabulary (the
 * product's own terms, and words that admit the content is not real) and
 * personal markers, so a fixture line that strays into either fails for the wrong
 * reason.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const BUILDER_SCRIPT = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'scripts', 'buildTerminalFixture.mjs');

/** Spawning node and loading the headless terminal is well under a second; this is headroom for a loaded CI runner. */
const SPAWN_TIMEOUT_MS = 60_000;

const RECORDED_COLUMNS = 40;
const RECORDED_ROWS = 6;
const WIDENED_COLUMNS = 60;

/** Enters the alternate screen and homes the cursor, as a full-screen TUI does. */
const ALT_SCREEN_PREFIX = '\x1b[?1049h\x1b[H';
/**
 * A frame with the shapes widening has to handle: a rule to the edge, prose, and
 * a background band erased to the edge. Nothing in it sits at the right edge that
 * widening would move, so it widens cleanly.
 */
const CLEAN_FRAME =
  ALT_SCREEN_PREFIX +
  '─'.repeat(RECORDED_COLUMNS) +
  '\r\n' +
  'Fix the redirect' +
  '\r\n' +
  '\x1b[48;5;22m + const next = 1;\x1b[K\x1b[0m';
const CURSOR_ON_SECOND_ROW = '\x1b[2;5H';

const temporaryRoots: string[] = [];

afterEach(() => {
  while (temporaryRoots.length > 0) {
    const directory = temporaryRoots.pop();
    if (directory) rmSync(directory, { recursive: true, force: true });
  }
});

interface BuilderRun {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Where the fixture module would have been written, and whether anything was. */
  readonly outPath: string;
  readonly wroteOutput: boolean;
  /** The module the script wrote, or null when it wrote none. */
  readonly output: string | null;
}

/**
 * Writes `chunks` as a capture (one JSON object per line, as the recorder does) and
 * runs the builder over it with the given extra arguments.
 */
function runBuilder(chunks: readonly string[], extraArguments: readonly string[]): BuilderRun {
  const directory = mkdtempSync(join(tmpdir(), 'kangentic-fixture-'));
  temporaryRoots.push(directory);
  const capturePath = join(directory, 'capture.jsonl');
  const outPath = join(directory, 'claudeCapture.ts');
  writeFileSync(
    capturePath,
    chunks.map((data, chunkIndex) => JSON.stringify({ offsetMs: chunkIndex * 100, data })).join('\n') + '\n',
  );
  const result = spawnSync(
    process.execPath,
    [
      BUILDER_SCRIPT,
      '--capture',
      capturePath,
      '--cols',
      String(RECORDED_COLUMNS),
      '--rows',
      String(RECORDED_ROWS),
      '--export',
      'TEST_CAPTURE',
      '--out',
      outPath,
      ...extraArguments,
    ],
    { encoding: 'utf8', timeout: SPAWN_TIMEOUT_MS },
  );
  const wroteOutput = existsSync(outPath);
  return {
    status: result.status ?? -1,
    stdout: result.stdout,
    stderr: result.stderr,
    outPath,
    wroteOutput,
    output: wroteOutput ? readFileSync(outPath, 'utf8') : null,
  };
}

/** The widening flags for the standard case: 40x6 recorded, announced 60x6. */
const WIDEN_TO_SIXTY = ['--grid-cols', String(WIDENED_COLUMNS), '--grid-rows', String(RECORDED_ROWS)];
/** A seed-only window over a capture of `chunkCount` chunks: everything is the seed, nothing streams. */
function seedOnly(chunkCount: number): string[] {
  return ['--seed-end', String(chunkCount), '--end', String(chunkCount - 1)];
}

describe('buildTerminalFixture arguments', () => {
  it('refuses a grid with a different row count, because a frame is widened and never made taller', () => {
    const run = runBuilder([CLEAN_FRAME + CURSOR_ON_SECOND_ROW], [...seedOnly(1), '--grid-cols', '60', '--grid-rows', '7']);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`--grid-rows 7 must equal --rows ${RECORDED_ROWS}`);
    expect(run.wroteOutput).toBe(false);
  });

  it('refuses a narrower grid, because a frame is widened and never cut', () => {
    const run = runBuilder([CLEAN_FRAME + CURSOR_ON_SECOND_ROW], [...seedOnly(1), '--grid-cols', '30', '--grid-rows', String(RECORDED_ROWS)]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain(`--grid-cols 30 is narrower than --cols ${RECORDED_COLUMNS}`);
    expect(run.wroteOutput).toBe(false);
  });
});

describe('buildTerminalFixture widening', () => {
  it('writes the announced grid and a seed-only fixture for a frame that widens cleanly', () => {
    const run = runBuilder([CLEAN_FRAME + CURSOR_ON_SECOND_ROW], [...seedOnly(1), ...WIDEN_TO_SIXTY]);
    // The status first, with the script's own words beside it, so a failure names the guard that fired.
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    expect(run.stdout).toContain(`widened ${RECORDED_COLUMNS}x${RECORDED_ROWS} -> ${WIDENED_COLUMNS}x${RECORDED_ROWS}, recorded cells unchanged`);
    // The module announces the WIDENED grid (what the mock reports), not the recorded one.
    expect(run.output).toContain(`cols: ${WIDENED_COLUMNS},`);
    expect(run.output).toContain(`rows: ${RECORDED_ROWS},`);
    expect(run.output).toContain('chunks: [],');
    // And says how to regenerate it, with the grid flags that make it a widened fixture.
    expect(run.output).toContain(`--grid-cols ${WIDENED_COLUMNS} --grid-rows ${RECORDED_ROWS}`);
  });

  it('announces the recorded grid, with no grid flags in its header, when it is not asked to widen', () => {
    const run = runBuilder([CLEAN_FRAME + CURSOR_ON_SECOND_ROW], seedOnly(1));
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    expect(run.output).toContain(`cols: ${RECORDED_COLUMNS},`);
    expect(run.output).not.toContain('--grid-cols');
    expect(run.stdout).not.toContain('widened');
  });

  it('refuses a frame whose right-aligned label widening would move out, rather than ship the moved label', () => {
    // 'tag' sits two cells inside the recorded edge (columns 35-37) after a long gap, which is what
    // a right-aligned label looks like. Widening carries it out to column 57, so the cells it
    // occupied inside the recorded width change: the check exists to catch exactly this, since the
    // moved label is past every phone screen and no capture would show it gone.
    const labelRow = '\r\nready\x1b[36Gtag';
    const run = runBuilder([CLEAN_FRAME + labelRow + CURSOR_ON_SECOND_ROW], [...seedOnly(1), ...WIDEN_TO_SIXTY]);
    expect(run.status).toBe(1);
    // The row and column are the ones the label left: row 3 (the fourth), column 35 (the 't').
    expect(run.stderr).toMatch(/widening changed row 3, column 35 \("t" -> " "\)/);
    expect(run.wroteOutput).toBe(false);
  });

  it('refuses a frame with a wide glyph, which the code-point cell count cannot place exactly', () => {
    const wideRow = '\r\na中b';
    const run = runBuilder([CLEAN_FRAME + wideRow + CURSOR_ON_SECOND_ROW], [...seedOnly(1), ...WIDEN_TO_SIXTY]);
    expect(run.status).toBe(1);
    expect(run.stderr).toMatch(/row 3, column 1 holds "中" \(width 2\)/);
    expect(run.wroteOutput).toBe(false);
  });
});

describe('buildTerminalFixture chunks after a widened seed', () => {
  // A chunk recorded at 40 columns addresses and wraps for 40 columns, so after a widened seed
  // only a chunk that paints nothing may follow. Both captures below are two chunks: the frame,
  // then the chunk under test, streamed after a seed of the first.
  const streamedAfterSeed = ['--seed-end', '1', '--end', '1'];

  it.each([
    { label: 'paints a cell', chunk: '\x1b[4;1Hz' },
    { label: 'swaps the screen back to the normal buffer', chunk: '\x1b[?1049l' },
  ])('refuses a chunk that $label', ({ chunk }) => {
    const run = runBuilder([CLEAN_FRAME + CURSOR_ON_SECOND_ROW, chunk], [...streamedAfterSeed, ...WIDEN_TO_SIXTY]);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('chunk 0 after the seed paints, moves the cursor or swaps the screen');
    expect(run.stderr).toContain('A widened fixture must be seed-only');
    expect(run.wroteOutput).toBe(false);
  });

  it('keeps a chunk that only toggles a mode that paints nothing', () => {
    // The control for the two refusals above: the guard looks at what the chunk does, so a
    // synchronized-output toggle, which Claude Code wraps every repaint in, is let through.
    const run = runBuilder([CLEAN_FRAME + CURSOR_ON_SECOND_ROW, '\x1b[?2026h'], [...streamedAfterSeed, ...WIDEN_TO_SIXTY]);
    expect({ status: run.status, stderr: run.stderr }).toEqual({ status: 0, stderr: '' });
    expect(run.output).not.toContain('chunks: [],');
    expect(run.output).toContain('offsetMs: 0');
  });
});

describe('buildTerminalFixture vocabulary check', () => {
  it('reads the seed frame as a viewer sees it, so a banned word after a cursor-forward gap is caught', () => {
    // The capture leaves one unwritten cell between 'my' and 'relay', which the seed frame writes
    // as a cursor-forward. The raw-bytes check strips that sequence to nothing and sees 'myrelay',
    // which is not the banned word; only the rendered screen reads 'my relay'.
    const run = runBuilder([`${ALT_SCREEN_PREFIX}my\x1b[Crelay\x1b[1;1H`], seedOnly(1));
    expect(run.status).toBe(1);
    expect(run.stderr).toContain('the seed frame contains relay');
    expect(run.wroteOutput).toBe(false);
  });
});
