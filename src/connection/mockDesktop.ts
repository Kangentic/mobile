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
const MOCK_PROJECT = { id: 'mock-project', name: 'Project 1', color: '#58a6ff' };
/** A second project: exercises the board project switcher and cross-project Home rows. */
const MOCK_PROJECT_2 = { id: 'mock-project-relay', name: 'Project 2', color: '#3fb950' };
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
      title: 'Streaming mock session',
      // Deliberately long - a design-review stress test for how the body
      // text truncates against the ticket number, project pill, and PR pill
      // sharing its rows.
      description:
        'Served by the in-app mock desktop peer, streaming a fabricated login-redirect fix through every phase - permission prompts, a follow-up question, and a context-usage bar that climbs as the fake turns pile up.',
      swimlane_id: 'lane-executing',
      // Executing scales light -> heavy: Codex refactor (lightest, position
      // 0) first, this one (medium) second, the "full card" (position 2)
      // last.
      position: 1,
      session_id: MOCK_SESSION_ID,
      branch_name: 'feature/mock-work',
      labels: ['auth', 'wave-4'],
      pr_number: 42,
      pr_state: 'open',
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: 'mock-task-2',
      display_id: 2,
      title: 'A quiet card to move around',
      description: 'Long-press me to try the move sheet.',
      swimlane_id: 'lane-todo',
      labels: ['chore'],
      attachment_count: 2,
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: MOCK_CODEX_TASK_ID,
      display_id: 3,
      title: 'Codex refactor (no structured transcript)',
      description: 'Exercises the chat reading-view fallback.',
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
  const statusLine = paintTick % 2 === 0 ? 'Refactoring src/billing/invoice.ts' : 'Running the affected tests';
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
      title: 'Relay load-test follow-ups',
      description: 'An idle agent session: exercises the Home Idle section.',
      swimlane_id: 'lane2-progress',
      session_id: MOCK_IDLE_SESSION_ID,
      branch_name: 'perf/load-test',
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: 'mock-task-relay-2',
      display_id: 2,
      title: 'Document the metrics endpoint',
      description: 'A quiet second-project card.',
      swimlane_id: 'lane2-backlog',
      created_at: nowIso,
      updated_at: nowIso,
    }),
  ];
}

/**
 * Mirrored from a REAL Claude Code session's transcript (the App Phase 1
 * overnight run) so mock parity matches genuine session shapes: an Edit
 * with real multi-line old/new strings, real command outputs, and real
 * assistant prose lengths. Machine paths sanitized to C:\Users\dev per
 * the no-personal-info rule; content is recorded data otherwise.
 */
function baseTranscript(): TranscriptEntryWire[] {
  const now = Date.now();
  return [
    {
      kind: 'user',
      uuid: 'mock-user-1',
      ts: now - 300000,
      text: 'Update the Commands section in CLAUDE.md to match the new EAS build profiles, then verify the suites still pass.',
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
          text: 'Reading the current Commands list, then updating the build entries to the **dev/preview/prod** profile split.',
        },
        {
          type: 'tool_use',
          id: 'mock-tool-1',
          name: 'Edit',
          input: {
            replace_all: false,
            file_path: 'C:\\Users\\dev\\Documents\\GitHub\\kangentic-mobile\\CLAUDE.md',
            old_string:
              '- `eas build --profile development --platform android` - Build a dev-client for local iteration\n- `eas build --profile production --platform ios` - Build for the App Store (cloud, no Mac needed)\n- `npm run typecheck` - `tsc --noEmit`',
            new_string:
              '- `eas build --profile development --platform android` (`npm run build:dev`) - Build a dev-client\n  for local iteration in the cloud, no local Android SDK build required\n- `eas build --profile preview --platform android` (`npm run build:preview`) - Internal\n  distribution build\n- `eas build --profile production --platform android` (`npm run build:prod`) - Store-release build\n- `eas build --profile production --platform ios` - Build for the App Store (cloud, no Mac needed)\n- `npm run typecheck` - `tsc --noEmit`',
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
        'The file C:\\Users\\dev\\Documents\\GitHub\\kangentic-mobile\\CLAUDE.md has been updated successfully.',
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
      content: '> @kangentic/mobile@0.1.0 typecheck\n> tsc --noEmit',
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
          text: 'Typecheck and the unit suite are green; the Commands section now documents all three EAS profiles. Running the component tier next needs your approval.',
        },
      ],
    },
  ];
}

function diffFileList(): DiffFileListWire {
  return {
    files: [
      { path: 'src/auth/login.ts', status: 'M', insertions: 8, deletions: 2, binary: false },
      { path: 'tests/auth-redirect.test.ts', status: 'A', insertions: 31, deletions: 0, binary: false },
    ],
    totalInsertions: 39,
    totalDeletions: 2,
  };
}

function diffFileContent(filePath: string): DiffFileContentWire {
  if (filePath === 'src/auth/login.ts') {
    return {
      original: 'export function loginRedirect(path) {\n  redirect("/login");\n}\n',
      modified: 'export function loginRedirect(path) {\n  const next = encodeURIComponent(path);\n  redirect(`/login?next=${next}`);\n}\n',
      language: 'typescript',
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
      payload: { type: 'usage', usage: mockUsage(42_000 + feedTick * 900, MOCK_MODEL_SONNET) },
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
      if (terminalWanted) {
        emit({
          kind: 'terminal',
          sessionId: activeSessionId,
          taskId: MOCK_TASK_ID,
          payload: { data: `tick ${feedTick}: scanning src/auth for redirect handling...\r\n` },
        });
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
          { command: 'npm run typecheck', result: '> @kangentic/mobile@0.1.0 typecheck\n> tsc --noEmit' },
          { command: 'npm run lint', result: '> @kangentic/mobile@0.1.0 lint\n> eslint . --max-warnings 0' },
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
      // Exercises the desktop's "hide ticket numbers" layout setting -
      // Project 1 leaves it at the true default, Project 2 turns it off.
      showTicketNumbers: !isSecondProject,
      ...(view !== undefined ? { view } : {}),
      ...(view === 'sessions' ? { taskCountsByColumnId } : {}),
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
          scrollback: wantsTerminal ? 'kangentic mock desktop\r\n$ claude\r\nWorking on the login redirect bug...\r\n' : '',
          activity: pendingPromptId ? { state: 'permission', reason: { kind: 'permission' } } : { state: 'thinking', reason: { kind: 'turn-active' } },
          usage: mockUsage(42_000 + feedTick * 900, MOCK_MODEL_SONNET),
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
            blocks: [{ type: 'text', text: 'Got it - folding that into the fix. (This reply came from the in-app mock desktop.)' }],
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
