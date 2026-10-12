/**
 * The mock desktop's Command Terminals (protocol 0.20.0), driven through a REAL
 * ChannelController over the loopback - the exact stack the shipped demo pairing
 * and `dev:mock` run, so a reviewer who taps New on the Board's Terminals button
 * meets what these cases pin.
 *
 * The mock mirrors the desktop's `command-terminal` handler and the terminal
 * lifecycle around it (decision C2: a terminal ends with its agent, and the board
 * drops it in the same edge). The expectations below come from the protocol
 * docs and the desktop's contract, not from reading the mock back:
 *
 *  - a start names only the project, is answered with the session, slot and name
 *    the moment it exists, and is refused with a typed code at four per project;
 *  - the agent "arrives" a beat later: until then the terminal's activity is
 *    null, which is what holds the phone's input;
 *  - there is no transcript record for a terminal, and no task, so the diff
 *    verb answers about the project folder when it names no task;
 *  - the first prompt names the terminal; `/exit` and Stop end it, both
 *    intentional (a deliberate end must never read as a failure).
 *
 * The mock schedules its beats on `setTimeout`, so the clock is faked AFTER the
 * session establishes (the handshake resolves on microtasks and real timers, and
 * must not fight a fake clock it was never meant to interact with, see
 * tests/helpers/async.ts). Loopback frames deliver on `queueMicrotask`, which the
 * fake clock leaves alone, so awaiting a verb needs no timer advance.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeEvent, CapabilityErrorCode, CommandTerminalWire } from '@kangentic/protocol';
import { CapabilityError, ChannelController } from '@/channel';
import { createMockDesktop, MOCK_IDLE_STATIC_SESSION, type MockDesktop } from '@/connection/mockDesktop';
import { waitUntil } from '../helpers/async';

const MOCK_PROJECT_ID = 'mock-project';
/** The second project's real id (probed from the fixtures, not guessed): the checkout-api board. */
const MOCK_PROJECT_2_ID = 'mock-project-relay';
/** The streaming task's session id - not exported by mockDesktop.ts, so named here the same way the routing test does. */
const MOCK_STREAMING_SESSION_ID = 'mock-session-1';

/**
 * The desktop's per-project cap (MAX_COMMAND_TERMINALS, owned by protocol 0.20.0).
 * Held as a literal on purpose: importing the mock's own constant would make the
 * "fifth is refused" case track whatever the mock says.
 */
const COMMAND_TERMINAL_LIMIT = 4;

let mockDesktop: MockDesktop;
let controller: ChannelController;
let feedEvents: BridgeEvent[];

beforeEach(async () => {
  feedEvents = [];
  mockDesktop = createMockDesktop();
  controller = new ChannelController({
    identity: mockDesktop.identity,
    desktopStaticPublicKey: mockDesktop.desktopStaticPublicKey,
    relayUrl: 'loopback://command-terminal-test',
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

function sessionEndedEventsFor(sessionId: string): BridgeEvent[] {
  return eventsFor('activity', sessionId).filter((event) => event.kind === 'activity' && event.payload.type === 'session-ended');
}

function commandTerminalsChangedEvents(projectId: string): BridgeEvent[] {
  return feedEvents.filter(
    (event) => event.kind === 'board' && event.projectId === projectId && event.payload.change === 'command-terminals-changed',
  );
}

/** The refusal's typed code, or a loud failure when the call was NOT refused. */
async function refusalCodeOf(call: Promise<unknown>): Promise<CapabilityErrorCode | undefined> {
  try {
    await call;
  } catch (error) {
    if (error instanceof CapabilityError) return error.code;
    throw error;
  }
  throw new Error('expected the desktop to refuse this call, but it was accepted');
}

async function startTerminal(projectId: string = MOCK_PROJECT_ID) {
  return controller.verbs.startCommandTerminal(projectId);
}

/** What the project's board lists as its Command Terminals right now, from a fresh snapshot. */
async function listedTerminals(projectId: string = MOCK_PROJECT_ID): Promise<CommandTerminalWire[]> {
  const snapshot = await controller.verbs.readBoardSubscribe(projectId, { view: 'sessions' });
  return snapshot.commandTerminals ?? [];
}

/** Lets the mock's agent "arrive" (its first activity), without caring by how much it was late. */
async function letAgentArrive(): Promise<void> {
  await vi.advanceTimersByTimeAsync(5_000);
}

describe('board snapshots', () => {
  it.each([MOCK_PROJECT_ID, MOCK_PROJECT_2_ID])('list no terminals and offer them on both views of %s', async (projectId) => {
    for (const view of ['full', 'sessions'] as const) {
      const snapshot = await controller.verbs.readBoardSubscribe(projectId, { view });
      expect(snapshot.commandTerminals, `${projectId} ${view} commandTerminals`).toEqual([]);
      expect(snapshot.commandTerminalsOffered, `${projectId} ${view} commandTerminalsOffered`).toBe(true);
    }
  });

  it('lists a started terminal on its own project only, in slot order', async () => {
    const first = await startTerminal(MOCK_PROJECT_ID);
    const second = await startTerminal(MOCK_PROJECT_ID);
    const elsewhere = await startTerminal(MOCK_PROJECT_2_ID);

    const listed = await listedTerminals(MOCK_PROJECT_ID);
    expect(listed.map((terminal) => terminal.sessionId)).toEqual([first.sessionId, second.sessionId]);
    expect(listed.map((terminal) => terminal.slot)).toEqual([1, 2]);
    expect(listed.every((terminal) => terminal.projectId === MOCK_PROJECT_ID)).toBe(true);
    expect((await listedTerminals(MOCK_PROJECT_2_ID)).map((terminal) => terminal.sessionId)).toEqual([elsewhere.sessionId]);
  });
});

describe('command-terminal start', () => {
  it('answers the session, the lowest free slot and the default name, a second one slot 2', async () => {
    const first = await startTerminal();
    expect(first).toEqual({ ok: true, sessionId: expect.any(String), slot: 1, name: 'Command Terminal 1' });
    expect(first.sessionId.length).toBeGreaterThan(0);

    const second = await startTerminal();
    expect(second).toEqual({ ok: true, sessionId: expect.any(String), slot: 2, name: 'Command Terminal 2' });
    expect(second.sessionId).not.toBe(first.sessionId);
    // A terminal is its own session, never one of the task sessions on the board.
    expect([first.sessionId, second.sessionId]).not.toContain(MOCK_STREAMING_SESSION_ID);
  });

  it('refuses a fifth terminal in the same project with command-terminal-limit', async () => {
    for (let started = 0; started < COMMAND_TERMINAL_LIMIT; started += 1) await startTerminal();

    expect(await refusalCodeOf(startTerminal())).toBe('command-terminal-limit');
    // The refusal started nothing: still exactly four listed.
    expect(await listedTerminals()).toHaveLength(COMMAND_TERMINAL_LIMIT);
  });

  it('counts the cap per project: a full project does not block the other one', async () => {
    for (let started = 0; started < COMMAND_TERMINAL_LIMIT; started += 1) await startTerminal(MOCK_PROJECT_ID);

    const elsewhere = await startTerminal(MOCK_PROJECT_2_ID);

    expect(elsewhere.slot).toBe(1);
    expect(elsewhere.name).toBe('Command Terminal 1');
  });

  it('hands a freed slot to the next start, lowest first, once the limit lifts', async () => {
    const terminals = [];
    for (let started = 0; started < COMMAND_TERMINAL_LIMIT; started += 1) terminals.push(await startTerminal());
    expect(await refusalCodeOf(startTerminal())).toBe('command-terminal-limit');

    await controller.verbs.stopCommandTerminal(terminals[1].sessionId);
    const replacement = await startTerminal();

    expect(replacement.slot).toBe(2);
    expect(replacement.name).toBe('Command Terminal 2');
  });

  it('refuses an unknown project with unknown-project, and starts nothing', async () => {
    expect(await refusalCodeOf(startTerminal('no-such-project'))).toBe('unknown-project');
    expect(await listedTerminals()).toEqual([]);
  });

  it('announces the start with a command-terminals-changed board event naming the session', async () => {
    const started = await startTerminal();
    await vi.advanceTimersByTimeAsync(200);

    const announced = commandTerminalsChangedEvents(MOCK_PROJECT_ID);
    expect(announced).toHaveLength(1);
    const [announcement] = announced;
    expect(announcement.kind === 'board' && announcement.payload.ids).toEqual([started.sessionId]);
  });
});

describe('the terminal\'s agent arriving', () => {
  it('reports no activity at all until it arrives, then idle, on the stream snapshot and the board listing', async () => {
    const started = await startTerminal();
    await vi.advanceTimersByTimeAsync(100);

    const early = await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: false });
    expect(early.activity).toEqual({ state: null, reason: null });
    expect((await listedTerminals())[0].activity).toEqual({ state: null, reason: null });

    await letAgentArrive();

    const arrived = await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: false });
    expect(arrived.activity.state).toBe('idle');
    expect(arrived.activity.reason?.kind).toBe('idle');
    expect((await listedTerminals())[0].activity.state).toBe('idle');
  });

  it('pushes the first activity event only on arrival, stamped with a made-up task id that names no board row', async () => {
    const started = await startTerminal();
    await vi.advanceTimersByTimeAsync(100);
    expect(eventsFor('activity', started.sessionId)).toHaveLength(0);

    await letAgentArrive();

    const activityEvents = eventsFor('activity', started.sessionId);
    expect(activityEvents).toHaveLength(1);
    const [arrival] = activityEvents;
    if (arrival.kind !== 'activity') throw new Error(`expected an activity event, got ${arrival.kind}`);
    expect(arrival.payload.type === 'activity' && arrival.payload.state).toBe('idle');
    const boardTaskIds = [
      ...(await controller.verbs.readBoardSubscribe(MOCK_PROJECT_ID, { view: 'full' })).tasks,
      ...(await controller.verbs.readBoardSubscribe(MOCK_PROJECT_2_ID, { view: 'full' })).tasks,
    ].map((task) => task.id);
    expect(arrival.taskId.length).toBeGreaterThan(0);
    expect(boardTaskIds).not.toContain(arrival.taskId);
  });

  it('serves the opening frame on a terminal subscribe once it arrives, and nothing on a list-only one', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    const withTerminal = await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: true });
    const listOnly = await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: false });

    expect(withTerminal.scrollback).toContain('Welcome to Claude Code');
    expect(listOnly.scrollback).toBe('');
  });

  it('draws nothing for a terminal stopped before its agent arrived', async () => {
    const started = await startTerminal();
    await controller.verbs.stopCommandTerminal(started.sessionId);

    await letAgentArrive();

    expect(eventsFor('terminal', started.sessionId)).toHaveLength(0);
    // The only thing the session ever pushed is its end.
    expect(eventsFor('activity', started.sessionId)).toEqual(sessionEndedEventsFor(started.sessionId));
  });
});

describe('a terminal has no transcript and no task', () => {
  it('answers the transcript window with an empty one rather than refusing or borrowing a transcript', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    const window = await controller.verbs.readTranscriptWindow(started.sessionId);

    expect(window).toEqual({ revision: 0, totalEntries: 0, startIndex: 0, entries: [] });
  });

  it('answers a read-diff that names no task with an empty file list and zero totals, for either project', async () => {
    for (const projectId of [MOCK_PROJECT_ID, MOCK_PROJECT_2_ID]) {
      const list = await controller.verbs.readDiffFileList({ taskId: null, projectId });
      expect(list.files, `${projectId} files`).toEqual([]);
      expect(list.totalInsertions).toBe(0);
      expect(list.totalDeletions).toBe(0);
    }
  });

  it('answers a read-diff file content that names no task with an empty plaintext file', async () => {
    const content = await controller.verbs.readDiffFileContent({ taskId: null, projectId: MOCK_PROJECT_ID, filePath: 'src/anything.ts' });

    expect(content).toEqual({ original: '', modified: '', language: 'plaintext' });
  });
});

describe('read-stream unsubscribe of a terminal', () => {
  /** How many usage pushes the STREAMING task session has sent: its simulated agent only ticks while subscribed. */
  function streamingUsagePushes(): number {
    return eventsFor('activity', MOCK_STREAMING_SESSION_ID).filter(
      (event) => event.kind === 'activity' && event.payload.type === 'usage',
    ).length;
  }

  it('leaves the streaming task session subscribed and still ticking', async () => {
    await controller.verbs.readStreamSubscribe(MOCK_STREAMING_SESSION_ID, { terminal: false });
    const started = await startTerminal();
    await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: false });

    await controller.verbs.readStreamUnsubscribe(started.sessionId);
    // Usage grows every fifth one-second tick (the mock's feed), so a window
    // past that only holds a push if the streaming session is still attached.
    await vi.advanceTimersByTimeAsync(5_500);

    expect(streamingUsagePushes()).toBeGreaterThan(0);
  });

  /**
   * The control for the case above, and the reason it can fail: unsubscribing
   * the STREAMING session itself does silence its simulated agent. Without this
   * the usage assertion would hold for a mock that never ticked at all.
   */
  it('does silence the streaming session when that session itself is unsubscribed (the control)', async () => {
    await controller.verbs.readStreamSubscribe(MOCK_STREAMING_SESSION_ID, { terminal: false });
    await controller.verbs.readStreamUnsubscribe(MOCK_STREAMING_SESSION_ID);

    await vi.advanceTimersByTimeAsync(5_500);

    expect(streamingUsagePushes()).toBe(0);
  });

  it('is acknowledged, and the terminal stays listed and subscribable afterwards', async () => {
    const started = await startTerminal();
    await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: false });

    await expect(controller.verbs.readStreamUnsubscribe(started.sessionId)).resolves.toBeUndefined();

    expect((await listedTerminals()).map((terminal) => terminal.sessionId)).toEqual([started.sessionId]);
    await expect(controller.verbs.readStreamSubscribe(started.sessionId, { terminal: false })).resolves.toBeDefined();
  });
});

describe('typing into a terminal', () => {
  it('echoes the keys into that terminal only, never into the streaming session\'s feed', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    const response = await controller.verbs.writeInteractiveTerminal(started.sessionId, 'ls');
    await vi.advanceTimersByTimeAsync(10);

    expect(response.written).toBe(true);
    const typedEcho = eventsFor('terminal', started.sessionId).filter((event) => event.kind === 'terminal' && event.payload.data === 'ls');
    expect(typedEcho).toHaveLength(1);
    expect(eventsFor('terminal', MOCK_STREAMING_SESSION_ID)).toHaveLength(0);
    expect(eventsFor('terminal', MOCK_IDLE_STATIC_SESSION.sessionId)).toHaveLength(0);
  });

  it('names the terminal from its first prompt: Title Case, after a beat, and a later snapshot lists the new name', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    // Typed across two writes, then Enter: the buffer carries the line between them.
    await controller.verbs.writeInteractiveTerminal(started.sessionId, 'fix the');
    await controller.verbs.writeInteractiveTerminal(started.sessionId, ' flaky test\r');

    // Mid-turn, before the namer answers: still the default name, and busy.
    await vi.advanceTimersByTimeAsync(300);
    const [midTurn] = await listedTerminals();
    expect(midTurn.name).toBe('Command Terminal 1');
    expect(midTurn.named).toBe(false);
    expect(midTurn.activity.state).toBe('thinking');

    await vi.advanceTimersByTimeAsync(5_000);

    const [named] = await listedTerminals();
    expect(named.named).toBe(true);
    expect(named.name).toBe('Fix The Flaky Test');
    expect(named.name.length).toBeLessThanOrEqual(80);
    // The turn finished: back to idle.
    expect(named.activity.state).toBe('idle');
    const streamed = await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: true });
    expect(streamed.scrollback).toContain('Done.');
  });

  it('names a one-word first prompt too ("hello" becomes "Hello")', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    await controller.verbs.writeInteractiveTerminal(started.sessionId, 'hello\r');
    await vi.advanceTimersByTimeAsync(5_000);

    const [named] = await listedTerminals();
    expect(named.named).toBe(true);
    expect(named.name).toBe('Hello');
  });

  it('keeps a long first prompt\'s name Title Case and within the desktop\'s 80 character cap', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    await controller.verbs.writeInteractiveTerminal(
      started.sessionId,
      'please look into why the guest checkout spec waits on the settle timer and then update every related changelog entry\r',
    );
    await vi.advanceTimersByTimeAsync(5_000);

    const [named] = await listedTerminals();
    expect(named.named).toBe(true);
    expect(named.name.length).toBeLessThanOrEqual(80);
    for (const word of named.name.split(' ')) expect(word.charAt(0)).toBe(word.charAt(0).toUpperCase());
    expect(named.name).not.toBe('Command Terminal 1');
  });

  it('names it from the FIRST prompt only: a later prompt leaves the name alone', async () => {
    const started = await startTerminal();
    await letAgentArrive();
    await controller.verbs.writeInteractiveTerminal(started.sessionId, 'fix the flaky test\r');
    await vi.advanceTimersByTimeAsync(5_000);

    await controller.verbs.writeInteractiveTerminal(started.sessionId, 'now do something else entirely\r');
    await vi.advanceTimersByTimeAsync(5_000);

    const [terminal] = await listedTerminals();
    expect(terminal.name).toBe('Fix The Flaky Test');
  });

  it('names it from a prompt sent through the chat composer too (send-user-message)', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    await expect(controller.verbs.sendUserMessage(started.sessionId, 'review the migration')).resolves.toEqual({ delivered: true });
    await vi.advanceTimersByTimeAsync(5_000);

    const [named] = await listedTerminals();
    expect(named.name).toBe('Review The Migration');
    expect(named.named).toBe(true);
  });

  it('announces a rename, and only starts, ends and renames, never an activity change', async () => {
    const started = await startTerminal();
    await letAgentArrive();
    // Start only so far. The agent arriving (activity idle) announced nothing.
    expect(commandTerminalsChangedEvents(MOCK_PROJECT_ID)).toHaveLength(1);

    await controller.verbs.writeInteractiveTerminal(started.sessionId, 'fix the flaky test\r');
    await vi.advanceTimersByTimeAsync(5_000);

    // The turn went thinking and back to idle (two activity changes), and the
    // rename announced exactly once more.
    expect(commandTerminalsChangedEvents(MOCK_PROJECT_ID)).toHaveLength(2);
  });
});

describe('ending a terminal', () => {
  it('ends on /exit: a beat later, an INTENTIONAL session-ended, and the next snapshot no longer lists it', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    await controller.verbs.writeInteractiveTerminal(started.sessionId, '/exit\r');
    // Claude Code takes a moment to quit: still there right after the Enter.
    await vi.advanceTimersByTimeAsync(100);
    expect(sessionEndedEventsFor(started.sessionId)).toHaveLength(0);
    expect(await listedTerminals()).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(5_000);

    const ended = sessionEndedEventsFor(started.sessionId);
    expect(ended).toHaveLength(1);
    expect(ended[0].kind === 'activity' && ended[0].payload.type === 'session-ended' && ended[0].payload.intentional).toBe(true);
    expect(await listedTerminals()).toEqual([]);
    // Ended means gone: no stream to subscribe to any more.
    await expect(controller.verbs.readStreamSubscribe(started.sessionId, { terminal: false })).rejects.toThrow(/No such session/);
  });

  it('does not end on a prompt that only mentions /exit', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    await controller.verbs.writeInteractiveTerminal(started.sessionId, 'explain what /exit does\r');
    await vi.advanceTimersByTimeAsync(5_000);

    expect(sessionEndedEventsFor(started.sessionId)).toHaveLength(0);
    expect(await listedTerminals()).toHaveLength(1);
  });

  it('announces the end with a command-terminals-changed board event', async () => {
    const started = await startTerminal();
    await vi.advanceTimersByTimeAsync(200);
    const announcedBeforeEnd = commandTerminalsChangedEvents(MOCK_PROJECT_ID).length;

    await controller.verbs.stopCommandTerminal(started.sessionId);
    await vi.advanceTimersByTimeAsync(200);

    expect(commandTerminalsChangedEvents(MOCK_PROJECT_ID)).toHaveLength(announcedBeforeEnd + 1);
  });
});

describe('command-terminal stop', () => {
  it('ends a live terminal at once: an intentional session-ended, gone from the very next snapshot', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    await expect(controller.verbs.stopCommandTerminal(started.sessionId)).resolves.toBeUndefined();

    // Events ride the same microtask delivery as the response, so no timer
    // advance is owed: the end was pushed before Stop was answered.
    const ended = sessionEndedEventsFor(started.sessionId);
    expect(ended).toHaveLength(1);
    expect(ended[0].kind === 'activity' && ended[0].payload.type === 'session-ended' && ended[0].payload.intentional).toBe(true);
    expect(await listedTerminals()).toEqual([]);
  });

  it('refuses the streaming task session with not-command-terminal, and leaves the session alone', async () => {
    expect(await refusalCodeOf(controller.verbs.stopCommandTerminal(MOCK_STREAMING_SESSION_ID))).toBe('not-command-terminal');

    // Stopping a terminal is not how a task's agent is stopped: still streaming.
    await expect(controller.verbs.readStreamSubscribe(MOCK_STREAMING_SESSION_ID, { terminal: false })).resolves.toBeDefined();
    expect(sessionEndedEventsFor(MOCK_STREAMING_SESSION_ID)).toHaveLength(0);
  });

  it('refuses a static task session with not-command-terminal too', async () => {
    expect(await refusalCodeOf(controller.verbs.stopCommandTerminal(MOCK_IDLE_STATIC_SESSION.sessionId))).toBe('not-command-terminal');
    expect(sessionEndedEventsFor(MOCK_IDLE_STATIC_SESSION.sessionId)).toHaveLength(0);
  });

  it('refuses an unknown session with unknown-session', async () => {
    expect(await refusalCodeOf(controller.verbs.stopCommandTerminal('no-such-session'))).toBe('unknown-session');
  });

  it('answers unknown-session for a terminal that already ended, which the caller treats as stopped', async () => {
    const started = await startTerminal();
    await controller.verbs.stopCommandTerminal(started.sessionId);

    expect(await refusalCodeOf(controller.verbs.stopCommandTerminal(started.sessionId))).toBe('unknown-session');
  });

  it('stops only the terminal it names', async () => {
    const first = await startTerminal();
    const second = await startTerminal();

    await controller.verbs.stopCommandTerminal(first.sessionId);

    expect((await listedTerminals()).map((terminal) => terminal.sessionId)).toEqual([second.sessionId]);
    expect(sessionEndedEventsFor(second.sessionId)).toHaveLength(0);
  });
});
