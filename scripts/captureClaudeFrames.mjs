#!/usr/bin/env node
/**
 * DEVELOPER UTILITY - not run in CI, not imported by the app.
 *
 * Records REAL Claude Code TUI output from a real PTY, so the mock desktop's
 * terminal lens can replay bytes an agent actually emitted instead of authored
 * lines that merely describe one. Everything the app spends effort on - the
 * `⏺` tool bullets, the `⎿` result connectors, the bordered input box, the
 * `✻` spinner and its token status line, the permission dialog - only exists
 * in output like this, so a hand-written fixture exercises none of it.
 *
 * Usage (node-pty is deliberately NOT a dependency of this repo - its prebuilds
 * cover win32 and darwin only, so declaring it would make CI's Linux install
 * compile it from source):
 *
 *   npm exec --package=node-pty -- node scripts/captureClaudeFrames.mjs \
 *     --cwd <fixture-repo> --cols 120 --rows 30 --out capture-120.jsonl \
 *     --prompt "Sign-in always lands on the dashboard. Fix the redirect."
 *
 * Or point at an existing install:
 *   KANGENTIC_NODE_PTY=<path-to-node-pty> node scripts/captureClaudeFrames.mjs ...
 *
 * Output is JSONL, one `{ offsetMs, data }` per PTY chunk, where `offsetMs` is
 * milliseconds since the first chunk. The timing matters: Claude Code's cadence
 * is bursty while a turn streams and silent during a tool call, and replaying
 * on a fixed tick is most of what makes a mock terminal read as a script.
 *
 * KEEPING THE PRODUCT'S OWN VOCABULARY OUT OF THE CAPTURE
 *
 * Every fixture here is published to the App Store, to Play, and to a public
 * repo, captioned as a fictional customer's work, so no captured line may name
 * this product's domain (see the customer-fiction block in
 * src/connection/mockDesktop.ts). Three properties of a capture run keep that
 * true by construction rather than by scrubbing afterwards:
 *
 * 1. The fixture repo has no CLAUDE.md, and there is no user-level one.
 * 2. Claude Code's auto-memory is keyed per PROJECT DIRECTORY, so a session in
 *    a fresh fixture repo loads no memory index at all. This is why the script
 *    does not need to clone credentials into an isolated home, which would be
 *    a far worse thing to automate.
 * 3. `--strict-mcp-config` with no `--mcp-config` attaches no MCP servers, so
 *    no tool namespace from another project reaches the session.
 *
 * `--home` still exists for anyone who wants full isolation, but it needs a
 * credential seeded by hand or the run lands on a login screen instead.
 *
 * The backstop is a standing unit test: the committed capture is rendered and
 * scanned for banned vocabulary in tests/unit/mockDesktopFixtures.test.ts.
 * Construction plus a test, not a manual read-through.
 *
 * One more deliberate choice: this does NOT pass --dangerously-skip-permissions.
 * The permission dialog is one of the frames most worth capturing, so the run
 * is expected to stop at one.
 */
import { spawn as spawnProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const require = createRequire(import.meta.url);

/**
 * Chunks arriving within this window of each other are one burst. A burst that
 * ends and is followed by silence this long means the agent is waiting (a tool
 * call, a permission dialog, or the end of the turn).
 */
const DEFAULT_IDLE_MS = 8000;
/** Hard ceiling on one capture, so a wedged session cannot run forever. */
const DEFAULT_MAX_MS = 300_000;
/** Let the TUI paint its first frame before typing anything into it. */
const STARTUP_SETTLE_MS = 6000;
/**
 * Enter must be a SEPARATE write from the bracketed-paste body, and must not
 * land in the same kernel read. Ink routes bracketed content to its paste
 * handler rather than its input handler, and a `\r` in the same read can be
 * serviced against stale state, which shows up as a prompt that never submits.
 * The desktop's paste engine solves this the same way.
 */
const SUBMIT_GAP_MS = 900;
/**
 * Claude Code's approval dialogs all open with a "Do you want to ..." question
 * above a numbered option list. Matched against escape-stripped output, where
 * cursor-addressing has run the words together, hence `\s*` rather than spaces.
 */
const PERMISSION_DIALOG_PATTERN = /Do\s*you\s*want\s*to/i;

function fail(message) {
  console.error(`captureClaudeFrames: ${message}`);
  process.exit(1);
}

/**
 * Flatten escape sequences out of a raw window so it can be pattern-matched.
 * The TUI cursor-addresses between words (`trust\x1b[1Cthis\x1b[1Cfolder`), so
 * the result runs words together - match with `\s*` between them, not ` `.
 */
function stripSequences(raw) {
  return raw
    .replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[@-Z\\-_]/g, '');
}

function loadNodePty() {
  const override = process.env.KANGENTIC_NODE_PTY;
  const candidates = override ? [override, 'node-pty'] : ['node-pty'];
  for (const candidate of candidates) {
    try {
      return require(candidate);
    } catch {
      // Try the next candidate; the aggregate failure is reported below.
    }
  }
  fail(
    'could not load node-pty. Run this through `npm exec --package=node-pty -- node ...`, ' +
      'or set KANGENTIC_NODE_PTY to an existing node-pty install.',
  );
  return null;
}

/** Resolve the `claude` executable without hardcoding anyone's install path. */
function resolveClaudeBinary(explicit) {
  if (explicit) return explicit;
  const lookup = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnProcess(lookup, ['claude'], { encoding: 'utf8', shell: false });
  return new Promise((resolvePromise) => {
    let output = '';
    result.stdout.on('data', (chunk) => {
      output += chunk.toString();
    });
    result.on('close', () => {
      const first = output.split(/\r?\n/).find((line) => line.trim().length > 0);
      resolvePromise(first ? first.trim() : null);
    });
    result.on('error', () => resolvePromise(null));
  });
}

function parseOptions() {
  const { values } = parseArgs({
    options: {
      cwd: { type: 'string' },
      cols: { type: 'string', default: '120' },
      rows: { type: 'string', default: '30' },
      out: { type: 'string' },
      prompt: { type: 'string', multiple: true, default: [] },
      home: { type: 'string' },
      'claude-bin': { type: 'string' },
      'idle-ms': { type: 'string', default: String(DEFAULT_IDLE_MS) },
      'max-ms': { type: 'string', default: String(DEFAULT_MAX_MS) },
      'approve-count': { type: 'string', default: '0' },
      'per-prompt-ms': { type: 'string' },
    },
  });

  const cols = Number.parseInt(values.cols, 10);
  const rows = Number.parseInt(values.rows, 10);
  if (!Number.isInteger(cols) || cols < 20 || cols > 400) fail(`--cols must be 20-400, got "${values.cols}"`);
  if (!Number.isInteger(rows) || rows < 10 || rows > 200) fail(`--rows must be 10-200, got "${values.rows}"`);
  if (!values.cwd) fail('--cwd is required (the fixture repo to run the session against)');
  if (!values.out) fail('--out is required (where to write the JSONL capture)');
  if (values.prompt.length === 0) fail('at least one --prompt is required');

  const workingDirectory = isAbsolute(values.cwd) ? values.cwd : resolve(process.cwd(), values.cwd);
  const outputPath = isAbsolute(values.out) ? values.out : resolve(process.cwd(), values.out);
  const homeDirectory = values.home ? resolve(process.cwd(), values.home) : null;

  return {
    workingDirectory,
    outputPath,
    homeDirectory,
    claudeBinary: values['claude-bin'] ?? null,
    cols,
    rows,
    prompts: values.prompt,
    idleMs: Number.parseInt(values['idle-ms'], 10),
    maxMs: Number.parseInt(values['max-ms'], 10),
    // Per-prompt budget. Without one, `--max-ms` is a single global deadline,
    // so a long first turn consumes it and every later prompt is TYPED and then
    // abandoned in the same instant - the capture ends holding a half-answered
    // session, and the files those prompts would have changed never exist.
    perPromptMs: values['per-prompt-ms'] ? Number.parseInt(values['per-prompt-ms'], 10) : null,
    // `all` approves without limit up to the final prompt. See the loop below:
    // approvals are cut off once the LAST prompt is submitted, so the dialog it
    // raises is left on screen as the capture's closing frame.
    approveCount:
      values['approve-count'] === 'all' ? Number.POSITIVE_INFINITY : Number.parseInt(values['approve-count'], 10),
  };
}

/**
 * The environment the capture runs in.
 *
 * By default this inherits the real environment, because a fresh fixture repo
 * already starts with no memory and no project CLAUDE.md (see the header), and
 * because relocating HOME would require cloning a credential file. Passing
 * `--home` overrides it for anyone who has seeded one by hand.
 */
function captureEnvironment(homeDirectory, cols, rows) {
  const environment = {
    ...process.env,
    ...(homeDirectory
      ? { HOME: homeDirectory, USERPROFILE: homeDirectory, CLAUDE_CONFIG_DIR: join(homeDirectory, '.claude') }
      : {}),
    COLUMNS: String(cols),
    LINES: String(rows),
    TERM: 'xterm-256color',
    // Claude Code dims its own output when it thinks it is piped; force the
    // full-colour TUI so the capture carries real SGR sequences.
    FORCE_COLOR: '3',
  };

  // Capturing is very often done FROM a Claude Code session, and a child
  // inherits markers that change how the capture behaves: the child-session
  // marker turns transcript saving off (so the run leaves no JSONL to build the
  // chat fixture from), and the entrypoint markers change the banner. Strip
  // them so the capture looks like a session started from a plain shell.
  for (const key of Object.keys(environment)) {
    if (key.startsWith('CLAUDE_CODE_') || key === 'CLAUDECODE') delete environment[key];
  }
  if (homeDirectory) environment.CLAUDE_CONFIG_DIR = join(homeDirectory, '.claude');
  return environment;
}

async function main() {
  const options = parseOptions();
  const pty = loadNodePty();
  const claudeBinary = await resolveClaudeBinary(options.claudeBinary);
  if (!claudeBinary) fail('could not find the `claude` executable on PATH (pass --claude-bin)');

  if (options.homeDirectory) mkdirSync(join(options.homeDirectory, '.claude'), { recursive: true });
  mkdirSync(dirname(options.outputPath), { recursive: true });

  console.log(`captureClaudeFrames: ${options.cols}x${options.rows} in ${options.workingDirectory}`);
  console.log(`captureClaudeFrames: home ${options.homeDirectory ?? '(inherited)'}`);

  // --strict-mcp-config with no --mcp-config attaches NO servers at all.
  // --permission-mode default because the permission dialog is one of the
  // frames worth capturing, and an inherited auto-accept mode would skip it.
  const session = pty.spawn(claudeBinary, ['--strict-mcp-config', '--permission-mode', 'default'], {
    name: 'xterm-256color',
    cols: options.cols,
    rows: options.rows,
    cwd: options.workingDirectory,
    env: captureEnvironment(options.homeDirectory, options.cols, options.rows),
  });

  /** @type {{ offsetMs: number, data: string }[]} */
  const chunks = [];
  let firstChunkAt = null;
  let lastChunkAt = Date.now();
  let exited = false;
  let recentOutput = '';

  session.onData((data) => {
    const now = Date.now();
    if (firstChunkAt === null) firstChunkAt = now;
    lastChunkAt = now;
    chunks.push({ offsetMs: now - firstChunkAt, data });
    // Keep a small rolling window for the interstitial checks below. Escape
    // sequences split words across chunks, so a window beats a per-chunk test.
    recentOutput = (recentOutput + data).slice(-8000);
  });
  session.onExit(() => {
    exited = true;
  });

  const startedAt = Date.now();
  const sleep = (ms) => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

  let approvalsLeft = options.approveCount;

  /**
   * Resolve once output has been quiet for `idleMs`, or the run hits its
   * ceiling. A permission dialog also reads as idle (the agent is waiting on a
   * human), so this is where approvals are answered: approve while the budget
   * lasts, and once it runs out leave the dialog on screen. That last unanswered
   * dialog is deliberately the final frame - it is the one the chat lens shows
   * as a permission card at the same moment.
   */
  async function waitForIdle(label, deadlineAt) {
    while (!exited) {
      if (Date.now() - startedAt > options.maxMs) {
        console.log(`captureClaudeFrames: hit --max-ms while waiting for ${label}`);
        return;
      }
      if (deadlineAt !== undefined && Date.now() > deadlineAt) {
        console.log(`captureClaudeFrames: hit --per-prompt-ms while waiting for ${label}`);
        return;
      }
      if (Date.now() - lastChunkAt >= options.idleMs) {
        if (approvalsLeft > 0 && PERMISSION_DIALOG_PATTERN.test(stripSequences(recentOutput))) {
          approvalsLeft -= 1;
          const remaining = Number.isFinite(approvalsLeft) ? `${approvalsLeft} left` : 'unlimited';
          console.log(`captureClaudeFrames: approving a permission dialog (${remaining})`);
          session.write('1');
          await sleep(400);
          session.write('\r');
          await sleep(1500);
          continue;
        }
        return;
      }
      await sleep(250);
    }
  }

  await sleep(STARTUP_SETTLE_MS);
  await waitForIdle('the first frame');

  // A first run in an unseen directory opens on the trust prompt, which eats
  // whatever is typed next. Answering it here rather than letting the first
  // --prompt collide with it is the difference between a real session and a
  // capture of an accepted dialog and nothing else.
  if (!exited && /trust\s*this\s*folder/i.test(stripSequences(recentOutput))) {
    console.log('captureClaudeFrames: answering the workspace trust prompt');
    session.write('\r');
    await sleep(1500);
    await waitForIdle('the session to open');
  }

  for (const [index, prompt] of options.prompts.entries()) {
    if (exited) break;
    console.log(`captureClaudeFrames: prompt ${index + 1}/${options.prompts.length}`);
    // Whatever the final prompt asks for is left UNAPPROVED on purpose: the
    // capture should close on a live permission dialog, because that is the
    // moment the chat lens renders a permission card for the same tool call.
    if (index === options.prompts.length - 1) approvalsLeft = 0;
    session.write(`\x1b[200~${prompt}\x1b[201~`);
    await sleep(SUBMIT_GAP_MS);
    session.write('\r');
    await sleep(1000);
    await waitForIdle(
      `prompt ${index + 1} to settle`,
      options.perPromptMs === null ? undefined : Date.now() + options.perPromptMs,
    );
  }

  if (!exited) session.kill();

  const lines = chunks.map((chunk) => JSON.stringify(chunk)).join('\n');
  writeFileSync(options.outputPath, lines.length > 0 ? `${lines}\n` : '');
  const totalBytes = chunks.reduce((sum, chunk) => sum + chunk.data.length, 0);
  const spanMs = chunks.length > 0 ? chunks[chunks.length - 1].offsetMs : 0;
  console.log(
    `captureClaudeFrames: wrote ${chunks.length} chunks (${totalBytes} chars over ${(spanMs / 1000).toFixed(1)}s) ` +
      `to ${options.outputPath}`,
  );
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
