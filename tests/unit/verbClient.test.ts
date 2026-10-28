/**
 * VerbClient: typed request payloads per verb, ok:false -> CapabilityError,
 * malformed response payloads -> CapabilityError via the protocol parsers.
 * Runs over the real loopback + stub initiator so the whole encode/seal/
 * decode path is exercised, not a mocked CapabilityClient.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  generateX25519KeyPair,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type JsonValue,
} from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { CapabilityClient, CapabilityTimeoutError } from '@/channel/capabilityClient';
import { COMMAND_TERMINAL_START_TIMEOUT_MS, CapabilityError, VerbClient } from '@/channel/verbClient';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { boardSnapshotFixture, diffFileListFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';

interface Harness {
  verbs: VerbClient;
  stub: StubSessionInitiator;
  requests: CapabilityRequestMessage[];
}

async function establishedHarness(
  respond: (request: CapabilityRequestMessage) => CapabilityResponseMessage | null,
): Promise<Harness> {
  const [phoneTransport, desktopTransport] = createLoopbackPair();
  await phoneTransport.connect();
  await desktopTransport.connect();
  const phoneIdentity = generateX25519KeyPair();
  const desktopIdentity = generateX25519KeyPair();
  const session = new SessionManager({
    identity: phoneIdentity,
    remoteStaticPublicKey: desktopIdentity.publicKey,
    transport: phoneTransport,
  });
  session.start();
  const stub = new StubSessionInitiator(desktopTransport, {
    desktopStatic: desktopIdentity,
    phoneStaticPublicKey: phoneIdentity.publicKey,
  });
  stub.beginHandshake();
  await new Promise((resolve) => setTimeout(resolve, 0));

  const requests: CapabilityRequestMessage[] = [];
  stub.setRequestHandler((request) => {
    requests.push(request);
    return respond(request);
  });
  return { verbs: new VerbClient(new CapabilityClient(session)), stub, requests };
}

function okResponse(request: CapabilityRequestMessage, payload: JsonValue): CapabilityResponseMessage {
  return { type: 'capability-response', requestId: request.requestId, ok: true, payload };
}

describe('VerbClient', () => {
  it('readStreamSubscribe sends the typed payload and parses the snapshot', async () => {
    const snapshot = streamSnapshotFixture({ awaitedPromptId: 'sess-1:tool-1' });
    const { verbs, requests } = await establishedHarness((request) => okResponse(request, snapshot as unknown as JsonValue));

    const parsed = await verbs.readStreamSubscribe('sess-1');

    expect(requests[0].verb).toBe('read-stream');
    expect(requests[0].payload).toEqual({ sessionId: 'sess-1', action: 'subscribe' });
    expect(parsed.scrollback).toBe('initial scrollback');
    expect(parsed.awaitedPromptId).toBe('sess-1:tool-1');
    expect(parsed.activity.state).toBe('thinking');
  });

  it('throws CapabilityError carrying the desktop error on ok:false', async () => {
    const { verbs } = await establishedHarness((request) => ({
      type: 'capability-response',
      requestId: request.requestId,
      ok: false,
      error: 'No such session: sess-ghost',
    }));

    await expect(verbs.readStreamSubscribe('sess-ghost')).rejects.toThrowError(CapabilityError);
    await expect(verbs.readStreamSubscribe('sess-ghost')).rejects.toThrow(/No such session/);
  });

  /**
   * The refusal's stable key rides the error, end to end through the loopback
   * encode and decode, so a caller can tell a refusal that means "the target
   * still exists" (`response-too-large`, protocol 0.19.0) from one that may
   * mean it is gone. Before this, requireOk kept only the message and every
   * refusal read the same.
   *
   * Mutation seen failing: dropping `response.code` from requireOk's
   * CapabilityError - "expected undefined to be 'response-too-large'".
   */
  it('carries the response code on the CapabilityError, and none when the refusal has no code', async () => {
    const { verbs } = await establishedHarness((request) => {
      const payload = request.payload as { sessionId?: string };
      if (payload.sessionId === 'sess-huge') {
        return {
          type: 'capability-response',
          requestId: request.requestId,
          ok: false,
          error: 'Response too large to send',
          code: 'response-too-large',
        };
      }
      return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'No such session: sess-ghost' };
    });

    const tooLarge = await verbs.readStreamSubscribe('sess-huge').catch((error: unknown) => error);
    expect(tooLarge).toBeInstanceOf(CapabilityError);
    expect((tooLarge as CapabilityError).code).toBe('response-too-large');
    expect((tooLarge as CapabilityError).message).toBe('Response too large to send');

    const codeless = await verbs.readStreamSubscribe('sess-ghost').catch((error: unknown) => error);
    expect(codeless).toBeInstanceOf(CapabilityError);
    expect((codeless as CapabilityError).code).toBeUndefined();
  });

  it('throws CapabilityError when a response payload fails its parse guard', async () => {
    const { verbs } = await establishedHarness((request) => okResponse(request, { scrollback: 42 }));
    await expect(verbs.readStreamSubscribe('sess-1')).rejects.toThrow(/scrollback/);
  });

  it('readProjectList and readBoardSubscribe discriminate list vs snapshot', async () => {
    const snapshot = boardSnapshotFixture();
    const { verbs, requests } = await establishedHarness((request) => {
      const payload = request.payload as { projectId?: string };
      return okResponse(
        request,
        payload.projectId ? (snapshot as unknown as JsonValue) : { projects: [{ id: 'project-1', name: 'Alpha' }] },
      );
    });

    const projectList = await verbs.readProjectList();
    expect(projectList.projects).toEqual([{ id: 'project-1', name: 'Alpha' }]);
    expect(requests[0].payload).toEqual({});

    const board = await verbs.readBoardSubscribe('project-1', { view: 'sessions' });
    expect(requests[1].payload).toEqual({ projectId: 'project-1', action: 'subscribe', view: 'sessions' });
    expect(board.projectId).toBe('project-1');
    expect(board.tasks).toHaveLength(1);
  });

  it('readDiffFileList vs readDiffFileContent discriminate on "files"', async () => {
    const fileList = diffFileListFixture();
    const { verbs, requests } = await establishedHarness((request) => {
      const payload = request.payload as { filePath?: string };
      return okResponse(
        request,
        payload.filePath
          ? { original: 'old', modified: 'new', language: 'typescript' }
          : (fileList as unknown as JsonValue),
      );
    });

    const list = await verbs.readDiffFileList({ taskId: 'task-1', projectId: 'project-1', scope: 'working' });
    expect(list.files).toHaveLength(2);
    expect(requests[0].payload).toEqual({ taskId: 'task-1', projectId: 'project-1', scope: 'working' });

    const content = await verbs.readDiffFileContent({ taskId: 'task-1', projectId: 'project-1', filePath: 'src/auth/login.ts' });
    expect(content).toEqual({ original: 'old', modified: 'new', language: 'typescript' });
  });

  it('writeInteractiveTerminal sends a write-action payload (the phone never resizes the desktop)', async () => {
    const { verbs, requests } = await establishedHarness((request) => okResponse(request, { written: true }));

    await expect(verbs.writeInteractiveTerminal('sess-1', 'ls\r')).resolves.toEqual({ written: true });
    expect(requests[0].verb).toBe('interactive-terminal');
    expect(requests[0].payload).toEqual({ sessionId: 'sess-1', action: 'write', data: 'ls\r' });
  });

  it('write verbs send their typed payloads and parse boolean results', async () => {
    const { verbs, requests } = await establishedHarness((request) => {
      switch (request.verb) {
        case 'send-user-message':
          return okResponse(request, { delivered: true });
        case 'move-task':
          return okResponse(request, { ok: true });
        case 'answer-permission-prompt':
          return okResponse(request, { answered: true });
        case 'interactive-terminal':
          return okResponse(request, { written: true });
        default:
          return okResponse(request, { result: { created: 'task-2' } });
      }
    });

    await expect(verbs.sendUserMessage('sess-1', 'keep going')).resolves.toEqual({ delivered: true });
    await expect(
      verbs.moveTask({ taskId: 'task-1', targetSwimlaneId: 'lane-doing', targetPosition: 0, projectId: 'project-1' }),
    ).resolves.toEqual({ ok: true });
    await expect(
      verbs.answerPermissionPrompt({ sessionId: 'sess-1', promptId: 'sess-1:tool-1', keystrokes: '1\r' }),
    ).resolves.toEqual({ answered: true });
    await expect(verbs.writeInteractiveTerminal('sess-1', '\x1b')).resolves.toEqual({ written: true });
    await expect(verbs.boardToolWrite('create_task', { title: 'New', description: '', column: 'To Do' })).resolves.toEqual({
      created: 'task-2',
    });

    expect(requests.map((request) => request.verb)).toEqual([
      'send-user-message',
      'move-task',
      'answer-permission-prompt',
      'interactive-terminal',
      'board-tool-write',
    ]);
    expect(requests[4].payload).toEqual({ tool: 'create_task', params: { title: 'New', description: '', column: 'To Do' } });
  });

  /**
   * The desktop forwards a board tool's `data` as `result`, and pausing or
   * resuming a workflow returns none, so their success reaches the phone as
   * `{}`. Read strictly, every successful pause would show as a failure.
   */
  it('accepts a workflow pause or resume whose success carries no result', async () => {
    const { verbs } = await establishedHarness((request) => okResponse(request, {}));

    await expect(verbs.boardToolWrite('pause_workflow', { project: 'project-1', workflow: 'workflow-1' })).resolves.toBeNull();
    await expect(verbs.boardToolWrite('resume_workflow', { project: 'project-1', workflow: 'workflow-1' })).resolves.toBeNull();
  });

  it('still refuses any other board-tool write that carries no result', async () => {
    const { verbs } = await establishedHarness((request) => okResponse(request, {}));

    await expect(verbs.boardToolWrite('create_task', { title: 'New', description: '', column: 'To Do' })).rejects.toBeInstanceOf(
      CapabilityError,
    );
  });

  /**
   * move-task is the one verb whose answer waits on real desktop work rather
   * than a lookup. An older desktop awaits the whole of handleTaskMove - PTY
   * suspend, worktree removal, respawn - and 9% of measured task:move calls ran
   * past the shared 10s default, slowest 24.4s. Those rejected as a plain
   * timeout, which MoveTaskScreen shows as "Move failed - check the
   * connection" while moveTaskOptimistic rolls the card back, for a move the
   * desktop had already committed.
   */
  it('gives move-task a longer timeout than every other verb', async () => {
    // Harness first, on real timers: the handshake flush needs them.
    const { verbs } = await establishedHarness(() => null); // the desktop never answers
    vi.useFakeTimers();
    try {
      const moveSettled = verbs
        .moveTask({ taskId: 'task-1', targetSwimlaneId: 'lane-doing', targetPosition: 0, projectId: 'project-1' })
        .then(() => 'resolved', () => 'rejected');
      const messageSettled = verbs.sendUserMessage('sess-1', 'keep going').then(() => 'resolved', () => 'rejected');
      let moveHasSettled = false;
      void moveSettled.then(() => {
        moveHasSettled = true;
      });

      // Past the shared default: the ordinary verb is already gone.
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(messageSettled).resolves.toBe('rejected');
      expect(moveHasSettled).toBe(false);

      // And past the measured desktop tail it does eventually give up, rather
      // than hanging forever.
      await vi.advanceTimersByTimeAsync(40_000);
      await expect(moveSettled).resolves.toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * `get_task_report` can wait on the desktop's index (up to 8 s) before it
   * reads git, so the completed task Summary asks for it with its own 20 s
   * bound (`TASK_REPORT_TIMEOUT_MS`). `boardToolRead` has to carry that option
   * through `requireOk` to the capability client, or the read gives up at the
   * shared 10 s default and the Summary falls back to the poorer `find_task`
   * for a report the desktop was still assembling. A call with no options must
   * keep the default, so no other board read quietly waits twice as long.
   *
   * Mutation seen failing: dropping `, options` from the `requireOk` call in
   * `boardToolRead` - the optioned read has already rejected at 11 s.
   */
  it('boardToolRead gives a read its own timeout, and a read with no options still gives up at the default', async () => {
    const reportTimeoutMs = 20_000;
    // Harness first, on real timers: the handshake flush needs them.
    const { verbs } = await establishedHarness(() => null); // the desktop never answers
    vi.useFakeTimers();
    try {
      const readParams = { project: 'project-1', taskId: 'task-1' };
      const optionedSettled = verbs.boardToolRead('get_task_report', readParams, { timeoutMs: reportTimeoutMs }).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      const defaultSettled = verbs.boardToolRead('get_task_report', readParams).then(
        () => 'resolved',
        (error: unknown) => error,
      );
      let optionedHasSettled = false;
      void optionedSettled.then(() => {
        optionedHasSettled = true;
      });

      // Past the shared default: the read with no options is already gone, as a timeout.
      await vi.advanceTimersByTimeAsync(11_000);
      await expect(defaultSettled).resolves.toBeInstanceOf(CapabilityTimeoutError);
      expect(optionedHasSettled).toBe(false);

      // The last millisecond before its own bound: still waiting.
      await vi.advanceTimersByTimeAsync(reportTimeoutMs - 11_000 - 1);
      expect(optionedHasSettled).toBe(false);

      // And at the bound it gives up as a timeout, rather than hanging forever.
      await vi.advanceTimersByTimeAsync(1);
      await expect(optionedSettled).resolves.toBeInstanceOf(CapabilityTimeoutError);
    } finally {
      vi.useRealTimers();
    }
  });

  it('registerPush sends the typed registration payload and parses the boolean result', async () => {
    const { verbs, requests } = await establishedHarness((request) => okResponse(request, { registered: true }));

    const pushKeyBase64 = 'a'.repeat(43);
    await expect(
      verbs.registerPush({ action: 'register', expoPushToken: 'ExponentPushToken[test]', pushKeyBase64, platform: 'android' }),
    ).resolves.toEqual({ registered: true });
    expect(requests[0].verb).toBe('register-push');
    expect(requests[0].payload).toEqual({
      action: 'register',
      expoPushToken: 'ExponentPushToken[test]',
      pushKeyBase64,
      platform: 'android',
    });
  });

  it('registerPush rejects a response missing the registered flag', async () => {
    const { verbs } = await establishedHarness((request) => okResponse(request, { ok: true }));
    await expect(verbs.registerPush({ action: 'unregister' })).rejects.toThrow(/registered/);
  });

  /**
   * start-session is keyed by TASK (the session it resumes has already ended, so
   * there is no session id to name), and the desktop answers on ACCEPT with which
   * of two accepted shapes it was. Both outcomes parse; the caller decides what
   * each means.
   */
  it.each(['starting', 'live'] as const)('startSession sends the task-keyed payload and parses the "%s" outcome', async (outcome) => {
    const { verbs, requests } = await establishedHarness((request) => okResponse(request, { ok: true, outcome }));

    await expect(verbs.startSession({ taskId: 'task-1', projectId: 'project-1' })).resolves.toEqual({ ok: true, outcome });

    expect(requests).toHaveLength(1);
    expect(requests[0].verb).toBe('start-session');
    expect(requests[0].payload).toEqual({ taskId: 'task-1', projectId: 'project-1' });
  });

  it('startSession throws CapabilityError carrying the desktop\'s own refusal on ok:false', async () => {
    const { verbs } = await establishedHarness((request) => ({
      type: 'capability-response',
      requestId: request.requestId,
      ok: false,
      error: 'Cannot resume a task in To Do',
    }));

    // The desktop's text specifically, not just the class: a request that skipped
    // the ok check would still throw a CapabilityError, about a missing payload.
    await expect(verbs.startSession({ taskId: 'task-1', projectId: 'project-1' })).rejects.toThrowError(CapabilityError);
    await expect(verbs.startSession({ taskId: 'task-1', projectId: 'project-1' })).rejects.toThrow(/^Cannot resume a task in To Do$/);
    await expect(verbs.startSession({ taskId: 'task-1', projectId: 'project-1' })).rejects.toMatchObject({ verb: 'start-session' });
  });

  it.each([
    ['an outcome the protocol does not define', { ok: true, outcome: 'spawned' }, /outcome/],
    ['no outcome at all', { ok: true }, /outcome/],
    ['no ok flag', { outcome: 'live' }, /ok/],
    ['an ok flag that is not a boolean', { ok: 'yes', outcome: 'live' }, /ok/],
  ])('startSession throws CapabilityError for a response with %s', async (_description, payload, expectedMessage) => {
    const { verbs } = await establishedHarness((request) => okResponse(request, payload));

    await expect(verbs.startSession({ taskId: 'task-1', projectId: 'project-1' })).rejects.toThrowError(CapabilityError);
    await expect(verbs.startSession({ taskId: 'task-1', projectId: 'project-1' })).rejects.toThrow(expectedMessage);
  });

  /**
   * pause-session (protocol 0.18.0): keyed by task, never by session id, and
   * answered on ACCEPT with `{ ok }`. The paused row itself arrives later as a
   * board event, so the response carries nothing else.
   */
  it('pauseSession sends the task-keyed payload and parses the accept', async () => {
    const { verbs, requests } = await establishedHarness((request) => okResponse(request, { ok: true }));

    await expect(verbs.pauseSession({ taskId: 'task-1', projectId: 'project-1' })).resolves.toEqual({ ok: true });

    expect(requests).toHaveLength(1);
    expect(requests[0].verb).toBe('pause-session');
    expect(requests[0].payload).toEqual({ taskId: 'task-1', projectId: 'project-1' });
  });

  it('pauseSession throws CapabilityError carrying the desktop\'s own refusal on ok:false', async () => {
    const { verbs } = await establishedHarness((request) => ({
      type: 'capability-response',
      requestId: request.requestId,
      ok: false,
      error: 'This task has no running session to pause.',
    }));

    await expect(verbs.pauseSession({ taskId: 'task-1', projectId: 'project-1' })).rejects.toThrow(/^This task has no running session to pause\.$/);
    await expect(verbs.pauseSession({ taskId: 'task-1', projectId: 'project-1' })).rejects.toMatchObject({ verb: 'pause-session' });
  });

  it('pauseSession throws CapabilityError for a response with no ok flag', async () => {
    const { verbs } = await establishedHarness((request) => okResponse(request, {}));

    await expect(verbs.pauseSession({ taskId: 'task-1', projectId: 'project-1' })).rejects.toThrowError(CapabilityError);
  });

  /**
   * command-terminal (protocol 0.20.0): `start` names only the project and the
   * desktop answers with the new terminal's session, slot and name; `stop`
   * names the session. One verb, two actions.
   */
  describe('command-terminal', () => {
    const startedPayload = { ok: true, sessionId: 'sess-terminal-1', slot: 2, name: 'Command Terminal 2' };

    it('startCommandTerminal sends the start action for the project and parses the answer', async () => {
      const { verbs, requests } = await establishedHarness((request) => okResponse(request, startedPayload));

      await expect(verbs.startCommandTerminal('project-1')).resolves.toEqual(startedPayload);

      expect(requests).toHaveLength(1);
      expect(requests[0].verb).toBe('command-terminal');
      expect(requests[0].payload).toEqual({ action: 'start', projectId: 'project-1' });
    });

    /**
     * A start waits on the desktop's git steps on the project folder (a 6 s
     * budget) before the session exists, which is most of the shared 10 s
     * default before a relay round trip, so it gets its own longer timeout. A
     * start that read as a failure at 10 s would show "didn't answer" for a
     * terminal that was in fact starting.
     *
     * Mutation seen failing: dropping `{ timeoutMs: COMMAND_TERMINAL_START_TIMEOUT_MS }`
     * from startCommandTerminal - the start has already rejected at 11 s.
     */
    it('gives a start a longer timeout than the shared default, and still gives up at it', async () => {
      // Harness first, on real timers: the handshake flush needs them.
      const { verbs } = await establishedHarness(() => null); // the desktop never answers
      vi.useFakeTimers();
      try {
        const startSettled = verbs.startCommandTerminal('project-1').then(
          () => 'resolved',
          (error: unknown) => error,
        );
        const stopSettled = verbs.stopCommandTerminal('sess-terminal-1').then(
          () => 'resolved',
          () => 'rejected',
        );
        let startHasSettled = false;
        void startSettled.then(() => {
          startHasSettled = true;
        });

        // Past the shared default: an ordinary verb, the stop, is already gone.
        await vi.advanceTimersByTimeAsync(11_000);
        await expect(stopSettled).resolves.toBe('rejected');
        expect(startHasSettled).toBe(false);

        // The last millisecond before its own bound: still waiting.
        await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_START_TIMEOUT_MS - 11_000 - 1);
        expect(startHasSettled).toBe(false);

        // And at the bound it gives up as a timeout, rather than hanging forever.
        await vi.advanceTimersByTimeAsync(1);
        await expect(startSettled).resolves.toBeInstanceOf(CapabilityTimeoutError);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(['command-terminal-limit', 'unknown-project', 'agent-unavailable', 'command-terminal-start-failed', 'unsupported-verb'] as const)(
      'startCommandTerminal surfaces the refusal code %s on the CapabilityError',
      async (code) => {
        const { verbs } = await establishedHarness((request) => ({
          type: 'capability-response',
          requestId: request.requestId,
          ok: false,
          error: 'The desktop said no',
          code,
        }));

        const refusal = await verbs.startCommandTerminal('project-1').catch((error: unknown) => error);

        expect(refusal).toBeInstanceOf(CapabilityError);
        expect((refusal as CapabilityError).code).toBe(code);
        expect((refusal as CapabilityError).verb).toBe('command-terminal');
        expect((refusal as CapabilityError).message).toBe('The desktop said no');
      },
    );

    it.each([
      ['no session id', { ok: true, slot: 1, name: 'Command Terminal 1' }],
      ['no slot', { ok: true, sessionId: 'sess-1', name: 'Command Terminal 1' }],
      ['no ok flag', { sessionId: 'sess-1', slot: 1, name: 'Command Terminal 1' }],
    ])('startCommandTerminal throws CapabilityError for a response with %s', async (_label, payload) => {
      const { verbs } = await establishedHarness((request) => okResponse(request, payload));

      await expect(verbs.startCommandTerminal('project-1')).rejects.toThrowError(CapabilityError);
    });

    it('stopCommandTerminal sends the stop action for the session and resolves on the accept', async () => {
      const { verbs, requests } = await establishedHarness((request) => okResponse(request, { ok: true }));

      await expect(verbs.stopCommandTerminal('sess-terminal-1')).resolves.toBeUndefined();

      expect(requests).toHaveLength(1);
      expect(requests[0].verb).toBe('command-terminal');
      expect(requests[0].payload).toEqual({ action: 'stop', sessionId: 'sess-terminal-1' });
    });

    it.each(['unknown-session', 'not-command-terminal'] as const)('stopCommandTerminal surfaces the refusal code %s', async (code) => {
      const { verbs } = await establishedHarness((request) => ({
        type: 'capability-response',
        requestId: request.requestId,
        ok: false,
        error: 'Refused',
        code,
      }));

      await expect(verbs.stopCommandTerminal('sess-terminal-1')).rejects.toMatchObject({ verb: 'command-terminal', code });
    });

    it('stopCommandTerminal throws CapabilityError for an answer that is not ok:true', async () => {
      const { verbs } = await establishedHarness((request) => okResponse(request, {}));

      await expect(verbs.stopCommandTerminal('sess-terminal-1')).rejects.toThrowError(CapabilityError);
    });
  });

  /**
   * A project-folder diff (protocol 0.20.0, a Command Terminal's Changes) is
   * told from a task's by the ABSENCE of `taskId` on the wire. `toEqual` treats
   * a missing key and an undefined one as the same, and the loopback's JSON
   * round trip drops undefined, so the assertion that can fail is on the
   * property itself: the regression to catch is `taskId: null` reaching the
   * desktop, which reads a present key as a task id.
   *
   * Mutation seen failing: replacing the conditional spread with
   * `taskId: input.taskId` in readDiffFileList - the key is present, holding null.
   */
  describe('a project-folder diff (taskId null)', () => {
    function diffRespond(request: CapabilityRequestMessage): CapabilityResponseMessage {
      const payload = request.payload as { filePath?: string; action?: string };
      if (payload.action === 'unsubscribe') return { type: 'capability-response', requestId: request.requestId, ok: true };
      return okResponse(
        request,
        payload.filePath !== undefined
          ? { original: 'old', modified: 'new', language: 'typescript' }
          : (diffFileListFixture() as unknown as JsonValue),
      );
    }

    function ownKeys(request: CapabilityRequestMessage): string[] {
      return Object.keys(request.payload as object).sort();
    }

    it('readDiffFileList omits the taskId key and names the project', async () => {
      const { verbs, requests } = await establishedHarness(diffRespond);

      await verbs.readDiffFileList({ taskId: null, projectId: 'project-1', scope: 'working' });

      expect(Object.hasOwn(requests[0].payload as object, 'taskId')).toBe(false);
      expect(requests[0].payload).toEqual({ projectId: 'project-1', scope: 'working' });
    });

    it('readDiffFileContent omits the taskId key and names the project and the file', async () => {
      const { verbs, requests } = await establishedHarness(diffRespond);

      await verbs.readDiffFileContent({ taskId: null, projectId: 'project-1', filePath: 'src/a.ts', scope: 'branch' });

      expect(Object.hasOwn(requests[0].payload as object, 'taskId')).toBe(false);
      expect(requests[0].payload).toEqual({ projectId: 'project-1', filePath: 'src/a.ts', scope: 'branch' });
    });

    it('readDiffUnsubscribe omits the taskId key and names the project', async () => {
      const { verbs, requests } = await establishedHarness(diffRespond);

      await verbs.readDiffUnsubscribe({ taskId: null, projectId: 'project-1' });

      expect(Object.hasOwn(requests[0].payload as object, 'taskId')).toBe(false);
      expect(requests[0].payload).toEqual({ projectId: 'project-1', action: 'unsubscribe' });
    });

    it('still sends a task\'s taskId on all three (the control)', async () => {
      const { verbs, requests } = await establishedHarness(diffRespond);

      await verbs.readDiffFileList({ taskId: 'task-1', projectId: 'project-1' });
      await verbs.readDiffFileContent({ taskId: 'task-1', projectId: 'project-1', filePath: 'src/a.ts' });
      await verbs.readDiffUnsubscribe({ taskId: 'task-1', projectId: 'project-1' });

      expect(requests.map(ownKeys)).toEqual([
        ['projectId', 'taskId'],
        ['filePath', 'projectId', 'taskId'],
        ['action', 'projectId', 'taskId'],
      ]);
    });
  });
});
