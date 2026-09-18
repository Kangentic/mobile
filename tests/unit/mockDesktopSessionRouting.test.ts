/**
 * The mock desktop's per-session routing, driven through a REAL
 * ChannelController over the loopback - the exact stack a demo pairing runs.
 *
 * Every case here is a regression pin on a defect App Review would have hit
 * on a device, found by walking the demo screen by screen:
 *
 *  - typing in a non-streaming session's terminal echoed into the STREAMING
 *    session's feed, so the keyboard looked dead where it was used;
 *  - a chat message sent into a static session appended to the streaming
 *    transcript, so it never appeared where it was sent;
 *  - board writes resolved only the first project, so editing or deleting a
 *    second-project task failed and a create landed on the wrong board;
 *  - archiving (a move into the done-role column) removed the card from the
 *    board without adding it to the archived page, so it vanished outright;
 *  - register-push had no handler at all, failing every registration a
 *    release build fires on establish.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BridgeEvent } from '@kangentic/protocol';
import { ChannelController } from '@/channel';
import {
  createMockDesktop,
  MOCK_CODEX_STATIC_SESSION,
  MOCK_GEMINI_STATIC_SESSION,
  MOCK_IDLE_STATIC_SESSION,
  MOCK_PAUSED_STATIC_SESSION,
  staticSessionSeedTranscriptForTest,
  type MockDesktop,
} from '@/connection/mockDesktop';
// The store's OWN guard, imported rather than re-implemented: this test asserts
// on what the store would actually read out of the rig's push, and a hand-copy
// would be free to drift from it while still passing.
import { extractSpawnProgressLabel } from '@/state/activityStore';
import { waitUntil } from '../helpers/async';

/** The second project's real id (probed from the fixtures, not guessed): the checkout-api board. */
const MOCK_PROJECT_2_ID = 'mock-project-relay';
/** The streaming task's session id - not exported by mockDesktop.ts, so named here the same way MOCK_PROJECT_2_ID is. */
const MOCK_STREAMING_SESSION_ID = 'mock-session-1';

let mockDesktop: MockDesktop;
let controller: ChannelController;
let feedEvents: BridgeEvent[];

beforeEach(async () => {
  feedEvents = [];
  mockDesktop = createMockDesktop();
  controller = new ChannelController({
    identity: mockDesktop.identity,
    desktopStaticPublicKey: mockDesktop.desktopStaticPublicKey,
    relayUrl: 'loopback://routing-test',
    transport: mockDesktop.phoneTransport,
  });
  for (const kind of ['terminal', 'transcript', 'activity', 'board'] as const) {
    controller.feed.on(kind, (event) => feedEvents.push(event));
  }
  await controller.connect();
  await mockDesktop.start();
  await waitUntil(() => controller.session.isEstablished, { label: 'loopback session establishes' });
});

afterEach(() => {
  controller.dispose();
  mockDesktop.dispose();
});

function eventsFor(kind: BridgeEvent['kind'], sessionId: string): BridgeEvent[] {
  return feedEvents.filter((event) => event.kind === kind && 'sessionId' in event && event.sessionId === sessionId);
}

describe('interactive-terminal routing', () => {
  it('echoes typed keystrokes into the session they were typed in', async () => {
    const response = await controller.verbs.writeInteractiveTerminal(MOCK_IDLE_STATIC_SESSION.sessionId, 'ls\r');

    expect(response.written).toBe(true);
    await waitUntil(() => eventsFor('terminal', MOCK_IDLE_STATIC_SESSION.sessionId).length > 0, {
      label: 'echo reaches the typed-in session',
    });
    const echo = eventsFor('terminal', MOCK_IDLE_STATIC_SESSION.sessionId)[0];
    expect(echo.kind === 'terminal' && echo.payload.data).toBe('ls\r\n');
    // And ONLY that session: the streaming session's feed stays silent, which
    // is the half the original bug got wrong.
    expect(eventsFor('terminal', 'mock-session-1')).toHaveLength(0);
  });

  it('refuses an unknown session rather than echoing somewhere invisible', async () => {
    await expect(controller.verbs.writeInteractiveTerminal('no-such-session', 'x')).rejects.toThrow(/No such session/);
  });

  it('echoes typed keystrokes into the STREAMING session when typed there', async () => {
    const response = await controller.verbs.writeInteractiveTerminal(MOCK_STREAMING_SESSION_ID, 'pwd\r');

    expect(response.written).toBe(true);
    await waitUntil(() => eventsFor('terminal', MOCK_STREAMING_SESSION_ID).length > 0, {
      label: 'echo reaches the streaming session',
    });
    const echo = eventsFor('terminal', MOCK_STREAMING_SESSION_ID)[0];
    expect(echo.kind === 'terminal' && echo.sessionId).toBe(MOCK_STREAMING_SESSION_ID);
    expect(echo.kind === 'terminal' && echo.payload.data).toBe('pwd\r\n');
  });
});

describe('read-stream terminal gating', () => {
  it('serves no PTY bytes to a list-only codex subscribe, proven against a running clock', async () => {
    // Gemini is the positive control: it repaints on the SAME feedTick % 2
    // === 0 branch codex does, so its terminal events arriving is proof the
    // 1Hz tick loop is genuinely running - which is what stops "no codex
    // terminal events arrived" from being true merely because nothing ever
    // started the feed. Subscribing it terminal:true is also what starts the
    // feed at all (codex/gemini only call startFeed() when they themselves
    // want PTY bytes).
    await controller.verbs.readStreamSubscribe(MOCK_GEMINI_STATIC_SESSION.sessionId, { terminal: true });

    const codexSnapshot = await controller.verbs.readStreamSubscribe(MOCK_CODEX_STATIC_SESSION.sessionId, { terminal: false });
    expect(codexSnapshot.scrollback).toBe('');

    await waitUntil(() => eventsFor('terminal', MOCK_GEMINI_STATIC_SESSION.sessionId).length > 0, {
      label: 'gemini repaints, proving the tick loop is running',
      timeoutMs: 4000,
    });

    expect(eventsFor('terminal', MOCK_CODEX_STATIC_SESSION.sessionId)).toHaveLength(0);
  });

  it('disarms the codex repaint on a list-only re-subscribe, while gemini keeps repainting', async () => {
    await controller.verbs.readStreamSubscribe(MOCK_GEMINI_STATIC_SESSION.sessionId, { terminal: true });
    await controller.verbs.readStreamSubscribe(MOCK_CODEX_STATIC_SESSION.sessionId, { terminal: true });

    await waitUntil(() => eventsFor('terminal', MOCK_CODEX_STATIC_SESSION.sessionId).length > 0, {
      label: 'codex repaints while its terminal is open',
      timeoutMs: 4000,
    });

    // Assignment, not disabling the subscription outright: a list-only
    // re-subscribe (what the subscription manager sends when a session
    // screen closes) must disarm the repaint.
    await controller.verbs.readStreamSubscribe(MOCK_CODEX_STATIC_SESSION.sessionId, { terminal: false });
    const codexCountAtDisarm = eventsFor('terminal', MOCK_CODEX_STATIC_SESSION.sessionId).length;
    const geminiCountAtDisarm = eventsFor('terminal', MOCK_GEMINI_STATIC_SESSION.sessionId).length;

    // Gemini stays subscribed terminal:true throughout, so its count growing
    // past the disarm point is proof the shared clock ran FURTHER - a flat
    // codex count against that is then a real disarm, not a stalled timer.
    await waitUntil(() => eventsFor('terminal', MOCK_GEMINI_STATIC_SESSION.sessionId).length > geminiCountAtDisarm, {
      label: 'gemini keeps repainting after the codex disarm',
      timeoutMs: 4000,
    });

    expect(eventsFor('terminal', MOCK_CODEX_STATIC_SESSION.sessionId)).toHaveLength(codexCountAtDisarm);
  });

  it('serves empty scrollback for a list-only subscribe to a static, non-agent-flavored session', async () => {
    const snapshot = await controller.verbs.readStreamSubscribe(MOCK_IDLE_STATIC_SESSION.sessionId, { terminal: false });
    expect(snapshot.scrollback).toBe('');
  });

  /**
   * The rig must report sessionStatus the way a real desktop does, on every
   * response rather than leaving the phone to assume 'running'. Without this
   * the mock modelled a pre-0.5.0 desktop, and the parked path that
   * localNotifier now suppresses on was unreachable under dev:mock.
   *
   * The paused session carries 'suspended' because its ACTIVITY cannot: the
   * protocol has no paused ActivityStateWire, so before this the park was
   * implied by snippet text alone.
   */
  it('reports the desktop lifecycle status, suspended for the paused session and running for the rest', async () => {
    const paused = await controller.verbs.readStreamSubscribe(MOCK_PAUSED_STATIC_SESSION.sessionId, { terminal: false });
    expect(paused.sessionStatus).toBe('suspended');
    expect(paused.activity.state).toBe('idle');

    const idle = await controller.verbs.readStreamSubscribe(MOCK_IDLE_STATIC_SESSION.sessionId, { terminal: false });
    expect(idle.sessionStatus).toBe('running');
  });
});

describe('send-user-message routing', () => {
  it('appends into the static session it was sent to, then draws that session reply', async () => {
    await controller.verbs.sendUserMessage(MOCK_PAUSED_STATIC_SESSION.sessionId, 'Ship the schema change tomorrow.');

    await waitUntil(() => eventsFor('transcript', MOCK_PAUSED_STATIC_SESSION.sessionId).length >= 1, {
      label: 'sent message lands in the paused session',
    });
    // The reply arrives on the mock's own 2.5s cadence, in that same session.
    await waitUntil(() => eventsFor('transcript', MOCK_PAUSED_STATIC_SESSION.sessionId).length >= 2, {
      label: 'the session replies',
      timeoutMs: 5000,
    });
    // Nothing leaked into the streaming session's transcript.
    expect(eventsFor('transcript', 'mock-session-1')).toHaveLength(0);

    // The transcript WINDOW agrees with the deltas: a re-read serves the
    // grown transcript at a bumped revision (seed +2: the sent message and
    // its reply), not the frozen seed.
    const window = await controller.verbs.readTranscriptWindow(MOCK_PAUSED_STATIC_SESSION.sessionId);
    const seedLength = staticSessionSeedTranscriptForTest(MOCK_PAUSED_STATIC_SESSION).length;
    expect(window.totalEntries).toBe(seedLength + 2);
    expect(window.revision).toBe(3);
  });
});

describe('board writes across both projects', () => {
  it('updates and deletes a second-project task', async () => {
    const updated = await controller.verbs.boardToolWrite('update_task', { taskId: 'mock-task-relay-2', title: 'Document every metrics counter' });
    expect(updated).toEqual({ updated: 'mock-task-relay-2' });

    const deleted = await controller.verbs.boardToolWrite('delete_task', { taskId: 'mock-task-relay-2' });
    expect(deleted).toEqual({ deleted: 'mock-task-relay-2' });

    await waitUntil(() => feedEvents.some((event) => event.kind === 'board' && event.projectId === MOCK_PROJECT_2_ID), {
      label: 'board events name the second project',
    });
  });

  it('creates a task on the project the sheet was open in', async () => {
    const created = (await controller.verbs.boardToolWrite('create_task', {
      project: MOCK_PROJECT_2_ID,
      title: 'Trace the slow cart query',
      description: '',
      column: 'this-column-does-not-exist-so-the-first-wins',
    })) as { created: string };

    const snapshot = await controller.verbs.readBoardSubscribe(MOCK_PROJECT_2_ID, { view: 'full' });
    expect(snapshot.tasks.some((task) => task.id === created.created)).toBe(true);
    // And NOT on the first project's board, which is where it used to land.
    const firstProjectId = 'mock-project';
    const firstSnapshot = await controller.verbs.readBoardSubscribe(firstProjectId, { view: 'full' });
    expect(firstSnapshot.tasks.some((task) => task.id === created.created)).toBe(false);
  });

  it('archives on a move into the done-role column instead of vanishing the task', async () => {
    const moved = await controller.verbs.moveTask({ projectId: MOCK_PROJECT_2_ID, taskId: 'mock-task-idle', targetSwimlaneId: 'lane2-shipped', targetPosition: 0 });
    expect(moved.ok).toBe(true);

    const snapshot = await controller.verbs.readBoardSubscribe(MOCK_PROJECT_2_ID, { view: 'full' });
    expect(snapshot.tasks.some((task) => task.id === 'mock-task-idle')).toBe(false);

    const archivedPage = await controller.verbs.readBoardArchived(MOCK_PROJECT_2_ID, {});
    expect(archivedPage.archivedTasks.some((task) => task.id === 'mock-task-idle')).toBe(true);
    // Newest first, ahead of the fixed fixtures.
    expect(archivedPage.archivedTasks[0]?.id).toBe('mock-task-idle');
  });
});

describe('read-diff routing', () => {
  it('serves each task its OWN diff, not the streaming session diff', async () => {
    // The flaky-spec session's task: its Changes lens must show the settle
    // wait, which is the story its terminal and chat tell one swipe away.
    const flakyDiff = await controller.verbs.readDiffFileList({ taskId: 'mock-task-thinking-3', projectId: 'mock-project' });
    expect(flakyDiff.files.map((file) => file.path)).toEqual(['checkout/guest-checkout.spec.ts']);

    const content = await controller.verbs.readDiffFileContent({
      taskId: 'mock-task-thinking-3',
      projectId: 'mock-project',
      filePath: 'checkout/guest-checkout.spec.ts',
    });
    expect(content.modified).toContain('data-ready');

    // The streaming session keeps its four-file sign-in diff.
    const mainDiff = await controller.verbs.readDiffFileList({ taskId: 'mock-task-1', projectId: 'mock-project' });
    expect(mainDiff.files.some((file) => file.path === 'src/auth/login.ts')).toBe(true);
  });

  it('serves an EMPTY list for a task with no diff story, never a borrowed one', async () => {
    const emptyDiff = await controller.verbs.readDiffFileList({ taskId: 'mock-created-99', projectId: 'mock-project' });
    expect(emptyDiff.files).toEqual([]);
    expect(emptyDiff.totalInsertions).toBe(0);
  });
});

describe('the codex session serves a structured transcript', () => {
  it('answers the window with Codex-native tool calls, not the empty fallback', async () => {
    // Before Phase 2 this session's window was hardcoded empty, modelling
    // Codex as permanently transcript-less - which stopped being true when
    // the desktop's rollout parser shipped. The premise, not the app, was
    // stale.
    const window = await controller.verbs.readTranscriptWindow(MOCK_CODEX_STATIC_SESSION.sessionId);
    expect(window.totalEntries).toBeGreaterThan(0);
    const toolNames = window.entries.flatMap((entry) =>
      entry.kind === 'assistant' ? entry.blocks.flatMap((block) => (block.type === 'tool_use' ? [block.name] : [])) : [],
    );
    expect(toolNames).toContain('shell');
    expect(toolNames).toContain('apply_patch');
    expect(toolNames).toContain('update_plan');
    // Stamped the way transcript-service stamps the adapter displayName.
    const agentNames = new Set(
      window.entries.flatMap((entry) => (entry.kind === 'assistant' ? [entry.agentName] : [])),
    );
    expect([...agentNames]).toEqual(['Codex CLI']);
    // Ends on the in-flight user prompt the terminal's spinner is answering.
    expect(window.entries[window.entries.length - 1]?.kind).toBe('user');
  });
});

describe('the gemini session serves a structured transcript', () => {
  it('answers the window with Gemini-native tool calls and ends on the in-flight prompt', async () => {
    const window = await controller.verbs.readTranscriptWindow(MOCK_GEMINI_STATIC_SESSION.sessionId);
    expect(window.totalEntries).toBeGreaterThan(0);
    const toolNames = window.entries.flatMap((entry) =>
      entry.kind === 'assistant' ? entry.blocks.flatMap((block) => (block.type === 'tool_use' ? [block.name] : [])) : [],
    );
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('replace');
    expect(toolNames).toContain('run_shell_command');
    const agentNames = new Set(
      window.entries.flatMap((entry) => (entry.kind === 'assistant' ? [entry.agentName] : [])),
    );
    expect([...agentNames]).toEqual(['Gemini CLI']);
    expect(window.entries[window.entries.length - 1]?.kind).toBe('user');
  });
});

describe('no session in the demo falls back to the reading view', () => {
  it('serves a NON-EMPTY transcript window for every session-bearing task on both boards', async () => {
    // The product decision this pins: the demo only ships agents whose
    // transcripts the desktop parses, so App Review never meets the degraded
    // reading-view fallback. A session added with an empty window - which is
    // exactly what the pre-Phase-2 codex session and then the "just spawned"
    // gemini session served - fails here by name.
    const emptySessions: string[] = [];
    for (const projectId of ['mock-project', MOCK_PROJECT_2_ID]) {
      const snapshot = await controller.verbs.readBoardSubscribe(projectId, { view: 'sessions' });
      for (const task of snapshot.tasks) {
        if (task.session_id === null) continue;
        const window = await controller.verbs.readTranscriptWindow(task.session_id);
        if (window.totalEntries === 0) emptySessions.push(`${projectId}/${task.id} -> ${task.session_id}`);
      }
    }
    expect(emptySessions).toEqual([]);
  });
});

describe('archived sessions', () => {
  it('answers the completed-task screen transcript for the Done fixtures', async () => {
    // The archived summary anchors on this sessionId; before these sessions
    // existed the read failed "No such session" - a broken screen one tap
    // into the Done column.
    const window = await controller.verbs.readTranscriptWindow('mock-project-relay-archived-session-1');
    expect(window.totalEntries).toBeGreaterThanOrEqual(4);
    const kinds = window.entries.map((entry) => entry.kind);
    expect(kinds).toContain('tool_result');
  });
});

/**
 * The mock's `since`, which exists so the rig cannot hide a broken primary path.
 *
 * `reason.since` and the phone's fallback (`enteredSectionAt`) normally land
 * within milliseconds of each other, so a mock emitting no `since` - or a fresh
 * `Date.now()` on every event - would make a WORKING selector and a BROKEN one
 * look identical under `dev:mock` and in the shipped demo, which is the one
 * failure the field cannot afford. These pin the two properties that keep the
 * difference visible: the value is genuinely backdated, and it holds still
 * across a re-subscribe that resets the fallback.
 */
describe('activity reason.since', () => {
  it('backdates an idle session far enough to exercise the hours format', async () => {
    const subscribedAtMs = Date.now();
    const snapshot = await controller.verbs.readStreamSubscribe(MOCK_IDLE_STATIC_SESSION.sessionId, { terminal: false });

    expect(snapshot.activity.state).toBe('idle');
    const reason = snapshot.activity.reason;
    expect(reason?.kind).toBe('idle');
    const since = reason !== null && reason.kind === 'idle' ? reason.since : undefined;
    expect(typeof since).toBe('number');
    // Hours, not milliseconds: a mock reporting Date.now() would agree with the
    // fallback exactly and never reach the 'Xh Ym' branch of the label at all.
    expect(subscribedAtMs - (since as number)).toBeGreaterThan(60 * 60_000);
  });

  it('reports the same since on a re-subscribe rather than restarting the clock', async () => {
    const first = await controller.verbs.readStreamSubscribe(MOCK_PAUSED_STATIC_SESSION.sessionId, { terminal: false });
    const second = await controller.verbs.readStreamSubscribe(MOCK_PAUSED_STATIC_SESSION.sessionId, { terminal: false });

    const sinceOf = (activity: typeof first.activity): number | undefined =>
      activity.reason !== null && activity.reason.kind === 'idle' ? activity.reason.since : undefined;

    expect(sinceOf(first.activity)).toBeDefined();
    expect(sinceOf(second.activity)).toBe(sinceOf(first.activity));
  });

  it('leaves a working session with no since to report', async () => {
    const snapshot = await controller.verbs.readStreamSubscribe(MOCK_CODEX_STATIC_SESSION.sessionId, { terminal: false });
    expect(snapshot.activity.state).toBe('thinking');
    expect(snapshot.activity.reason).toEqual({ kind: 'turn-active' });
  });

  /**
   * createMockDesktop runs inside openConnection, and the connection is
   * disposed on background and reopened on foreground - so anything anchored to
   * mock CONSTRUCTION restarts on every app switch. That would walk a demo row
   * from '4h 12m' back to '4h 7m': the exact resetting behaviour `since` exists
   * to avoid, in the one build App Review sees. Two mocks in one process here
   * stand in for that background/foreground cycle.
   */
  it('holds a static wait across a reconnect, rather than reseeding it', async () => {
    const before = await controller.verbs.readStreamSubscribe(MOCK_IDLE_STATIC_SESSION.sessionId, { terminal: false });

    controller.dispose();
    mockDesktop.dispose();
    const reconnected = createMockDesktop();
    const secondController = new ChannelController({
      identity: reconnected.identity,
      desktopStaticPublicKey: reconnected.desktopStaticPublicKey,
      relayUrl: 'loopback://reconnect-test',
      transport: reconnected.phoneTransport,
    });
    try {
      await secondController.connect();
      await reconnected.start();
      await waitUntil(() => secondController.session.isEstablished, { label: 'second loopback session establishes' });
      const after = await secondController.verbs.readStreamSubscribe(MOCK_IDLE_STATIC_SESSION.sessionId, { terminal: false });

      const sinceOf = (activity: typeof before.activity): number | undefined =>
        activity.reason !== null && activity.reason.kind === 'idle' ? activity.reason.since : undefined;

      expect(sinceOf(after.activity)).toBe(sinceOf(before.activity));
    } finally {
      secondController.dispose();
      reconnected.dispose();
    }
  });
});

describe('register-push', () => {
  it('acknowledges a registration instead of failing the verb', async () => {
    const response = await controller.verbs.registerPush({
      action: 'register',
      expoPushToken: 'ExponentPushToken[routing-test]',
      pushKeyBase64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      platform: 'android',
    });
    expect(response.registered).toBe(true);
  });
});

/**
 * The `/respawn` rig fix (mockDesktop.ts's `respawnActiveSession`,
 * kangentic board #639): the outgoing session's `session-ended` push MUST
 * carry a non-empty `spawnProgressLabel`, because this mock's OWN
 * `boardSnapshot()` applies the same `view: 'sessions'` filter a real
 * desktop's board does - so during the respawn gap the sessionless task
 * leaves the board entirely and the session screen's COLUMN-keyed swap
 * window (SessionScreen.tsx) can never fire off it. Without the label,
 * dev:mock would render "Session ended" for the whole multi-second gap: the
 * exact regression the screen's session-keyed swap window exists to
 * prevent, reintroduced into the rig meant to demonstrate the fix.
 */
describe('/respawn spawn-progress label (the dev:mock rig fix)', () => {
  it(
    'sends a non-empty spawnProgressLabel on the outgoing session-ended, and the task is sessionless before the successor lands',
    async () => {
      await controller.verbs.sendUserMessage(MOCK_STREAMING_SESSION_ID, '/respawn');

      await waitUntil(
        () =>
          eventsFor('activity', MOCK_STREAMING_SESSION_ID).some(
            (event) => event.kind === 'activity' && event.payload.type === 'session-ended',
          ),
        { label: 'the outgoing session receives session-ended' },
      );
      const endedEvent = eventsFor('activity', MOCK_STREAMING_SESSION_ID).find(
        (event) => event.kind === 'activity' && event.payload.type === 'session-ended',
      );
      if (!endedEvent || endedEvent.kind !== 'activity') {
        throw new Error('expected a session-ended activity event for the outgoing session');
      }
      const spawnProgressLabel = extractSpawnProgressLabel(endedEvent.payload);
      expect(typeof spawnProgressLabel).toBe('string');
      expect(spawnProgressLabel?.length ?? 0).toBeGreaterThan(0);

      // Sessionless BEFORE the successor lands: read the board well inside
      // the gap (the mock's MOCK_RESPAWN_GAP_MS is several seconds), while
      // the ended push above is the only thing that has happened so far.
      const midGapSnapshot = await controller.verbs.readBoardSubscribe('mock-project', { view: 'full' });
      const midGapTask = midGapSnapshot.tasks.find((task) => task.id === 'mock-task-1');
      expect(midGapTask?.session_id ?? null).toBeNull();

      // The successor eventually lands with a DIFFERENT session id, proving
      // the sessionless read above genuinely preceded it rather than merely
      // racing a same-tick swap.
      const deadline = Date.now() + 8000;
      let successorSessionId: string | null = null;
      while (Date.now() < deadline && successorSessionId === null) {
        const snapshot = await controller.verbs.readBoardSubscribe('mock-project', { view: 'full' });
        const task = snapshot.tasks.find((candidate) => candidate.id === 'mock-task-1');
        if (task?.session_id) successorSessionId = task.session_id;
        else await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(successorSessionId).not.toBeNull();
      expect(successorSessionId).not.toBe(MOCK_STREAMING_SESSION_ID);
    },
    12_000,
  );

  /**
   * The shape of the desktop's own column-move swap (suspend, then resume,
   * with NO label): the phone must go quiet on it exactly as on a labelled
   * respawn, and dev:mock needs a way to produce it. Same successor mechanics
   * as /respawn; the one difference is the absent field.
   */
  it(
    '/respawn-quiet sends no spawnProgressLabel on the outgoing session-ended, and still installs a successor',
    async () => {
      await controller.verbs.sendUserMessage(MOCK_STREAMING_SESSION_ID, '/respawn-quiet');

      await waitUntil(
        () =>
          eventsFor('activity', MOCK_STREAMING_SESSION_ID).some(
            (event) => event.kind === 'activity' && event.payload.type === 'session-ended',
          ),
        { label: 'the outgoing session receives session-ended' },
      );
      const endedEvent = eventsFor('activity', MOCK_STREAMING_SESSION_ID).find(
        (event) => event.kind === 'activity' && event.payload.type === 'session-ended',
      );
      if (!endedEvent || endedEvent.kind !== 'activity') {
        throw new Error('expected a session-ended activity event for the outgoing session');
      }
      expect(extractSpawnProgressLabel(endedEvent.payload)).toBeNull();

      const deadline = Date.now() + 8000;
      let successorSessionId: string | null = null;
      while (Date.now() < deadline && successorSessionId === null) {
        const snapshot = await controller.verbs.readBoardSubscribe('mock-project', { view: 'full' });
        const task = snapshot.tasks.find((candidate) => candidate.id === 'mock-task-1');
        if (task?.session_id) successorSessionId = task.session_id;
        else await new Promise((resolve) => setTimeout(resolve, 100));
      }
      expect(successorSessionId).not.toBeNull();
      expect(successorSessionId).not.toBe(MOCK_STREAMING_SESSION_ID);
    },
    12_000,
  );
});
