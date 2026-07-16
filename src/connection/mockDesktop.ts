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
  type ReadStreamResponsePayload,
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

const MOCK_PROJECT = { id: 'mock-project', name: 'Mock Project' };
/** A second project: exercises the board project switcher and cross-project Home rows. */
const MOCK_PROJECT_2 = { id: 'mock-project-relay', name: 'Relay' };
const MOCK_SESSION_ID = 'mock-session-1';
const MOCK_TASK_ID = 'mock-task-1';
/** A second, TRANSCRIPT-LESS session (agent: codex): exercises the chat reading-view fallback. */
const MOCK_CODEX_SESSION_ID = 'mock-session-codex';
const MOCK_CODEX_TASK_ID = 'mock-task-codex';
/** An IDLE session in the second project: exercises the Home feed's Idle section. */
const MOCK_IDLE_SESSION_ID = 'mock-session-idle';
const MOCK_IDLE_TASK_ID = 'mock-task-idle';
const PERMISSION_TOOL_ID = 'mock-tool-2';
const QUESTION_TOOL_ID = 'mock-tool-3';
const PERMISSION_PROMPT_ID = `${MOCK_SESSION_ID}:${PERMISSION_TOOL_ID}`;
const QUESTION_PROMPT_ID = `${MOCK_SESSION_ID}:${QUESTION_TOOL_ID}`;
/** The mock desktop pane's grid; a fit-mode resize overrides it until release-size restores it. */
const MOCK_DESKTOP_PTY_DIMENSIONS = { cols: 120, rows: 30 };

function initialTasks(): BoardTaskWire[] {
  const nowIso = new Date().toISOString();
  return [
    boardTaskFixture({
      id: MOCK_TASK_ID,
      display_id: 1,
      title: 'Streaming mock session',
      description: 'Served by the in-app mock desktop peer.',
      swimlane_id: 'lane-executing',
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
      position: 1,
      agent: 'codex',
      session_id: MOCK_CODEX_SESSION_ID,
      branch_name: 'feature/codex-refactor',
      created_at: nowIso,
      updated_at: nowIso,
    }),
  ];
}

/** A codex-style fullscreen TUI frame: cursor-home + full rewrite each paint. */
function codexTuiFrame(paintTick: number): string {
  const spinnerGlyphs = ['|', '/', '-', '\\'];
  const spinner = spinnerGlyphs[paintTick % spinnerGlyphs.length];
  const statusLine = paintTick % 2 === 0 ? 'Refactoring src/billing/invoice.ts' : 'Running the affected tests';
  return (
    '\x1b[H\x1b[2J' +
    'codex session (mock)\r\n' +
    '╭────────────────────────╮\r\n' +
    `${statusLine} ${spinner}\r\n` +
    '╰────────────────────────╯\r\n' +
    `files touched: ${3 + (paintTick % 4)} · tests: ${12 + paintTick}\r\n`
  );
}

// Mirrors the real Kangentic default board so mock mode exercises the
// chip bar and sectioned scroll at true column scale.
function mockColumns() {
  return [
    boardColumnFixture({ id: 'lane-todo', name: 'To Do', role: 'todo', position: 0, color: '#8b949e' }),
    boardColumnFixture({ id: 'lane-planning', name: 'Planning', role: null, position: 1, color: '#8957e5' }),
    boardColumnFixture({ id: 'lane-executing', name: 'Executing', role: null, position: 2, color: '#58a6ff' }),
    boardColumnFixture({ id: 'lane-code-review', name: 'Code Review', role: null, position: 3, color: '#d29922' }),
    boardColumnFixture({ id: 'lane-testing', name: 'Testing', role: null, position: 4, color: '#39c5cf' }),
    boardColumnFixture({ id: 'lane-merge', name: 'Merge', role: null, position: 5, color: '#f0883e' }),
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

function baseTranscript(): TranscriptEntryWire[] {
  const now = Date.now();
  return [
    { kind: 'user', uuid: 'mock-user-1', ts: now - 60000, text: 'Fix the login redirect bug and add a regression test.' },
    {
      kind: 'assistant',
      uuid: 'mock-assistant-1',
      ts: now - 55000,
      blocks: [
        { type: 'text', text: 'Looking at the auth flow now. The redirect drops the `next` parameter on **expired-session** logins.' },
        { type: 'tool_use', id: 'mock-tool-1', name: 'Bash', input: { command: 'rg -n "next=" src/auth' } },
      ],
    },
    {
      kind: 'tool_result',
      uuid: 'mock-result-1',
      ts: now - 50000,
      toolUseId: 'mock-tool-1',
      content: 'src/auth/login.ts:42: redirect(`/login?next=${encodeURIComponent(path)}`)',
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
  let streamSubscribed = false;
  let feedTick = 0;
  let pendingPromptId: string | null = null;
  let questionRaised = false;
  let entryCounter = 0;
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

  function raisePrompt(promptId: string): void {
    if (activeSessionId === null) return;
    pendingPromptId = promptId;
    emit({ kind: 'activity', sessionId: activeSessionId, taskId: MOCK_TASK_ID, payload: { type: 'permission', promptId, pending: true } });
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
    activeSessionId = null;
    streamSubscribed = false;
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
    activeSessionId = successorSessionId;
    streamSubscribed = false;
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
      emit({
        kind: 'terminal',
        sessionId: activeSessionId,
        taskId: MOCK_TASK_ID,
        payload: { data: `tick ${feedTick}: scanning src/auth for redirect handling...\r\n` },
      });
      if (feedTick % 12 === 0 && pendingPromptId === null) {
        entryCounter += 1;
        appendTranscriptEntry({
          kind: 'assistant',
          uuid: `mock-assistant-tick-${entryCounter}`,
          ts: Date.now(),
          blocks: [{ type: 'tool_use', id: `mock-tool-tick-${entryCounter}`, name: 'Bash', input: { command: 'npm run test:unit -- auth-redirect' } }],
        });
      }
      if (feedTick === 20 && pendingPromptId === null && !questionRaised) {
        appendTranscriptEntry({
          kind: 'assistant',
          uuid: 'mock-assistant-permission',
          ts: Date.now(),
          blocks: [{ type: 'tool_use', id: PERMISSION_TOOL_ID, name: 'Bash', input: { command: 'npm run test:unit -- auth-redirect' } }],
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

  function boardSnapshot(projectId: string): JsonValue {
    if (projectId === MOCK_PROJECT_2.id) {
      return {
        projectId: MOCK_PROJECT_2.id,
        columns: mockColumns2(),
        tasks: [...tasks2],
        backlog: [],
      } as unknown as JsonValue;
    }
    return {
      projectId: MOCK_PROJECT.id,
      columns: mockColumns(),
      tasks: [...tasks],
      backlog: [],
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
        return ok(request, boardSnapshot(payload.projectId));
      }
      case 'read-stream': {
        const payload = parseCapabilityRequestPayload('read-stream', request.payload);
        if (payload.action === 'unsubscribe') {
          if (payload.sessionId === MOCK_CODEX_SESSION_ID) codexStreamSubscribed = false;
          else if (payload.sessionId !== MOCK_IDLE_SESSION_ID) streamSubscribed = false;
          return ok(request);
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
            usage: null,
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
            usage: null,
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
        streamSubscribed = true;
        startFeed();
        const snapshot: ReadStreamResponsePayload = {
          scrollback: 'kangentic mock desktop\r\n$ claude\r\nWorking on the login redirect bug...\r\n',
          activity: pendingPromptId ? { state: 'permission', reason: { kind: 'permission' } } : { state: 'thinking', reason: { kind: 'turn-active' } },
          usage: null,
          awaitedPromptId: pendingPromptId,
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
