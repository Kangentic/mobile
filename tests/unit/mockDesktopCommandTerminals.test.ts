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
import {
  COMMAND_TERMINAL_RECORDED_NAME,
  COMMAND_TERMINAL_RECORDED_PROMPT,
  COMMAND_TERMINAL_RECORDED_TURN_MS,
  COMMAND_TERMINAL_TURN,
} from '@/devsupport/commandTerminalCapture';
import { waitUntil } from '../helpers/async';
import { renderCaptureRows } from '../helpers/renderCapture';

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

/** Every chunk a terminal has been sent so far, in order: what a phone subscribed from its start has drawn. */
function drawnOn(sessionId: string): string[] {
  return eventsFor('terminal', sessionId).map((event) => (event.kind === 'terminal' ? event.payload.data : ''));
}

/**
 * Claude Code's input box once `chunks` are drawn: the last row opening with its prompt glyph, read off
 * a headless terminal at the recorded grid. The bytes a terminal is sent only mean something drawn.
 * xterm parses on timers the fake clock would hold back, so this turns the fake clock off: call it
 * after the last thing the mock has to do.
 */
async function inputBoxRowAfter(chunks: string[]): Promise<string> {
  vi.useRealTimers();
  const { cols, rows } = COMMAND_TERMINAL_TURN.opening;
  const screen = await renderCaptureRows({ cols, rows, seedFrame: chunks.join(''), chunks: [] });
  const inputBoxRows = screen.filter((row) => row.startsWith('❯'));
  // Claude Code follows its glyph with a no-break space, which reads as a space and compares as not one,
  // and a rubbed-out key leaves a written blank cell behind it that the terminal does not trim.
  return (inputBoxRows[inputBoxRows.length - 1] ?? '').replace(/ /g, ' ').trimEnd();
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

  it('serves the recorded opening screen on a terminal subscribe once it arrives, and nothing on a list-only one', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    const withTerminal = await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: true });
    const listOnly = await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: false });

    expect(withTerminal.scrollback).toContain(COMMAND_TERMINAL_TURN.opening.seedFrame);
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
  it('echoes the keys into that terminal only, the first one clearing the placeholder, never into the streaming session\'s feed', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    const response = await controller.verbs.writeInteractiveTerminal(started.sessionId, 'ls');
    await vi.advanceTimersByTimeAsync(10);

    expect(response.written).toBe(true);
    // The opening frame leaves the cursor in Claude Code's input box, over its
    // "Try ..." placeholder: the first key erases the rest of that line first.
    const typedEcho = eventsFor('terminal', started.sessionId).filter((event) => event.kind === 'terminal' && event.payload.data === '\u001b[Kls');
    expect(typedEcho).toHaveLength(1);
    expect(eventsFor('terminal', MOCK_STREAMING_SESSION_ID)).toHaveLength(0);
    expect(eventsFor('terminal', MOCK_IDLE_STATIC_SESSION.sessionId)).toHaveLength(0);
  });

  it('rubs a Backspace out on screen and out of the line it submits', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    await controller.verbs.writeInteractiveTerminal(started.sessionId, 'fix thee\u007f flaky test\r');
    await vi.advanceTimersByTimeAsync(5_000);

    const echoed = eventsFor('terminal', started.sessionId)
      .map((event) => (event.kind === 'terminal' ? event.payload.data : ''))
      .join('');
    expect(echoed).toContain('thee\b \b flaky test');
    const [named] = await listedTerminals();
    expect(named.name).toBe('Fix The Flaky Test');
  });

  /**
   * The echo bytes above are only half the claim: the recorded opening screen has to leave the
   * cursor in Claude Code's input box for them to land there, and the placeholder has to be gone
   * for the line to read as typed. Drawn through a headless terminal, the input box is what a user
   * sees.
   */
  it('types into Claude Code\'s own input box over its placeholder, and a Backspace rubs the last key out', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    await controller.verbs.writeInteractiveTerminal(started.sessionId, 'lsx');
    await vi.advanceTimersByTimeAsync(10);
    const afterTyping = drawnOn(started.sessionId);
    await controller.verbs.writeInteractiveTerminal(started.sessionId, '\u007f');
    await vi.advanceTimersByTimeAsync(10);
    const afterBackspace = drawnOn(started.sessionId);

    expect(await inputBoxRowAfter(afterTyping)).toBe('❯ lsx');
    expect(await inputBoxRowAfter(afterBackspace)).toBe('❯ ls');
    // The control that lets the two lines above fail: take the erase out of the echo and the
    // placeholder's tail shows through behind the keys.
    const echoWithoutErase = afterTyping[afterTyping.length - 1].replace('\u001b[K', '');
    expect(await inputBoxRowAfter([...afterTyping.slice(0, -1), echoWithoutErase])).toContain('refactor <filepath>');
  });

  it('draws nothing for a Backspace on an empty line, which would rub out the prompt glyph', async () => {
    const started = await startTerminal();
    await letAgentArrive();
    const drawnBefore = drawnOn(started.sessionId).length;

    await controller.verbs.writeInteractiveTerminal(started.sessionId, '\u007f');
    await vi.advanceTimersByTimeAsync(10);

    expect(drawnOn(started.sessionId).slice(drawnBefore)).toEqual([]);
  });

  it('starts no turn for an Enter on an empty line: nothing drawn, no thinking, still idle', async () => {
    const started = await startTerminal();
    await letAgentArrive();
    const drawnBefore = drawnOn(started.sessionId).length;
    const activityBefore = eventsFor('activity', started.sessionId).length;

    await controller.verbs.writeInteractiveTerminal(started.sessionId, '\r');
    await vi.advanceTimersByTimeAsync(100);

    expect(drawnOn(started.sessionId).slice(drawnBefore)).toEqual([]);
    expect(eventsFor('activity', started.sessionId)).toHaveLength(activityBefore);
    expect((await listedTerminals())[0].activity.state).toBe('idle');
  });

  it('draws a line\'s echo BEFORE the recorded screen its Enter brings up, so that screen is never typed over', async () => {
    const started = await startTerminal();
    await letAgentArrive();
    const drawnBefore = drawnOn(started.sessionId).length;

    await controller.verbs.writeInteractiveTerminal(started.sessionId, 'fix the flaky test\r');
    await vi.advanceTimersByTimeAsync(10);

    // Order, not a joined string: the frame replaces the screen, so it must come last.
    expect(drawnOn(started.sessionId).slice(drawnBefore)).toEqual([
      '\u001b[Kfix the flaky test',
      `\u001b[2J${COMMAND_TERMINAL_TURN.submitted.seedFrame}`,
    ]);
    // And a later subscriber is handed that screen and nothing after it.
    const streamed = await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: true });
    expect(streamed.scrollback).toBe(`\u001b[2J${COMMAND_TERMINAL_TURN.submitted.seedFrame}`);
  });

  it('starts the next line fresh: its first key erases the line tail again, and echoes alone', async () => {
    const started = await startTerminal();
    await letAgentArrive();
    await controller.verbs.writeInteractiveTerminal(started.sessionId, 'hello\r');
    await vi.advanceTimersByTimeAsync(10);
    const drawnBefore = drawnOn(started.sessionId).length;

    await controller.verbs.writeInteractiveTerminal(started.sessionId, 'x');
    await vi.advanceTimersByTimeAsync(10);

    expect(drawnOn(started.sessionId).slice(drawnBefore)).toEqual(['\u001b[Kx']);
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
  });

  /**
   * Every frame a terminal shows is RECORDED (src/devsupport/commandTerminalCapture.ts): the
   * screens of one real Claude Code session, never output written here. A turn replays that
   * session's: the submitted screen at once, the answer when the recorded turn's own time is up.
   */
  it('replays the recorded turn: the submitted screen at once, the answer at the recorded pace, then idle', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    await controller.verbs.writeInteractiveTerminal(started.sessionId, `${COMMAND_TERMINAL_RECORDED_PROMPT}\r`);
    await vi.advanceTimersByTimeAsync(100);
    const midTurn = await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: true });
    expect(midTurn.scrollback).toContain(COMMAND_TERMINAL_TURN.submitted.seedFrame);
    expect(midTurn.scrollback).not.toContain(COMMAND_TERMINAL_TURN.answered.seedFrame);
    expect(midTurn.activity.state).toBe('thinking');

    // Not a moment before the recorded turn's own length.
    await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_RECORDED_TURN_MS - 1_000);
    expect((await listedTerminals())[0].activity.state).toBe('thinking');

    await vi.advanceTimersByTimeAsync(2_000);
    const answered = await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: true });
    expect(answered.scrollback).toContain(COMMAND_TERMINAL_TURN.answered.seedFrame);
    expect(answered.activity.state).toBe('idle');
  });

  it('hands a later subscriber the screen as it stands, not every frame drawn over it', async () => {
    const started = await startTerminal();
    await letAgentArrive();
    await controller.verbs.writeInteractiveTerminal(started.sessionId, `${COMMAND_TERMINAL_RECORDED_PROMPT}\r`);
    await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_RECORDED_TURN_MS + 1_000);

    const streamed = await controller.verbs.readStreamSubscribe(started.sessionId, { terminal: true });

    expect(streamed.scrollback).not.toContain(COMMAND_TERMINAL_TURN.opening.seedFrame);
    expect(streamed.scrollback).not.toContain(COMMAND_TERMINAL_TURN.submitted.seedFrame);
    // And the frame erases the one before it, or its blank rows would show the old screen through.
    expect(streamed.scrollback.startsWith('\u001b[2J')).toBe(true);
  });

  it('names the recorded prompt with the name a real desktop gave it', async () => {
    const started = await startTerminal();
    await letAgentArrive();

    await controller.verbs.sendUserMessage(started.sessionId, COMMAND_TERMINAL_RECORDED_PROMPT);
    await vi.advanceTimersByTimeAsync(5_000);

    const [named] = await listedTerminals();
    expect(named.name).toBe(COMMAND_TERMINAL_RECORDED_NAME);
    expect(named.name.length).toBeLessThanOrEqual(80);
  });

  it('draws no raw line for a prompt sent through the composer: the recorded screen carries it', async () => {
    const started = await startTerminal();
    await letAgentArrive();
    const before = eventsFor('terminal', started.sessionId).length;

    await controller.verbs.sendUserMessage(started.sessionId, 'review the migration');
    await vi.advanceTimersByTimeAsync(10);

    const drawn = eventsFor('terminal', started.sessionId)
      .slice(before)
      .map((event) => (event.kind === 'terminal' ? event.payload.data : ''));
    expect(drawn).toEqual([`\u001b[2J${COMMAND_TERMINAL_TURN.submitted.seedFrame}`]);
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

  it('draws no answer and reports no activity for a terminal stopped mid-turn', async () => {
    const started = await startTerminal();
    await letAgentArrive();
    await controller.verbs.writeInteractiveTerminal(started.sessionId, `${COMMAND_TERMINAL_RECORDED_PROMPT}\r`);
    await vi.advanceTimersByTimeAsync(100);

    await controller.verbs.stopCommandTerminal(started.sessionId);
    const drawnAtStop = drawnOn(started.sessionId).length;
    const activityAtStop = eventsFor('activity', started.sessionId).length;
    // Past the recorded turn's own length. 'replays the recorded turn' shows a LIVE terminal's
    // answer and its idle land inside exactly this window, so nothing here is vacuous.
    await vi.advanceTimersByTimeAsync(COMMAND_TERMINAL_RECORDED_TURN_MS + 1_000);

    expect(drawnOn(started.sessionId)).toHaveLength(drawnAtStop);
    expect(eventsFor('activity', started.sessionId)).toHaveLength(activityAtStop);
    expect(sessionEndedEventsFor(started.sessionId)).toHaveLength(1);
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
