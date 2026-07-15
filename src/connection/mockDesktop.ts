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
const MOCK_SESSION_ID = 'mock-session-1';
const MOCK_TASK_ID = 'mock-task-1';
const PERMISSION_TOOL_ID = 'mock-tool-2';
const QUESTION_TOOL_ID = 'mock-tool-3';
const PERMISSION_PROMPT_ID = `${MOCK_SESSION_ID}:${PERMISSION_TOOL_ID}`;
const QUESTION_PROMPT_ID = `${MOCK_SESSION_ID}:${QUESTION_TOOL_ID}`;

function initialTasks(): BoardTaskWire[] {
  const nowIso = new Date().toISOString();
  return [
    boardTaskFixture({
      id: MOCK_TASK_ID,
      display_id: 1,
      title: 'Streaming mock session',
      description: 'Served by the in-app mock desktop peer.',
      swimlane_id: 'lane-doing',
      session_id: MOCK_SESSION_ID,
      branch_name: 'feature/mock-work',
      created_at: nowIso,
      updated_at: nowIso,
    }),
    boardTaskFixture({
      id: 'mock-task-2',
      display_id: 2,
      title: 'A quiet card to move around',
      description: 'Long-press me to try the move sheet.',
      swimlane_id: 'lane-todo',
      created_at: nowIso,
      updated_at: nowIso,
    }),
  ];
}

function mockColumns() {
  return [
    boardColumnFixture({ id: 'lane-todo', name: 'To Do', role: 'todo', position: 0, color: '#3fb950' }),
    boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null, position: 1, color: '#d29922' }),
    boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 2, color: '#8957e5' }),
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
  const transcript = baseTranscript();
  let transcriptRevision = 1;
  let streamSubscribed = false;
  let feedTick = 0;
  let pendingPromptId: string | null = null;
  let questionRaised = false;
  let entryCounter = 0;
  let feedTimer: ReturnType<typeof setInterval> | null = null;
  const oneShotTimers = new Set<ReturnType<typeof setTimeout>>();

  function emit(event: BridgeEvent): void {
    if (!peer.isEstablished) return;
    peer.emitEvent(event);
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
    transcript.push(entry);
    transcriptRevision += 1;
    emit({
      kind: 'transcript',
      sessionId: MOCK_SESSION_ID,
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
    const reason = state === 'permission' ? { kind: 'permission' as const } : state === 'idle' ? { kind: 'idle' as const } : { kind: 'turn-active' as const };
    emit({ kind: 'activity', sessionId: MOCK_SESSION_ID, taskId: MOCK_TASK_ID, payload: { type: 'activity', state, reason } });
  }

  function raisePrompt(promptId: string): void {
    pendingPromptId = promptId;
    emit({ kind: 'activity', sessionId: MOCK_SESSION_ID, taskId: MOCK_TASK_ID, payload: { type: 'permission', promptId, pending: true } });
    emitActivity('permission');
  }

  function clearPrompt(promptId: string): void {
    pendingPromptId = null;
    later(50, () => {
      emit({ kind: 'activity', sessionId: MOCK_SESSION_ID, taskId: MOCK_TASK_ID, payload: { type: 'permission', promptId, pending: false } });
      emitActivity('thinking');
    });
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
            questions: [
              {
                question: 'Where should the redirect regression test live?',
                header: 'Test tier',
                multiSelect: false,
                options: [
                  { label: 'Unit (vitest)', description: 'Fast, pure redirect-builder coverage.' },
                  { label: 'Component (RTL)', description: 'Covers the login form wiring too.' },
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
      if (!peer.isEstablished || !streamSubscribed) return;
      feedTick += 1;
      emit({
        kind: 'terminal',
        sessionId: MOCK_SESSION_ID,
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

  function boardSnapshot(): JsonValue {
    return {
      projectId: MOCK_PROJECT.id,
      columns: mockColumns(),
      tasks: [...tasks],
      backlog: [],
    } as unknown as JsonValue;
  }

  peer.setRequestHandler((request) => {
    switch (request.verb) {
      case 'read-board': {
        const payload = parseCapabilityRequestPayload('read-board', request.payload);
        if (!payload.projectId) return ok(request, { projects: [MOCK_PROJECT] });
        if (payload.action === 'unsubscribe') return ok(request);
        return ok(request, boardSnapshot());
      }
      case 'read-stream': {
        const payload = parseCapabilityRequestPayload('read-stream', request.payload);
        if (payload.action === 'unsubscribe') {
          streamSubscribed = false;
          return ok(request);
        }
        if (payload.sessionId !== MOCK_SESSION_ID) return failWith(request, `No such session: ${payload.sessionId}`);
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
        const task = tasks.find((candidate) => candidate.id === payload.taskId);
        if (!task) return failWith(request, `No such task: ${payload.taskId}`);
        task.swimlane_id = payload.targetSwimlaneId;
        task.position = payload.targetPosition;
        task.updated_at = new Date().toISOString();
        later(50, () => {
          emit({ kind: 'board', projectId: MOCK_PROJECT.id, taskId: task.id, payload: { change: 'task-updated', ids: [task.id] } });
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
        emit({
          kind: 'terminal',
          sessionId: MOCK_SESSION_ID,
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
