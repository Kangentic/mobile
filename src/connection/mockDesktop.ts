import {
  generateX25519KeyPair,
  parseCapabilityRequestPayload,
  type BoardTaskWire,
  type BridgeEvent,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type DiffFileContentWire,
  type DiffFileListWire,
  type JsonValue,
  type ReadBoardView,
  type ReadStreamResponsePayload,
  type SessionUsageWire,
  type TranscriptWindowResponsePayload,
  type Transport,
  type TranscriptEntryWire,
  type X25519KeyPair,
} from '@kangentic/protocol';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

/**
 * The dev-only in-app fake desktop: the real channel stack (KK handshake,
 * secretstream, capability envelopes, feed router) runs against this peer
 * over an in-process loopback transport, so every screen behaves exactly as
 * it does against a real desktop - streaming transcript, terminal ticks,
 * prompt cards, board writes - with no relay, no pairing, and no dependence
 * on (or pollution of) a live board. Enabled only by the dev rig's mock
 * mode (EXPO_PUBLIC_KANGENTIC_MOCK=1, dev builds only); production bundles
 * never take this path.
 *
 * The scenario mirrors scripts/stubDesktopPeer.mjs's agent-life simulator
 * and adds an AskUserQuestion round after the permission prompt is
 * answered. Data shapes come from @/devsupport/desktopFixtures so the two
 * stay aligned.
 */

export function isMockDesktopEnabled(): boolean {
  return __DEV__ && process.env.EXPO_PUBLIC_KANGENTIC_MOCK === '1';
}

export interface MockDesktop {
  identity: X25519KeyPair;
  desktopStaticPublicKey: Uint8Array;
  phoneTransport: Transport;
  /** Call after the phone controller's connect(): brings the desktop end up and initiates the KK handshake (the desktop always initiates). */
  start(): Promise<void>;
  dispose(): void;
}

// `color` exercises the project accent theme (the whole app's active accent
// derives from it while browsing that project) - two distinct hues so
// switching projects visibly re-themes rather than coincidentally matching.
/** Fallback page size when an archived read names no limit; matches actions.ts's ARCHIVED_PAGE_SIZE. */
const ARCHIVED_MOCK_PAGE_SIZE = 25;
// Names are product-plausible rather than "Project 1"/"Project 2" because the
// project pill renders on every TaskCard, and these fixtures are the source
// for the store-listing screenshots (scripts/storeScreenshots.mjs).
const MOCK_PROJECT = { id: 'mock-project', name: 'storefront-web', color: '#58a6ff' };
/** A second project: exercises the board project switcher and cross-project Home rows. */
const MOCK_PROJECT_2 = { id: 'mock-project-relay', name: 'platform-relay', color: '#3fb950' };
const MOCK_SESSION_ID = 'mock-session-1';
const MOCK_TASK_ID = 'mock-task-1';
/** A second, TRANSCRIPT-LESS session (agent: codex): exercises the chat reading-view fallback. */
const MOCK_CODEX_SESSION_ID = 'mock-session-codex';
const MOCK_CODEX_TASK_ID = 'mock-task-codex';
/** An IDLE session in the second project: exercises the Home feed's Idle section. */
const MOCK_IDLE_SESSION_ID = 'mock-session-idle';
const MOCK_IDLE_TASK_ID = 'mock-task-idle';
/**
 * A "paused" session sitting in Executing: the protocol has no paused
 * ActivityStateWire (only 'thinking' | 'idle' | 'permission' - see
 * .claude/rules/protocol-types-from-package.md, no local stand-in types),
 * so this reports 'idle' - the closest real state - and communicates
 * "paused" only through its snippet text, for display/testing purposes.
 */
const MOCK_PAUSED_SESSION_ID = 'mock-session-paused';
const MOCK_PAUSED_TASK_ID = 'mock-task-paused';
const PERMISSION_TOOL_ID = 'mock-tool-2';
const QUESTION_TOOL_ID = 'mock-tool-3';
const PERMISSION_PROMPT_ID = `${MOCK_SESSION_ID}:${PERMISSION_TOOL_ID}`;
const QUESTION_PROMPT_ID = `${MOCK_SESSION_ID}:${QUESTION_TOOL_ID}`;
/** The mock desktop pane's grid; a fit-mode resize overrides it until release-size restores it. */
const MOCK_DESKTOP_PTY_DIMENSIONS = { cols: 120, rows: 30 };
const MOCK_CONTEXT_WINDOW_SIZE = 200_000;
// Model variety across the mock's sessions - both the Agents feed and the
// board read the SAME activityStore usage data per session, so varying it
// here is automatically consistent across both screens (one source of
// truth, no separate wiring needed).
const MOCK_MODEL_SONNET = { id: 'claude-sonnet-5', displayName: 'Sonnet 5' };
const MOCK_MODEL_OPUS = { id: 'claude-opus-4-8', displayName: 'Opus 4.8' };
const MOCK_MODEL_FABLE = { id: 'claude-fable-5', displayName: 'Fable 5' };
/** Matches the codex session's `agent: 'codex'` - an OpenAI Codex-family model, not a Claude one. */
const MOCK_MODEL_CODEX = { id: 'gpt-5-codex', displayName: 'GPT-5 Codex' };
/** After this many tick-driven Bash cells, the mock stops growing the transcript further - see tickEntryCount. */
const MOCK_MAX_TICK_ENTRIES = 20;

/**
 * Where the streaming session's context bar starts, and how fast it climbs.
 *
 * The rate is deliberately gentle and the ceiling deliberately below the point
 * where the bar turns red. At the original 900 tokens per tick the bar hit 100%
 * after about three minutes, and the capture flow takes longer than that - so
 * the board and feed screenshots, taken last, showed a maxed-out context window
 * in alarm red. That is a real product state and worth keeping reachable, but it
 * is not what a store listing should assert about the app.
 *
 * The bar still visibly advances during a session, which is the demo value.
 */
const MOCK_STREAM_TOKENS_AT_START = 42_000;
const MOCK_STREAM_TOKENS_PER_TICK = 300;
/** 60% of the 200k window: comfortably clear of the warning and danger thresholds. */
const MOCK_STREAM_TOKEN_CEILING = 120_000;

function streamingUsedTokens(tick: number): number {
  return Math.min(
    MOCK_STREAM_TOKENS_AT_START + tick * MOCK_STREAM_TOKENS_PER_TICK,
    MOCK_STREAM_TOKEN_CEILING,
  );
}

/** A plausible, growing usage snapshot - the mock's stand-in for the desktop's real per-turn token accounting. */
function mockUsage(usedTokens: number, model: SessionUsageWire['model']): SessionUsageWire {
  const clampedUsedTokens = Math.min(usedTokens, MOCK_CONTEXT_WINDOW_SIZE);
  return {
    contextWindow: {
      usedPercentage: (clampedUsedTokens / MOCK_CONTEXT_WINDOW_SIZE) * 100,
      usedTokens: clampedUsedTokens,
      cacheTokens: Math.round(clampedUsedTokens * 0.3),
      totalInputTokens: clampedUsedTokens,
      totalOutputTokens: Math.round(clampedUsedTokens * 0.08),
      contextWindowSize: MOCK_CONTEXT_WINDOW_SIZE,
    },
    cost: {
      totalCostUsd: clampedUsedTokens * 0.000003,
      totalDurationMs: clampedUsedTokens * 8,
    },
    model,
  };
}

interface MockExtraThinkingSessionSpec {
  sessionId: string;
  taskId: string;
  displayId: number;
  swimlaneId: string;
  title: string;
  userText: string;
  assistantText: string;
  scrollback: string;
  model: SessionUsageWire['model'];
  usedTokens: number;
}

/**
 * Extra static "thinking" sessions (no ticker, nothing ever streams from
 * them) - purely to give the Agents feed's Thinking section enough volume
 * to feel real scrolling and justify a collapsible-section UI, for
 * display/testing purposes.
 */
const MOCK_EXTRA_THINKING_SESSIONS: MockExtraThinkingSessionSpec[] = [
  {
    sessionId: 'mock-session-thinking-2',
    taskId: 'mock-task-thinking-2',
    displayId: 6,
    swimlaneId: 'lane-executing',
    title: "Refactor the diff viewer's syntax highlighter for large files",
    userText: 'The diff view chokes on files over 2000 lines - can you speed up the highlighter?',
    // Deliberately long - a design-review stress test for how the Agents
    // feed's snippet line truncates once the last message runs well past
    // its two-line cap (bodyNumberOfLines on TaskCard).
    assistantText:
      'Swapped the line-by-line tokenizer for a streaming one that processes files in fixed-size chunks instead of loading everything into memory at once; benchmarking against the 10k-line fixture next to confirm the P95 render time actually drops below our 200ms target.',
    scrollback: '$ claude\r\n> Refactoring src/diff/syntaxHighlight.ts...\r\n',
    model: MOCK_MODEL_SONNET,
    usedTokens: 55_000,
  },
  {
    sessionId: 'mock-session-thinking-3',
    taskId: 'mock-task-thinking-3',
    displayId: 7,
    swimlaneId: 'lane-code-review',
    title: 'Investigate the flaky Maestro pairing flow on CI',
    userText: 'paired/pairing-ceremony.yaml fails about 1 in 5 runs on CI - can you dig in?',
    assistantText: 'Reproduced it locally - the QR-scan step races the relay handshake. Adding a settle wait before the scan.',
    scrollback: '$ claude\r\n> Reproducing the flaky pairing-ceremony flow...\r\n',
    model: MOCK_MODEL_OPUS,
    usedTokens: 88_000,
  },
  {
    sessionId: 'mock-session-thinking-4',
    taskId: 'mock-task-thinking-4',
    displayId: 8,
    swimlaneId: 'lane-testing',
    title: 'Write the relay self-host deployment guide',
    userText: 'Draft a guide for someone standing up their own relay - Docker, env vars, the works.',
    assistantText: 'First draft covers Docker Compose and bare-metal; adding the reverse-proxy/TLS section now.',
    scrollback: '$ claude\r\n> Drafting docs/self-host-relay.md...\r\n',
    model: MOCK_MODEL_FABLE,
    usedTokens: 33_000,
  },
  {
    sessionId: 'mock-session-thinking-5',
    taskId: 'mock-task-thinking-5',
    displayId: 9,
    swimlaneId: 'lane-executing',
    title: 'Tune the terminal font-fit heuristic for tablet-sized screens',
    userText: 'On a tablet the terminal font ends up tiny - can you adjust the fit heuristic?',
    assistantText: 'Adding a width-aware floor so the font never drops below 10px regardless of the PTY grid width.',
    scrollback: 'Codex CLI · tuning the font-fit heuristic...\r\n',
    model: MOCK_MODEL_CODEX,
    usedTokens: 12_000,
  },
];

function extraThinkingSnapshot(spec: MockExtraThinkingSessionSpec): ReadStreamResponsePayload {
  return {
    scrollback: spec.scrollback,
    activity: { state: 'thinking', reason: { kind: 'turn-active' } },
    usage: mockUsage(spec.usedTokens, spec.model),
    awaitedPromptId: null,
    ptyDimensions: { ...MOCK_DESKTOP_PTY_DIMENSIONS },
  };
}

function extraThinkingTranscript(spec: MockExtraThinkingSessionSpec): TranscriptEntryWire[] {
  return [
    { kind: 'user', uuid: `${spec.sessionId}-user-1`, ts: Date.now() - 600_000, text: spec.userText },
    {
      kind: 'assistant',
      uuid: `${spec.sessionId}-assistant-1`,
      ts: Date.now() - 540_000,
      agentName: spec.model === MOCK_MODEL_CODEX ? 'Codex' : 'Claude Code',
      model: spec.model.displayName,
      blocks: [{ type: 'text', text: spec.assistantText }],
    },
  ];
}

/**
 * The live PTY tail for the streaming session, cycled one line per tick.
 *
 * A rotating script rather than `tick N: ...` because this feed IS the
 * Terminal lens, which is the most distinctive screenshot in the store
 * listing: a counter on every visible line reads as a test fixture, and the
 * cleaned reading-view fallback derives from these same bytes.
 */
/**
 * A FINITE script, played once in order, then silence.
 *
 * Finite rather than looping because a loop repeats "Reading src/auth/login.ts"
 * a minute in, and a reader who takes the terminal seriously - which is the
 * whole point of the lens - sees an agent going in circles. It ends on the
 * approval request, so the terminal agrees with the permission card the chat
 * lens is showing at the same moment.
 *
 * Each line is kept under ~44 columns. The mirror renders at the desktop's
 * reported PTY width, and anything longer clips at the right edge of a portrait
 * phone, which reads as a broken terminal rather than a wide one.
 */
const MOCK_TERMINAL_LINES = [
  '> Reading src/auth/login.ts',
  '  loginRedirect() drops its path argument',
  '> Searching for callers of loginRedirect',
  '  4 call sites, every one passing a path',
  '> Editing src/auth/login.ts',
  '  1 edit applied (+8 -2)',
  '$ npm run typecheck',
  '  tsc --noEmit: no errors',
  '> Writing tests/auth-redirect.test.ts',
  '  1 file added (+31)',
  '$ npx vitest run tests/unit',
  '  Test Files  38 passed (38)',
  '       Tests  305 passed (305)',
  '    Duration  2.72s',
  '> Sign-in keeps the requested path now.',
  '  Component tests need your approval.',
];

/**
 * How much of the script is already in the scrollback when the terminal opens.
 *
 * A real session has history; more practically, at one line per second an
 * empty-then-filling terminal is only a full screen after a quarter of a
 * minute, and a capture taken before then shows three lines adrift in black.
 * Seeding most of the script makes the lens look like a session in progress the
 * instant it mounts, and leaves the last few lines to stream in live.
 */
const MOCK_TERMINAL_SEEDED_LINES = 12;

/** The scrollback a subscriber receives: a shell header plus the played-so-far script. */
function mockTerminalScrollback(): string {
  const header = ['storefront-web on fix/sign-in-return-path', '$ claude'];
  return [...header, ...MOCK_TERMINAL_LINES.slice(0, MOCK_TERMINAL_SEEDED_LINES)].join('\r\n') + '\r\n';
}

/** The real Claude Code permission-dialog trio, as the desktop's PTY probe would publish it. */
const MOCK_PERMISSION_OPTIONS = [
  'Yes',
  "Yes, and don't ask again for this command",
  'No, and tell Claude what to do differently',
];

function initialTasks(): BoardTaskWire[] {
  const nowIso = new Date().toISOString();
  return [
    boardTaskFixture({
      id: MOCK_TASK_ID,
      display_id: 1,
      // The streaming session: this is the task every session-lens screenshot
      // is taken against, so its title, diff, terminal and prompt card all
      // describe the SAME piece of work.
      title: 'Fix the sign-in redirect dropping the return path',
      // Deliberately long - a design-review stress test for how the body
      // text truncates against the ticket number, project pill, and PR pill
      // sharing its rows.
      description:
        'Signing in always lands on the dashboard instead of the page that was requested, because the redirect helper throws the original path away. Restore it as a next parameter and add a regression test that covers the query-string round trip.',
      swimlane_id: 'lane-executing',
      // Executing scales light -> heavy: Codex refactor (lightest, position
      // 0) first, this one (medium) second, the "full card" (position 2)
      // last.
      position: 1,
      session_id: MOCK_SESSION_ID,
      branch_name: 'fix/sign-in-return-path',
      labels: ['auth', 'wave-4'],
      pr_number: 42,
      pr_state: 'open',
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: 'mock-task-2',
      display_id: 2,
      // Dev affordance: this is the card to long-press when trying the move
      // sheet by hand. Kept as a comment rather than as the card's body text,
      // which ships in the store screenshots.
      title: 'Rate-limit the password reset endpoint',
      description: 'Attempts are unbounded today. Cap them per address and per account before the next security review.',
      swimlane_id: 'lane-todo',
      labels: ['chore'],
      attachment_count: 2,
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: MOCK_CODEX_TASK_ID,
      display_id: 3,
      // Agent 'codex' and no structured transcript: this is the card that
      // exercises the chat reading-view fallback.
      title: 'Extract the retry policy out of the HTTP client',
      description: 'Backoff and retry are tangled into the request path. Pull them into a policy object that can be tested on its own.',
      swimlane_id: 'lane-executing',
      position: 0,
      agent: 'codex',
      session_id: MOCK_CODEX_SESSION_ID,
      branch_name: 'feature/codex-refactor',
      // No labels on this one - exercises the PR pill with nothing else in
      // the meta row (design-review demo: does the pill still read fine
      // alone, not just alongside label tags).
      pr_number: 17,
      pr_state: 'open',
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: MOCK_PAUSED_TASK_ID,
      display_id: 5,
      // The "full card": every element the card supports, at once - long
      // title AND long description (both truncate), a PR (in a state we
      // haven't shown elsewhere - 'merged', not 'open'), more labels than
      // the 3-visible cap (exercises the "+N" overflow pill), attachments,
      // and a priority (inert on the card today, ready for the future
      // detail-view addition). The single comprehensive stress-test card.
      title: 'Migrate the legacy push-notification registration pipeline to the new capability-scoped token flow',
      description:
        'Replaces the old device-token registration path with the new register-push capability grant, keeping backward compatibility for phones still running the previous protocol version while the rollout completes across both platforms.',
      swimlane_id: 'lane-executing',
      position: 2,
      // A session, not a bodiless board card: Executing implies an agent is
      // always either running or paused there. Fable 5 - a 4th distinct
      // model, rounding out Sonnet/Opus/Codex already in use.
      agent: 'claude',
      session_id: MOCK_PAUSED_SESSION_ID,
      branch_name: 'feature/push-token-migration',
      labels: ['backend', 'notifications', 'migration', 'breaking-change', 'p0'],
      pr_number: 103,
      pr_state: 'merged',
      attachment_count: 3,
      priority: 2,
      created_at: nowIso,
      updated_at: nowIso,
    }),
    // Volume for the Thinking section - see MOCK_EXTRA_THINKING_SESSIONS.
    ...MOCK_EXTRA_THINKING_SESSIONS.map((spec) =>
      boardTaskFixture({
        id: spec.taskId,
        display_id: spec.displayId,
        title: spec.title,
        description: spec.assistantText,
        swimlane_id: spec.swimlaneId,
        agent: spec.model === MOCK_MODEL_CODEX ? 'codex' : 'claude',
        session_id: spec.sessionId,
        created_at: nowIso,
        updated_at: nowIso,
      }),
    ),
  ];
}

/**
 * A codex-style fullscreen TUI frame: cursor-home + full rewrite each
 * paint. Chrome mirrors the REAL Codex CLI: a working spinner line and
 * the `Codex CLI · model · effort · token` context bar (format recorded
 * from a live session; the bar is the frame's last readable line, so it
 * is what the Agents feed's terminal-line snippet surfaces).
 */
function codexTuiFrame(paintTick: number): string {
  const spinnerGlyphs = ['|', '/', '-', '\\'];
  const spinner = spinnerGlyphs[paintTick % spinnerGlyphs.length];
  // Names the file this session's task actually claims to be changing: the
  // bar is the frame's last readable line, so it becomes the card snippet.
  const statusLine = paintTick % 2 === 0 ? 'Refactoring src/http/retryPolicy.ts' : 'Running the affected tests';
  const upTokens = (8.2 + paintTick * 0.1).toFixed(1);
  return (
    '\x1b[H\x1b[2J' +
    `${spinner} Working (${paintTick}s · esc to interrupt)\r\n` +
    '╭──────────────────────────────────────╮\r\n' +
    `│ ${statusLine} │\r\n` +
    '╰──────────────────────────────────────╯\r\n' +
    `Codex CLI · GPT-5 Codex · high · ↑${upTokens}k ↓${420 + paintTick}\r\n`
  );
}

// Mirrors the real Kangentic default board so mock mode exercises the
// chip bar and sectioned scroll at true column scale.
function mockColumns() {
  return [
    // 'To Do' and 'Done' leave `icon` null to exercise the role-default
    // fallback (layers / circle-check-big); the rest carry explicit
    // desktop-picked icons, mirroring a real project's board.
    boardColumnFixture({ id: 'lane-todo', name: 'To Do', role: 'todo', position: 0, color: '#8b949e' }),
    boardColumnFixture({ id: 'lane-planning', name: 'Planning', role: null, position: 1, color: '#8957e5', icon: 'notebook-pen' }),
    boardColumnFixture({ id: 'lane-executing', name: 'Executing', role: null, position: 2, color: '#58a6ff', icon: 'square-code' }),
    boardColumnFixture({ id: 'lane-code-review', name: 'Code Review', role: null, position: 3, color: '#d29922', icon: 'git-pull-request' }),
    boardColumnFixture({ id: 'lane-testing', name: 'Testing', role: null, position: 4, color: '#39c5cf', icon: 'flask-conical' }),
    boardColumnFixture({ id: 'lane-merge', name: 'Merge', role: null, position: 5, color: '#f0883e', icon: 'git-merge' }),
    boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 6, color: '#3fb950' }),
  ];
}

function mockColumns2() {
  return [
    boardColumnFixture({ id: 'lane2-backlog', name: 'Backlog', role: 'todo', position: 0, color: '#58a6ff' }),
    boardColumnFixture({ id: 'lane2-progress', name: 'In Progress', role: null, position: 1, color: '#d29922' }),
    boardColumnFixture({ id: 'lane2-shipped', name: 'Shipped', role: 'done', position: 2, color: '#3fb950' }),
  ];
}

function initialTasks2(): BoardTaskWire[] {
  const nowIso = new Date().toISOString();
  return [
    boardTaskFixture({
      id: MOCK_IDLE_TASK_ID,
      display_id: 1,
      // An idle agent session: exercises the Home feed's Idle section.
      title: 'Relay load-test follow-ups',
      description: 'Latency held under a millisecond across fifty pairs. Write up the headroom numbers and open issues for the two slowest cases.',
      swimlane_id: 'lane2-progress',
      session_id: MOCK_IDLE_SESSION_ID,
      branch_name: 'perf/load-test',
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: 'mock-task-relay-2',
      display_id: 2,
      // A quiet, session-less second-project card.
      title: 'Document the metrics endpoint',
      description: 'Describe every counter the relay exposes, and which ones are safe to scrape from outside the cluster.',
      swimlane_id: 'lane2-backlog',
      created_at: nowIso,
      updated_at: nowIso,
    }),
  ];
}

/**
 * SHAPED from a real Claude Code session's transcript (the App Phase 1
 * overnight run) so mock parity matches genuine session shapes: an Edit with
 * multi-line old/new strings, real command outputs, and real assistant prose
 * lengths. Machine paths are sanitized to C:\Users\dev per the
 * no-personal-info rule.
 *
 * The PROSE is authored, not recorded. It was rewritten off the original
 * CLAUDE.md/EAS-profiles turn so that it describes the same sign-in redirect
 * fix as this session's diff, terminal feed, labels and prompt card - the
 * session-lens screenshots all carry the task title in a shared header, so a
 * transcript about different work would contradict its own header inside a
 * single frame. The recorded command outputs (typecheck, vitest) are real and
 * unchanged.
 */
function baseTranscript(): TranscriptEntryWire[] {
  const now = Date.now();
  return [
    {
      kind: 'user',
      uuid: 'mock-user-1',
      ts: now - 300000,
      text: 'Signing in always lands on the dashboard instead of the page I asked for. Fix the redirect and verify the suites still pass.',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-1',
      ts: now - 280000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      blocks: [
        {
          type: 'text',
          text: 'Found it: `loginRedirect` takes the requested path and then throws it away, so every sign-in ends up at the default route. Threading it through as a **next** parameter.',
        },
        {
          // old_string/new_string are the SAME edit the Changes lens shows for
          // src/auth/login.ts (diffFileContent below), so the chat and diff
          // screenshots describe one piece of work rather than two.
          type: 'tool_use',
          id: 'mock-tool-1',
          name: 'Edit',
          input: {
            replace_all: false,
            file_path: 'C:\\Users\\dev\\Documents\\GitHub\\storefront-web\\src\\auth\\login.ts',
            old_string: 'export function loginRedirect(path) {\n  redirect("/login");\n}',
            new_string:
              'export function loginRedirect(path) {\n  const next = encodeURIComponent(path);\n  redirect(`/login?next=${next}`);\n}',
          },
        },
      ],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-1',
      ts: now - 270000,
      toolUseId: 'mock-tool-1',
      content:
        'The file C:\\Users\\dev\\Documents\\GitHub\\storefront-web\\src\\auth\\login.ts has been updated successfully.',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-2',
      ts: now - 260000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      blocks: [{ type: 'tool_use', id: 'mock-tool-tc', name: 'Bash', input: { command: 'npm run typecheck' } }],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-tc',
      ts: now - 250000,
      toolUseId: 'mock-tool-tc',
      content: '> storefront-web@2.4.0 typecheck\n> tsc --noEmit',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-3',
      ts: now - 240000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      blocks: [{ type: 'tool_use', id: 'mock-tool-vt', name: 'Bash', input: { command: 'npx vitest run tests/unit' } }],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-vt',
      ts: now - 230000,
      toolUseId: 'mock-tool-vt',
      content: ' Test Files  38 passed (38)\n      Tests  305 passed (305)\n   Duration  2.72s',
    },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-4',
      ts: now - 220000,
      agentName: 'Claude Code',
      model: MOCK_MODEL_SONNET.displayName,
      blocks: [
        {
          type: 'text',
          text: 'Typecheck and the unit suite are green, and the redirect now carries the requested path through sign-in. Running the component tier next needs your approval.',
        },
      ],
    },
  ];
}

/**
 * A change set with enough files to look like real work.
 *
 * Two files left most of the Changes lens empty, which sells "review your
 * agent's diff from your phone" poorly. A sign-in redirect fix genuinely
 * touches the helper, its callers, a test and the changelog, so the extra
 * entries are more honest than the original pair, not less.
 */
function diffFileList(): DiffFileListWire {
  return {
    files: [
      { path: 'src/auth/login.ts', status: 'M', insertions: 12, deletions: 2, binary: false },
      { path: 'src/auth/session.ts', status: 'M', insertions: 4, deletions: 1, binary: false },
      { path: 'src/components/SignInForm.tsx', status: 'M', insertions: 6, deletions: 3, binary: false },
      { path: 'src/routes/checkout.tsx', status: 'M', insertions: 2, deletions: 2, binary: false },
      { path: 'tests/auth-redirect.test.ts', status: 'A', insertions: 31, deletions: 0, binary: false },
      { path: 'CHANGELOG.md', status: 'M', insertions: 3, deletions: 0, binary: false },
    ],
    totalInsertions: 58,
    totalDeletions: 8,
  };
}

function diffFileContent(filePath: string): DiffFileContentWire {
  if (filePath === 'src/auth/login.ts') {
    // The first row in the Changes list, so this is the diff the file-diff
    // screenshot shows. Long enough to fill a phone screen with real added and
    // removed lines - a three-line change rendered as a mostly-empty frame and
    // sold the review story badly - and every line is kept under ~46 columns so
    // nothing needs horizontal scrolling to read.
    return {
      original: [
        'import { redirect } from "../router";',
        '',
        'export function loginRedirect(path) {',
        '  redirect("/login");',
        '  return null;',
        '}',
        '',
        'export function isProtected(path) {',
        '  return path.startsWith("/account");',
        '}',
        '',
      ].join('\n'),
      modified: [
        'import { redirect } from "../router";',
        '',
        'const DEFAULT_LANDING = "/dashboard";',
        '',
        'export function loginRedirect(path) {',
        '  const next = encodeURIComponent(path);',
        '  redirect(`/login?next=${next}`);',
        '}',
        '',
        'export function resolveNext(raw) {',
        '  if (!raw) return DEFAULT_LANDING;',
        '  const next = decodeURIComponent(raw);',
        '  if (next.startsWith("/")) return next;',
        '  return DEFAULT_LANDING;',
        '}',
        '',
        'export function isProtected(path) {',
        '  return path.startsWith("/account");',
        '}',
        '',
      ].join('\n'),
      language: 'typescript',
    };
  }
  if (filePath === 'src/auth/session.ts') {
    return {
      original: 'export function afterSignIn() {\n  return "/dashboard";\n}\n',
      modified: 'export function afterSignIn(next) {\n  return next ?? "/dashboard";\n}\n',
      language: 'typescript',
    };
  }
  if (filePath === 'src/components/SignInForm.tsx') {
    return {
      original: 'const onSubmit = async () => {\n  await signIn(email, password);\n  navigate(afterSignIn());\n};\n',
      modified:
        'const onSubmit = async () => {\n  await signIn(email, password);\n  const next = params.get("next");\n  navigate(afterSignIn(next));\n};\n',
      language: 'typescript',
    };
  }
  if (filePath === 'src/routes/checkout.tsx') {
    return {
      original: 'if (!user) {\n  return loginRedirect();\n}\n',
      modified: 'if (!user) {\n  return loginRedirect(location.pathname);\n}\n',
      language: 'typescript',
    };
  }
  if (filePath === 'CHANGELOG.md') {
    return {
      original: '# Changelog\n\n## Unreleased\n',
      modified:
        '# Changelog\n\n## Unreleased\n\n- Sign-in now returns you to the page you asked for\n  instead of always landing on the dashboard.\n',
      language: 'markdown',
    };
  }
  return {
    original: '',
    modified: 'test("redirect keeps next", () => {\n  expect(loginRedirect("/boards")).toContain("next=");\n});\n',
    language: 'typescript',
  };
}

export function createMockDesktop(): MockDesktop {
  const [phoneTransport, desktopTransport] = createLoopbackPair();
  const identity = generateX25519KeyPair();
  const desktopStatic = generateX25519KeyPair();
  const peer = new StubSessionInitiator(desktopTransport, {
    desktopStatic,
    phoneStaticPublicKey: identity.publicKey,
  });

  // Mutable scenario state, reset whenever the connection reopens (the
  // module is re-instantiated per openConnection).
  const tasks = initialTasks();
  const tasks2 = initialTasks2();
  let transcript = baseTranscript();
  let transcriptRevision = 1;
  /**
   * Whether ANY read-stream subscription is attached. Gates the whole
   * simulated agent: usage growth, transcript entries, the permission prompt.
   *
   * Deliberately NOT the same thing as terminalWanted. The feed subscribes
   * list-only (`terminal: false`), and that is the normal state whenever no
   * session screen is open - so conflating the two left the mock agent inert
   * on the Home feed, which is the screen the mock mostly exists to preview.
   */
  let streamSubscribed = false;
  /** Whether the subscriber asked for live PTY bytes. Gates ONLY terminal emission. */
  let terminalWanted = false;
  let feedTick = 0;
  /**
   * Advances only when a PTY line is actually emitted, NOT with feedTick.
   *
   * Keyed to the global tick, the script started wherever the ticker happened
   * to be when the terminal lens was first opened - so a session opened from
   * the Agents feed began mid-narrative, printing "Writing the test" and
   * "Reading login.ts" AFTER the test run that depends on them. Anyone who
   * reads the frame sees a session that makes no sense, which is worse than a
   * counter.
   */
  let terminalLineIndex = MOCK_TERMINAL_SEEDED_LINES;
  let pendingPromptId: string | null = null;
  let questionRaised = false;
  let entryCounter = 0;
  // Caps the tick-driven Bash cells specifically (below) - separate from
  // entryCounter, which also numbers user-sent messages and created tasks
  // and must keep incrementing for uuid uniqueness regardless of this cap.
  // Without a cap the mock streamed a new cell every 12 ticks forever, so a
  // long-running mock session (e.g. left open through an hours-long design
  // review) grew the transcript - and the Chat lens's rendering work -
  // without bound.
  let tickEntryCount = 0;
  // A tick Bash cell completes with its matching tool_result a few ticks
  // later, mirroring the real bridge (an agent's tool call always ends in a
  // result). Without it every tick cell stayed pending forever, stacking
  // identical "running Bash" cards in the chat lens.
  let pendingTickResult: { toolUseId: string; content: string; dueTick: number } | null = null;
  let feedTimer: ReturnType<typeof setInterval> | null = null;
  let ptyDimensions = { ...MOCK_DESKTOP_PTY_DIMENSIONS };
  const oneShotTimers = new Set<ReturnType<typeof setTimeout>>();
  // Session-lifecycle simulation (the /respawn and /end-session magic
  // composer commands): the streaming task's CURRENT session id, mirroring
  // the desktop respawning a task's agent under a fresh id.
  let activeSessionId: string | null = MOCK_SESSION_ID;
  let respawnCounter = 1;
  let codexStreamSubscribed = false;

  function emit(event: BridgeEvent): void {
    if (!peer.isEstablished) return;
    peer.emitEvent(event);
  }

  function emitPtyResize(): void {
    if (activeSessionId === null) return;
    emit({ kind: 'terminal-resize', sessionId: activeSessionId, taskId: MOCK_TASK_ID, payload: { ...ptyDimensions } });
  }

  function later(delayMs: number, action: () => void): void {
    const timer = setTimeout(() => {
      oneShotTimers.delete(timer);
      action();
    }, delayMs);
    oneShotTimers.add(timer);
  }

  /** Appends an entry and streams it as a protocol-v2 indexed delta, exactly like the real bridge. */
  function appendTranscriptEntry(entry: TranscriptEntryWire): void {
    if (activeSessionId === null) return;
    transcript.push(entry);
    transcriptRevision += 1;
    emit({
      kind: 'transcript',
      sessionId: activeSessionId,
      taskId: MOCK_TASK_ID,
      payload: {
        mode: 'delta',
        revision: transcriptRevision,
        totalEntries: transcript.length,
        upserts: [{ index: transcript.length - 1, entry }],
      },
    });
  }

  function emitActivity(state: 'thinking' | 'idle' | 'permission'): void {
    if (activeSessionId === null) return;
    const reason = state === 'permission' ? { kind: 'permission' as const } : state === 'idle' ? { kind: 'idle' as const } : { kind: 'turn-active' as const };
    emit({ kind: 'activity', sessionId: activeSessionId, taskId: MOCK_TASK_ID, payload: { type: 'activity', state, reason } });
  }

  /** Grows with feedTick so the board card's context bar visibly advances during a mock session, like a real one. */
  function emitUsage(): void {
    if (activeSessionId === null) return;
    emit({
      kind: 'activity',
      sessionId: activeSessionId,
      taskId: MOCK_TASK_ID,
      payload: { type: 'usage', usage: mockUsage(streamingUsedTokens(feedTick), MOCK_MODEL_SONNET) },
    });
  }

  function raisePrompt(promptId: string): void {
    if (activeSessionId === null) return;
    pendingPromptId = promptId;
    emit({
      kind: 'activity',
      sessionId: activeSessionId,
      taskId: MOCK_TASK_ID,
      payload: {
        type: 'permission',
        promptId,
        pending: true,
        // The empirical Claude Code permission trio, as the desktop's PTY
        // probe publishes it (protocol 0.6.0): the question prompt keeps
        // its own AskUserQuestion options and gets none here.
        ...(promptId === PERMISSION_PROMPT_ID ? { options: MOCK_PERMISSION_OPTIONS } : {}),
      },
    });
    emitActivity('permission');
  }

  function clearPrompt(promptId: string): void {
    pendingPromptId = null;
    later(50, () => {
      if (activeSessionId === null) return;
      emit({ kind: 'activity', sessionId: activeSessionId, taskId: MOCK_TASK_ID, payload: { type: 'permission', promptId, pending: false } });
      emitActivity('thinking');
    });
  }

  /** Points the streaming task at a session id (or none) and pushes the board change, like the real desktop's lifecycle feed. */
  function setTaskSession(nextSessionId: string | null): void {
    const streamingTask = tasks.find((candidate) => candidate.id === MOCK_TASK_ID);
    if (streamingTask) {
      streamingTask.session_id = nextSessionId;
      streamingTask.updated_at = new Date().toISOString();
    }
    later(50, () => {
      emit({ kind: 'board', projectId: MOCK_PROJECT.id, taskId: MOCK_TASK_ID, payload: { change: 'task-updated', ids: [MOCK_TASK_ID] } });
    });
  }

  /**
   * The /end-session magic command: the desktop stops running a session for
   * the task. Subsequent read-stream subscribes for the dead id fail exactly
   * like the real bridge once the registry entry is gone.
   */
  function endActiveSession(): void {
    pendingPromptId = null;
    pendingTickResult = null;
    const endedSessionId = activeSessionId;
    // The real desktop pushes session-ended immediately before it tears the
    // read-stream subscription down, and since the 0.9.0 board projection that
    // event is the ONLY signal the phone gets: this mock's own boardSnapshot()
    // applies the same `view: 'sessions'` filter, so the ended task leaves the
    // board entirely rather than surviving with a null session_id. Without
    // this the session screen could never reach its ended state under
    // dev:mock, and the input bar stayed live for a task the board had
    // already dropped.
    if (endedSessionId !== null) {
      emit({
        kind: 'activity',
        sessionId: endedSessionId,
        taskId: MOCK_TASK_ID,
        payload: { type: 'session-ended', intentional: true },
      });
    }
    activeSessionId = null;
    streamSubscribed = false;
    terminalWanted = false;
    setTaskSession(null);
  }

  /**
   * The /respawn magic command: the desktop restarts the task's agent under
   * a FRESH session id (a model switch). The transcript resets (a new
   * process has a new transcript) with a marker entry Maestro can assert on.
   */
  function respawnActiveSession(): void {
    respawnCounter += 1;
    const successorSessionId = `mock-session-${respawnCounter}`;
    pendingPromptId = null;
    pendingTickResult = null;
    activeSessionId = successorSessionId;
    streamSubscribed = false;
    terminalWanted = false;
    transcript = [
      {
        kind: 'assistant',
        uuid: `mock-respawn-marker-${respawnCounter}`,
        ts: Date.now(),
        blocks: [{ type: 'text', text: `Respawned session online (${successorSessionId}).` }],
      },
    ];
    transcriptRevision = 1;
    setTaskSession(successorSessionId);
  }

  function raiseQuestionPrompt(): void {
    questionRaised = true;
    appendTranscriptEntry({
      kind: 'assistant',
      uuid: 'mock-assistant-question',
      ts: Date.now(),
      blocks: [
        { type: 'text', text: 'The fix works. One decision before I write the regression test:' },
        {
          type: 'tool_use',
          id: QUESTION_TOOL_ID,
          name: 'AskUserQuestion',
          input: {
            // Shape mirrored from a REAL Claude Code AskUserQuestion tool_use
            // (session 3f4dd05b, "Auto-approve kill"): questions[] of
            // {question, header, multiSelect, options[{label, description,
            // preview?}]}. Four options exercises the digit-select ceiling;
            // the TUI adds its own implicit fifth "type your own answer".
            questions: [
              {
                question: 'Where should the redirect regression test live?',
                header: 'Test tier',
                multiSelect: false,
                options: [
                  {
                    label: 'Unit (vitest) (recommended)',
                    description: 'Fast, pure redirect-builder coverage; no RN runtime.',
                    preview: 'tests/unit/loginRedirect.test.ts\nexpect(buildRedirect(path)).toContain("next=")',
                  },
                  { label: 'Component (RTL)', description: 'Covers the login form wiring too.' },
                  {
                    label: 'Both tiers',
                    description: 'Unit for the builder plus a component test for the form wiring.',
                  },
                  { label: 'E2E only', description: 'One Maestro flow through the real login screen.' },
                ],
              },
            ],
          },
        },
      ],
    });
    raisePrompt(QUESTION_PROMPT_ID);
  }

  // The agent-life simulator: terminal chunks stream every second; every 12
  // ticks the transcript grows; at tick 20 a permission prompt raises; 10
  // ticks after it is answered, an AskUserQuestion card raises.
  function startFeed(): void {
    if (feedTimer) return;
    feedTimer = setInterval(() => {
      if (!peer.isEstablished) return;
      feedTick += 1;
      // The codex session repaints its fullscreen TUI every other tick - the
      // reading-view fallback's demo source.
      if (codexStreamSubscribed && feedTick % 2 === 0) {
        emit({
          kind: 'terminal',
          sessionId: MOCK_CODEX_SESSION_ID,
          taskId: MOCK_CODEX_TASK_ID,
          payload: { data: codexTuiFrame(feedTick / 2) },
        });
      }
      if (!streamSubscribed || activeSessionId === null) return;
      // PTY bytes are the only thing the terminal flag gates. Everything
      // below - usage, transcript growth, the permission prompt - is what a
      // list-only subscriber came for, and gating it on the terminal froze
      // the whole simulated agent whenever no session screen was open.
      if (terminalWanted && terminalLineIndex < MOCK_TERMINAL_LINES.length) {
        emit({
          kind: 'terminal',
          sessionId: activeSessionId,
          taskId: MOCK_TASK_ID,
          payload: { data: `${MOCK_TERMINAL_LINES[terminalLineIndex]}\r\n` },
        });
        terminalLineIndex += 1;
      }
      if (feedTick % 5 === 0) {
        // Grows the board card's context bar over the session, like a real
        // one - not tied to any other cadence, just a steady drip.
        emitUsage();
      }
      if (
        feedTick === 30 &&
        ptyDimensions.cols === MOCK_DESKTOP_PTY_DIMENSIONS.cols &&
        ptyDimensions.rows === MOCK_DESKTOP_PTY_DIMENSIONS.rows
      ) {
        // Parity with scripts/stubDesktopPeer.mjs: simulate the desktop user
        // drag-resizing their pane, so mock mode exercises the phone's
        // read-only adopt-resize path (it never sends a resize back) the
        // same way the CLI stub does.
        ptyDimensions = { cols: 100, rows: 28 };
        emitPtyResize();
      }
      if (pendingTickResult !== null && feedTick >= pendingTickResult.dueTick) {
        appendTranscriptEntry({
          kind: 'tool_result',
          uuid: `${pendingTickResult.toolUseId}-result`,
          ts: Date.now(),
          toolUseId: pendingTickResult.toolUseId,
          content: pendingTickResult.content,
        });
        pendingTickResult = null;
      }
      if (feedTick % 12 === 0 && pendingPromptId === null && tickEntryCount < MOCK_MAX_TICK_ENTRIES) {
        tickEntryCount += 1;
        entryCounter += 1;
        // Varied realistic commands (real sessions never repeat one Bash
        // cell verbatim), mirroring the repo's actual verification loop.
        const tickInvocations = [
          { command: 'npm run typecheck', result: '> storefront-web@2.4.0 typecheck\n> tsc --noEmit' },
          { command: 'npm run lint', result: '> storefront-web@2.4.0 lint\n> eslint . --max-warnings 0' },
          {
            command: 'npx vitest run tests/unit',
            result: ' Test Files  38 passed (38)\n      Tests  305 passed (305)\n   Duration  2.72s',
          },
        ];
        const invocation = tickInvocations[entryCounter % tickInvocations.length];
        const toolUseId = `mock-tool-tick-${entryCounter}`;
        appendTranscriptEntry({
          kind: 'assistant',
          uuid: `mock-assistant-tick-${entryCounter}`,
          ts: Date.now(),
          agentName: 'Claude Code',
          model: MOCK_MODEL_SONNET.displayName,
          blocks: [
            {
              type: 'tool_use',
              id: toolUseId,
              name: 'Bash',
              input: { command: invocation.command },
            },
          ],
        });
        pendingTickResult = { toolUseId, content: invocation.result, dueTick: feedTick + 3 };
      }
      if (feedTick === 20 && pendingPromptId === null && !questionRaised) {
        appendTranscriptEntry({
          kind: 'assistant',
          uuid: 'mock-assistant-permission',
          ts: Date.now(),
          agentName: 'Claude Code',
          model: MOCK_MODEL_SONNET.displayName,
          blocks: [{ type: 'tool_use', id: PERMISSION_TOOL_ID, name: 'Bash', input: { command: 'npx jest tests/components' } }],
        });
        raisePrompt(PERMISSION_PROMPT_ID);
      }
    }, 1000);
  }

  function ok(request: CapabilityRequestMessage, payload?: JsonValue): CapabilityResponseMessage {
    return { type: 'capability-response', requestId: request.requestId, ok: true, ...(payload === undefined ? {} : { payload }) };
  }

  function failWith(request: CapabilityRequestMessage, error: string): CapabilityResponseMessage {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error };
  }

  /**
   * Mirrors the desktop handler: a request that names a `view` gets no
   * backlog, 'sessions' gets only the session-bearing tasks plus whole-column
   * counts, and a request that names none gets the pre-0.9.0 payload.
   */
  function boardSnapshot(projectId: string, view: ReadBoardView | undefined): JsonValue {
    const isSecondProject = projectId === MOCK_PROJECT_2.id;
    const allTasks = isSecondProject ? [...tasks2] : [...tasks];
    const taskCountsByColumnId: Record<string, number> = {};
    for (const task of allTasks) {
      if (task.archived_at !== null) continue;
      taskCountsByColumnId[task.swimlane_id] = (taskCountsByColumnId[task.swimlane_id] ?? 0) + 1;
    }
    return {
      projectId: isSecondProject ? MOCK_PROJECT_2.id : MOCK_PROJECT.id,
      columns: isSecondProject ? mockColumns2() : mockColumns(),
      tasks: view === 'sessions' ? allTasks.filter((task) => task.session_id !== null) : allTasks,
      ...(view === undefined ? { backlog: [] } : {}),
      projectColor: isSecondProject ? MOCK_PROJECT_2.color : MOCK_PROJECT.color,
      // Exercises the desktop's "hide ticket numbers" layout setting - the
      // first project leaves it at the true default, the second turns it off.
      showTicketNumbers: !isSecondProject,
      ...(view !== undefined ? { view } : {}),
      ...(view === 'sessions' ? { taskCountsByColumnId } : {}),
    } as unknown as JsonValue;
  }

  /**
   * The Done column's rows, which live in neither board projection and so have
   * to be paged by their own `archived` action. Without this the mock answers
   * an archived read with an ordinary snapshot, verbClient rejects it as the
   * wrong shape, and mock mode shows a permanently empty Done column and an
   * unreachable completed-task screen.
   */
  function archivedPage(projectId: string, limit: number | undefined, offset: number | undefined): JsonValue {
    const isSecondProject = projectId === MOCK_PROJECT_2.id;
    const doneColumnId = isSecondProject ? 'lane2-shipped' : 'lane-done';
    const archivedTasks = [
      boardTaskFixture({
        id: `${projectId}-archived-1`,
        display_id: 901,
        title: 'Shipped: the completed mock task',
        swimlane_id: doneColumnId,
        session_id: `${projectId}-archived-session-1`,
        archived_at: '2026-07-20T18:30:00.000Z',
      }),
      boardTaskFixture({
        id: `${projectId}-archived-2`,
        display_id: 902,
        title: 'Closed without an agent',
        swimlane_id: doneColumnId,
        position: 1,
        session_id: null,
        archived_at: '2026-07-19T09:15:00.000Z',
      }),
    ];
    const pageOffset = offset ?? 0;
    const pageLimit = limit ?? ARCHIVED_MOCK_PAGE_SIZE;
    return {
      projectId,
      archivedTasks: archivedTasks.slice(pageOffset, pageOffset + pageLimit),
      archivedTotalCount: archivedTasks.length,
      // Only the session-bearing task carries a summary, so the screen's
      // no-summary branch stays reachable in mock mode too.
      summariesByTaskId: {
        [`${projectId}-archived-1`]: {
          sessionId: `${projectId}-archived-session-1`,
          totalCostUsd: 1.2345,
          totalInputTokens: 120_000,
          totalOutputTokens: 8_400,
          modelDisplayName: 'Sonnet 5',
          durationMs: 3_720_000,
          toolCallCount: 42,
          compactionCount: 1,
          linesAdded: 210,
          linesRemoved: 18,
          filesChanged: 7,
          taskCreatedAt: '2026-07-19T12:00:00.000Z',
          startedAt: '2026-07-20T17:00:00.000Z',
          exitedAt: '2026-07-20T18:02:00.000Z',
          exitCode: 0,
        },
      },
    } as unknown as JsonValue;
  }

  /** Board write verbs address tasks by id only; resolve which project owns one. */
  function locateTask(taskId: string | undefined): { task: BoardTaskWire; taskList: BoardTaskWire[]; projectId: string } | null {
    const inFirst = tasks.find((candidate) => candidate.id === taskId);
    if (inFirst) return { task: inFirst, taskList: tasks, projectId: MOCK_PROJECT.id };
    const inSecond = tasks2.find((candidate) => candidate.id === taskId);
    if (inSecond) return { task: inSecond, taskList: tasks2, projectId: MOCK_PROJECT_2.id };
    return null;
  }

  peer.setRequestHandler((request) => {
    switch (request.verb) {
      case 'read-board': {
        const payload = parseCapabilityRequestPayload('read-board', request.payload);
        if (!payload.projectId) return ok(request, { projects: [MOCK_PROJECT, MOCK_PROJECT_2] });
        if (payload.action === 'unsubscribe') return ok(request);
        if (payload.action === 'archived') return ok(request, archivedPage(payload.projectId, payload.limit, payload.offset));
        return ok(request, boardSnapshot(payload.projectId, payload.view));
      }
      case 'read-stream': {
        const payload = parseCapabilityRequestPayload('read-stream', request.payload);
        if (payload.action === 'unsubscribe') {
          if (payload.sessionId === MOCK_CODEX_SESSION_ID) codexStreamSubscribed = false;
          else if (
            payload.sessionId !== MOCK_IDLE_SESSION_ID &&
            payload.sessionId !== MOCK_PAUSED_SESSION_ID &&
            !MOCK_EXTRA_THINKING_SESSIONS.some((spec) => spec.sessionId === payload.sessionId)
          ) {
            streamSubscribed = false;
            terminalWanted = false;
          }
          return ok(request);
        }
        const extraThinkingSpec = MOCK_EXTRA_THINKING_SESSIONS.find((spec) => spec.sessionId === payload.sessionId);
        if (extraThinkingSpec) {
          if (payload.action === 'transcript-window') {
            const entries = extraThinkingTranscript(extraThinkingSpec);
            return ok(request, { revision: 1, totalEntries: entries.length, startIndex: 0, entries } as unknown as JsonValue);
          }
          return ok(request, extraThinkingSnapshot(extraThinkingSpec) as unknown as JsonValue);
        }
        if (payload.sessionId === MOCK_PAUSED_SESSION_ID) {
          // "Paused": the protocol has no paused ActivityStateWire, so this
          // reports 'idle' (the closest real state) and communicates
          // "paused" only through the transcript/scrollback text. Static
          // like the idle session - nothing ever streams from it.
          if (payload.action === 'transcript-window') {
            const pausedTranscript: TranscriptEntryWire[] = [
              { kind: 'user', uuid: 'mock-paused-user-1', ts: Date.now() - 900_000, text: 'Pause here - I want to review the token schema before you continue.' },
              {
                kind: 'assistant',
                uuid: 'mock-paused-assistant-1',
                ts: Date.now() - 840_000,
                blocks: [{ type: 'text', text: 'Paused midway through the migration, right before the token-schema change - resume from the terminal when ready.' }],
              },
            ];
            return ok(request, {
              revision: 1,
              totalEntries: pausedTranscript.length,
              startIndex: 0,
              entries: pausedTranscript,
            } as unknown as JsonValue);
          }
          const pausedSnapshot: ReadStreamResponsePayload = {
            scrollback: 'push-token migration worktree\r\n$ claude\r\n> Paused - resume from the terminal when ready.\r\n',
            activity: { state: 'idle', reason: { kind: 'idle' } },
            usage: mockUsage(61_000, MOCK_MODEL_FABLE),
            awaitedPromptId: null,
            ptyDimensions: { ...MOCK_DESKTOP_PTY_DIMENSIONS },
          };
          return ok(request, pausedSnapshot as unknown as JsonValue);
        }
        if (payload.sessionId === MOCK_IDLE_SESSION_ID) {
          // A finished, quiet session: static scrollback, idle activity, a
          // small settled transcript. Nothing ever streams from it.
          if (payload.action === 'transcript-window') {
            const idleTranscript: TranscriptEntryWire[] = [
              { kind: 'user', uuid: 'mock-idle-user-1', ts: Date.now() - 3_600_000, text: 'Summarize the relay load-test results.' },
              {
                kind: 'assistant',
                uuid: 'mock-idle-assistant-1',
                ts: Date.now() - 3_540_000,
                blocks: [{ type: 'text', text: 'Done. p50 relay-added latency held at 0.79ms across 50 pairs; summary written to the task notes.' }],
              },
            ];
            return ok(request, {
              revision: 1,
              totalEntries: idleTranscript.length,
              startIndex: 0,
              entries: idleTranscript,
            } as unknown as JsonValue);
          }
          const idleSnapshot: ReadStreamResponsePayload = {
            scrollback: 'relay perf worktree\r\n$ claude\r\n> Load-test summary written. Session is idle.\r\n',
            activity: { state: 'idle', reason: { kind: 'idle' } },
            usage: mockUsage(28_000, MOCK_MODEL_OPUS),
            awaitedPromptId: null,
            ptyDimensions: { ...MOCK_DESKTOP_PTY_DIMENSIONS },
          };
          return ok(request, idleSnapshot as unknown as JsonValue);
        }
        if (payload.sessionId === MOCK_CODEX_SESSION_ID) {
          if (payload.action === 'transcript-window') {
            // No structured transcript: the loaded-but-empty window is what
            // flips the phone's chat lens to the reading view.
            return ok(request, { revision: 1, totalEntries: 0, startIndex: 0, entries: [] } as unknown as JsonValue);
          }
          codexStreamSubscribed = true;
          startFeed();
          const codexSnapshot: ReadStreamResponsePayload = {
            scrollback: codexTuiFrame(0),
            activity: { state: 'thinking', reason: { kind: 'turn-active' } },
            usage: mockUsage(15_000, MOCK_MODEL_CODEX),
            awaitedPromptId: null,
            ptyDimensions: { ...MOCK_DESKTOP_PTY_DIMENSIONS },
          };
          return ok(request, codexSnapshot as unknown as JsonValue);
        }
        if (activeSessionId === null || payload.sessionId !== activeSessionId) {
          return failWith(request, `No such session: ${payload.sessionId}`);
        }
        if (payload.action === 'transcript-window') {
          const end = Math.min(payload.beforeIndex ?? transcript.length, transcript.length);
          const start = Math.max(0, end - (payload.limit ?? 60));
          const window: TranscriptWindowResponsePayload = {
            revision: transcriptRevision,
            totalEntries: transcript.length,
            startIndex: start,
            entries: transcript.slice(start, end),
          };
          return ok(request, window as unknown as JsonValue);
        }
        // Mirrors the desktop: a list-only subscription (`terminal: false`)
        // attaches no PTY tap and returns an empty scrollback. Omitted means
        // true, per the protocol. Without this the mock streamed terminal
        // bytes to every subscriber and no dev run could ever show that a
        // caller had re-armed PTY streaming by accident.
        const wantsTerminal = payload.terminal ?? true;
        streamSubscribed = true;
        terminalWanted = wantsTerminal;
        startFeed();
        const snapshot: ReadStreamResponsePayload = {
          scrollback: wantsTerminal ? mockTerminalScrollback() : '',
          activity: pendingPromptId ? { state: 'permission', reason: { kind: 'permission' } } : { state: 'thinking', reason: { kind: 'turn-active' } },
          usage: mockUsage(streamingUsedTokens(feedTick), MOCK_MODEL_SONNET),
          awaitedPromptId: pendingPromptId,
          awaitedPromptOptions: pendingPromptId === PERMISSION_PROMPT_ID ? MOCK_PERMISSION_OPTIONS : null,
          ptyDimensions: { ...ptyDimensions },
        };
        return ok(request, snapshot as unknown as JsonValue);
      }
      case 'read-diff': {
        const payload = parseCapabilityRequestPayload('read-diff', request.payload);
        if (payload.action === 'unsubscribe') return ok(request);
        if (payload.filePath) return ok(request, diffFileContent(payload.filePath) as unknown as JsonValue);
        return ok(request, diffFileList() as unknown as JsonValue);
      }
      case 'send-user-message': {
        const payload = parseCapabilityRequestPayload('send-user-message', request.payload);
        // Magic dev commands for exercising session-lifecycle paths that a
        // real desktop only hits on a model switch or process exit.
        if (payload.text.trim() === '/respawn') {
          respawnActiveSession();
          return ok(request, { delivered: true });
        }
        if (payload.text.trim() === '/end-session') {
          endActiveSession();
          return ok(request, { delivered: true });
        }
        entryCounter += 1;
        appendTranscriptEntry({ kind: 'user', uuid: `mock-user-sent-${entryCounter}`, ts: Date.now(), text: payload.text });
        emitActivity('thinking');
        const replyCounter = entryCounter;
        later(2500, () => {
          appendTranscriptEntry({
            kind: 'assistant',
            uuid: `mock-assistant-reply-${replyCounter}`,
            ts: Date.now(),
            blocks: [{ type: 'text', text: 'Got it - folding that into the fix.' }],
          });
        });
        return ok(request, { delivered: true });
      }
      case 'move-task': {
        const payload = parseCapabilityRequestPayload('move-task', request.payload);
        const located = locateTask(payload.taskId);
        if (!located) return failWith(request, `No such task: ${payload.taskId}`);
        located.task.swimlane_id = payload.targetSwimlaneId;
        located.task.position = payload.targetPosition;
        located.task.updated_at = new Date().toISOString();
        later(50, () => {
          emit({ kind: 'board', projectId: located.projectId, taskId: located.task.id, payload: { change: 'task-updated', ids: [located.task.id] } });
        });
        return ok(request, { ok: true });
      }
      case 'answer-permission-prompt': {
        const payload = parseCapabilityRequestPayload('answer-permission-prompt', request.payload);
        if (pendingPromptId === null || payload.promptId !== pendingPromptId) {
          return failWith(request, 'promptId does not match the currently outstanding prompt (stale or already answered)');
        }
        const answeredPromptId = pendingPromptId;
        clearPrompt(answeredPromptId);
        // The real agent always follows an answered prompt with the awaited
        // tool's result (or a rejection notice); without it the tool_use
        // cell stays pending forever once the card clears.
        if (answeredPromptId === PERMISSION_PROMPT_ID) {
          const denied = payload.keystrokes.startsWith('\u001b');
          later(600, () => {
            appendTranscriptEntry({
              kind: 'tool_result',
              uuid: 'mock-result-permission',
              ts: Date.now(),
              toolUseId: PERMISSION_TOOL_ID,
              content: denied
                ? "The user doesn't want to proceed with this tool use."
                : 'Test Suites: 41 passed, 41 total\nTests:       244 passed, 244 total\nTime:        27.1 s',
            });
          });
        }
        if (answeredPromptId === QUESTION_PROMPT_ID) {
          const selectedDigit = payload.keystrokes.replace(/[^1-9]/g, '').slice(0, 1) || '1';
          later(600, () => {
            appendTranscriptEntry({
              kind: 'tool_result',
              uuid: 'mock-result-question',
              ts: Date.now(),
              toolUseId: QUESTION_TOOL_ID,
              content: `User selected option ${selectedDigit}.`,
            });
          });
        }
        if (answeredPromptId === PERMISSION_PROMPT_ID && !questionRaised) {
          later(10_000, () => {
            if (pendingPromptId === null) raiseQuestionPrompt();
          });
        }
        return ok(request, { answered: true });
      }
      case 'interactive-terminal': {
        const payload = parseCapabilityRequestPayload('interactive-terminal', request.payload);
        // Mirrors the desktop's action union: resize holds the grid until
        // release-size restores the mock's desktop-default 120x30.
        if (payload.action === 'resize') {
          const colsChanged = payload.dimensions.cols !== ptyDimensions.cols;
          ptyDimensions = { cols: payload.dimensions.cols, rows: payload.dimensions.rows };
          emitPtyResize();
          return ok(request, { resized: true, colsChanged });
        }
        if (payload.action === 'release-size') {
          ptyDimensions = { ...MOCK_DESKTOP_PTY_DIMENSIONS };
          emitPtyResize();
          return ok(request, { released: true });
        }
        if (activeSessionId === null) return failWith(request, 'No active session');
        emit({
          kind: 'terminal',
          sessionId: activeSessionId,
          taskId: MOCK_TASK_ID,
          payload: { data: payload.data.replace(/\r/g, '\r\n') },
        });
        return ok(request, { written: true });
      }
      case 'board-tool-read': {
        const payload = parseCapabilityRequestPayload('board-tool-read', request.payload);
        return ok(request, { result: { note: `mock answered ${payload.tool}` } });
      }
      case 'board-tool-write': {
        const payload = parseCapabilityRequestPayload('board-tool-write', request.payload);
        if (payload.tool === 'create_task') {
          const params = (payload.params ?? {}) as { title?: string; description?: string; column?: string };
          const column = mockColumns().find((candidate) => candidate.name.toLowerCase() === params.column?.toLowerCase()) ?? mockColumns()[0];
          entryCounter += 1;
          const created = boardTaskFixture({
            id: `mock-created-${entryCounter}`,
            display_id: 100 + entryCounter,
            title: params.title ?? 'Untitled mock task',
            description: params.description ?? '',
            swimlane_id: column.id,
            position: tasks.filter((candidate) => candidate.swimlane_id === column.id).length,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          });
          tasks.push(created);
          later(50, () => {
            emit({ kind: 'board', projectId: MOCK_PROJECT.id, taskId: created.id, payload: { change: 'task-created', ids: [created.id] } });
          });
          return ok(request, { result: { created: created.id } });
        }
        if (payload.tool === 'update_task') {
          const params = (payload.params ?? {}) as { taskId?: string; title?: string; description?: string };
          const task = tasks.find((candidate) => candidate.id === params.taskId);
          if (!task) return failWith(request, `No such task: ${params.taskId}`);
          if (typeof params.title === 'string') task.title = params.title;
          if (typeof params.description === 'string') task.description = params.description;
          task.updated_at = new Date().toISOString();
          later(50, () => {
            emit({ kind: 'board', projectId: MOCK_PROJECT.id, taskId: task.id, payload: { change: 'task-updated', ids: [task.id] } });
          });
          return ok(request, { result: { updated: task.id } });
        }
        if (payload.tool === 'delete_task') {
          const params = (payload.params ?? {}) as { taskId?: string };
          const taskIndex = tasks.findIndex((candidate) => candidate.id === params.taskId);
          if (taskIndex < 0) return failWith(request, `No such task: ${params.taskId}`);
          const [removed] = tasks.splice(taskIndex, 1);
          if (removed.session_id !== null && removed.session_id === activeSessionId) endActiveSession();
          later(50, () => {
            emit({ kind: 'board', projectId: MOCK_PROJECT.id, taskId: removed.id, payload: { change: 'task-deleted', ids: [removed.id] } });
          });
          return ok(request, { result: { deleted: removed.id } });
        }
        return ok(request, { result: { note: `mock answered ${payload.tool}` } });
      }
      default:
        return failWith(request, `Mock desktop has no handler for ${request.verb}`);
    }
  });

  return {
    identity,
    desktopStaticPublicKey: desktopStatic.publicKey,
    phoneTransport,
    async start(): Promise<void> {
      await desktopTransport.connect();
      peer.beginHandshake();
    },
    dispose(): void {
      if (feedTimer) clearInterval(feedTimer);
      feedTimer = null;
      for (const timer of oneShotTimers) clearTimeout(timer);
      oneShotTimers.clear();
      peer.dispose();
      desktopTransport.close();
    },
  };
}
