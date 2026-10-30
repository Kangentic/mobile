/**
 * The mock desktop's prompt wait kinds and its pause behaviour, driven through a
 * REAL ChannelController over the loopback - the exact stack the shipped demo
 * pairing and `dev:mock` run.
 *
 * Two holes these close, both invisible in every other test:
 *
 *  - Protocol 0.26.0 wait kind. A real desktop reports an AskUserQuestion wait as
 *    a `question` and a permission wait as an `approval`, on the live activity
 *    event AND on a read-stream snapshot. If the mock stops stamping either, the
 *    demo silently draws one wait mark where the app has two (the bubble and the
 *    shield), and nothing else fails.
 *  - Pause. Pausing a task takes its pending prompt with it, so the desktop's
 *    read-stream reports that prompt as `permission` pending:false (without it the
 *    paused agent's prompt card stayed answerable on the phone). And pausing a
 *    STATIC task (any live card but the streaming one) holds a later message for
 *    the task's next agent exactly as the streaming task does (protocol 0.26.0:
 *    held and answered delivered, never delivered to the dying session, never
 *    refused as unknown).
 *
 * The mock schedules its beats on `setTimeout`: the permission prompt raises at
 * the 20th second of the feed and the question prompt ten seconds after the first
 * is answered, so the clock is faked AFTER the session establishes (the handshake
 * resolves on microtasks and real timers, and must not fight a fake clock it was
 * never meant to interact with, see tests/helpers/async.ts). Loopback frames
 * deliver on `queueMicrotask`, which the fake clock leaves alone, so awaiting a
 * verb needs no timer advance. Same harness as mockDesktopCommandTerminals.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent } from '@kangentic/protocol';
import { ChannelController } from '@/channel';
import {
  createMockDesktop,
  MOCK_IDLE_STATIC_SESSION,
  staticSessionSeedTranscriptForTest,
  type MockDesktop,
} from '@/connection/mockDesktop';
import { waitUntil } from '../helpers/async';

/** The streaming task and session ids - not exported by mockDesktop.ts, so named here the same way the routing test names them. */
const MOCK_STREAMING_SESSION_ID = 'mock-session-1';
const MOCK_STREAMING_TASK_ID = 'mock-task-1';
const MOCK_PROJECT_IDS = ['mock-project', 'mock-project-relay'] as const;

/**
 * The mock raises its Bash permission prompt on the 20th feed tick (a one second
 * interval), so this clears it by half a tick. Held as a literal on purpose:
 * importing the mock's own cadence would make the case track whatever the mock says.
 */
const PERMISSION_PROMPT_RAISED_AFTER_MS = 20_500;
/** The question raises ten seconds after the permission answer lands (plus the 50 ms the clear takes). */
const QUESTION_PROMPT_RAISED_AFTER_MS = 10_500;
/** Longer than the mock's agent shutdown after a pause (1.2 s), so the session has ended. */
const PAUSE_SHUTDOWN_DONE_AFTER_MS = 1_500;

let mockDesktop: MockDesktop;
let controller: ChannelController;
let feedEvents: BridgeEvent[];

beforeEach(async () => {
  feedEvents = [];
  mockDesktop = createMockDesktop();
  controller = new ChannelController({
    identity: mockDesktop.identity,
    desktopStaticPublicKey: mockDesktop.desktopStaticPublicKey,
    relayUrl: 'loopback://prompts-and-pause-test',
    transport: mockDesktop.phoneTransport,
  });
  for (const kind of ['terminal', 'transcript', 'activity', 'board'] as const) {
    controller.feed.on(kind, (event) => feedEvents.push(event));
  }
  await controller.connect();
  await mockDesktop.start();
  await waitUntil(() => controller.session.isEstablished, { label: 'loopback session establishes' });
  vi.useFakeTimers();
});

afterEach(() => {
  // Real timers FIRST: the controller's own timers were created on the real
  // clock before the fake one was installed, and a fake clearTimeout cannot
  // clear a native timer. The mock's fake timers die with the fake clock.
  vi.useRealTimers();
  controller.dispose();
  mockDesktop.dispose();
});

function eventsFor(kind: BridgeEvent['kind'], sessionId: string): BridgeEvent[] {
  return feedEvents.filter((event) => event.kind === kind && 'sessionId' in event && event.sessionId === sessionId);
}

/** The prompt ids the session raised (`pending` true) or cleared (`pending` false), in order. */
function permissionPromptIds(sessionId: string, pending: boolean): string[] {
  return eventsFor('activity', sessionId).flatMap((event) =>
    event.kind === 'activity' && event.payload.type === 'permission' && event.payload.pending === pending ? [event.payload.promptId] : [],
  );
}

/** The `reason` of every activity event that put the session in the `permission` state, in order. */
function permissionWaitReasons(sessionId: string) {
  return eventsFor('activity', sessionId).flatMap((event) =>
    event.kind === 'activity' && event.payload.type === 'activity' && event.payload.state === 'permission' && event.payload.reason
      ? [event.payload.reason]
      : [],
  );
}

/**
 * Which tool the streaming transcript says a prompt is waiting on. A prompt id is
 * `<sessionId>:<toolUseId>` (the wire convention), so this ties each id to the
 * card the user sees (a Bash permission, an AskUserQuestion) without reading the
 * mock's own prompt constants back.
 */
async function toolNameAwaitedBy(promptId: string): Promise<string | undefined> {
  const window = await controller.verbs.readTranscriptWindow(MOCK_STREAMING_SESSION_ID);
  for (const entry of window.entries) {
    if (entry.kind !== 'assistant') continue;
    for (const block of entry.blocks) {
      if (block.type === 'tool_use' && `${MOCK_STREAMING_SESSION_ID}:${block.id}` === promptId) return block.name;
    }
  }
  return undefined;
}

/** Subscribes the streaming session (which starts the mock's feed) and lets the clock reach the permission prompt. */
async function raisePermissionPrompt(): Promise<string> {
  await controller.verbs.readStreamSubscribe(MOCK_STREAMING_SESSION_ID, { terminal: false });
  await vi.advanceTimersByTimeAsync(PERMISSION_PROMPT_RAISED_AFTER_MS);
  const raisedPromptIds = permissionPromptIds(MOCK_STREAMING_SESSION_ID, true);
  expect(raisedPromptIds, 'the mock raised exactly one prompt by now').toHaveLength(1);
  return raisedPromptIds[0];
}

/** Answers the permission prompt and lets the clock reach the AskUserQuestion that follows it. */
async function raiseQuestionPrompt(permissionPromptId: string): Promise<string> {
  await controller.verbs.answerPermissionPrompt({
    sessionId: MOCK_STREAMING_SESSION_ID,
    promptId: permissionPromptId,
    keystrokes: '1\r',
  });
  await vi.advanceTimersByTimeAsync(QUESTION_PROMPT_RAISED_AFTER_MS);
  const raisedPromptIds = permissionPromptIds(MOCK_STREAMING_SESSION_ID, true);
  expect(raisedPromptIds, 'the question followed the answered permission prompt').toHaveLength(2);
  return raisedPromptIds[1];
}

describe('prompt wait kind (protocol 0.26.0)', () => {
  it('reports the Bash permission prompt as an approval wait, on the live event and on a snapshot', async () => {
    const permissionPromptId = await raisePermissionPrompt();
    // Non-vacuity: the prompt under test IS the Bash permission card.
    await expect(toolNameAwaitedBy(permissionPromptId)).resolves.toBe('Bash');

    expect(permissionWaitReasons(MOCK_STREAMING_SESSION_ID)).toEqual([
      { kind: 'permission', since: expect.any(Number), waitKind: 'approval' },
    ]);

    // A re-subscribe taken while the prompt is pending carries the same kind.
    const snapshot = await controller.verbs.readStreamSubscribe(MOCK_STREAMING_SESSION_ID, { terminal: false });
    expect(snapshot.awaitedPromptId).toBe(permissionPromptId);
    expect(snapshot.activity.state).toBe('permission');
    expect(snapshot.activity.reason).toEqual({ kind: 'permission', since: expect.any(Number), waitKind: 'approval' });
  });

  it('reports the AskUserQuestion prompt as a question wait, on the live event and on a snapshot', async () => {
    const permissionPromptId = await raisePermissionPrompt();
    const questionPromptId = await raiseQuestionPrompt(permissionPromptId);
    // Non-vacuity: the second prompt IS the AskUserQuestion card, not another permission.
    await expect(toolNameAwaitedBy(questionPromptId)).resolves.toBe('AskUserQuestion');

    // Both waits, in order: the approval first, then the question.
    expect(permissionWaitReasons(MOCK_STREAMING_SESSION_ID)).toEqual([
      { kind: 'permission', since: expect.any(Number), waitKind: 'approval' },
      { kind: 'permission', since: expect.any(Number), waitKind: 'question' },
    ]);

    const snapshot = await controller.verbs.readStreamSubscribe(MOCK_STREAMING_SESSION_ID, { terminal: false });
    expect(snapshot.awaitedPromptId).toBe(questionPromptId);
    expect(snapshot.activity.state).toBe('permission');
    expect(snapshot.activity.reason).toEqual({ kind: 'permission', since: expect.any(Number), waitKind: 'question' });
  });
});

describe('pausing the streaming task with a prompt pending', () => {
  it('clears the pending prompt on the stream, so the paused agent\'s card is no longer answerable', async () => {
    const permissionPromptId = await raisePermissionPrompt();
    // Non-vacuity: nothing has cleared it yet, and no answer was sent, so the
    // clear below can only be the pause's doing.
    expect(permissionPromptIds(MOCK_STREAMING_SESSION_ID, false)).toEqual([]);

    await expect(controller.verbs.pauseSession({ taskId: MOCK_STREAMING_TASK_ID, projectId: 'mock-project' })).resolves.toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(10);

    expect(permissionPromptIds(MOCK_STREAMING_SESSION_ID, false)).toEqual([permissionPromptId]);
  });
});

describe('pausing a static task', () => {
  const STATIC_SESSION_ID = MOCK_IDLE_STATIC_SESSION.sessionId;
  const STATIC_TASK_ID = MOCK_IDLE_STATIC_SESSION.taskId;

  async function projectHolding(taskId: string): Promise<string> {
    for (const projectId of MOCK_PROJECT_IDS) {
      const snapshot = await controller.verbs.readBoardSubscribe(projectId, { view: 'full' });
      if (snapshot.tasks.some((task) => task.id === taskId)) return projectId;
    }
    throw new Error(`no board holds ${taskId}`);
  }

  async function pauseStaticTask(): Promise<void> {
    const projectId = await projectHolding(STATIC_TASK_ID);
    await expect(controller.verbs.pauseSession({ taskId: STATIC_TASK_ID, projectId })).resolves.toEqual({ ok: true });
  }

  it('holds a message sent while its agent is shutting down, rather than delivering it to the dying session', async () => {
    const seedLength = staticSessionSeedTranscriptForTest(MOCK_IDLE_STATIC_SESSION).length;
    const windowBeforePause = await controller.verbs.readTranscriptWindow(STATIC_SESSION_ID);
    expect(windowBeforePause.totalEntries).toBe(seedLength);

    await pauseStaticTask();
    // The agent is still shutting down: its session has not ended, and the mock
    // still holds the live conversation. Only the held-message check stands
    // between this send and that transcript.
    expect(eventsFor('activity', STATIC_SESSION_ID).some((event) => event.kind === 'activity' && event.payload.type === 'session-ended')).toBe(false);

    await expect(controller.verbs.sendUserMessage(STATIC_SESSION_ID, 'Lower the cap to 3.')).resolves.toEqual({ delivered: true });
    await vi.advanceTimersByTimeAsync(10);

    // Held, not delivered: the conversation gained nothing, on the window and on the feed.
    const windowAfterSend = await controller.verbs.readTranscriptWindow(STATIC_SESSION_ID);
    expect(windowAfterSend.totalEntries).toBe(windowBeforePause.totalEntries);
    expect(windowAfterSend.revision).toBe(windowBeforePause.revision);
    expect(eventsFor('transcript', STATIC_SESSION_ID)).toHaveLength(0);
  });

  it('still holds a message once the session has ended, rather than refusing it as an unknown session', async () => {
    await pauseStaticTask();
    await vi.advanceTimersByTimeAsync(PAUSE_SHUTDOWN_DONE_AFTER_MS);

    // Non-vacuity: the live row is really gone, so the answer below is the
    // hold and not the static session routing it used to take.
    expect(eventsFor('activity', STATIC_SESSION_ID).some((event) => event.kind === 'activity' && event.payload.type === 'session-ended')).toBe(true);
    await expect(controller.verbs.readStreamSubscribe(STATIC_SESSION_ID, { terminal: false })).rejects.toThrow(/No such session/);

    await expect(controller.verbs.sendUserMessage(STATIC_SESSION_ID, 'Lower the cap to 3.')).resolves.toEqual({ delivered: true });
    await vi.advanceTimersByTimeAsync(10);
    expect(eventsFor('transcript', STATIC_SESSION_ID)).toHaveLength(0);
  });
});
