/**
 * The Command Terminal actions (protocol 0.20.0): the one plain line a failed
 * start shows, a start that returns its launch id at once and settles it in the
 * background, and a Stop that reads "Stopping..." until the board drops the
 * terminal.
 *
 * The failure line is read off the refusal's TYPED code, never parsed out of its
 * text, so every case here gives the error text that would send a text-parser
 * the wrong way. connectionManager is mocked the way resumeTaskSession.test.ts
 * does it, plus the one thing its mock leaves out: `NotConnectedError`, which
 * the failure line `instanceof`-checks.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_UNAVAILABLE_ERROR_CODE,
  COMMAND_TERMINAL_LIMIT_ERROR_CODE,
  COMMAND_TERMINAL_START_FAILED_ERROR_CODE,
  UNKNOWN_PROJECT_ERROR_CODE,
  UNKNOWN_SESSION_ERROR_CODE,
  UNSUPPORTED_VERB_ERROR_CODE,
} from '@kangentic/protocol';
import { CapabilityTimeoutError, ChannelDisconnectedError } from '@/channel/capabilityClient';
import { CapabilityError } from '@/channel/verbClient';
import { commandTerminalStartFailureLine, launchCommandTerminal, stopCommandTerminal } from '@/connection/actions';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useCommandTerminalStore } from '@/state/commandTerminalStore';
import { boardSnapshotFixture } from '@/devsupport/desktopFixtures';
import { commandTerminalWire } from '../helpers/commandTerminalWire';
import { flushMicrotasks } from '../helpers/async';

const mocks = vi.hoisted(() => {
  class NotConnectedError extends Error {
    constructor() {
      super('Not connected to the desktop');
      this.name = 'NotConnectedError';
    }
  }
  return {
    NotConnectedError,
    startCommandTerminal: vi.fn(),
    stopCommandTerminal: vi.fn(),
    requireVerbClient: vi.fn(),
    getActiveConnection: vi.fn(),
    requireSubscriptions: vi.fn(),
    reconcileSessionsFromBoards: vi.fn(),
    refreshBoard: vi.fn(),
  };
});

vi.mock('@/connection/connectionManager', () => ({
  NotConnectedError: mocks.NotConnectedError,
  getActiveConnection: mocks.getActiveConnection,
  reconnectNow: vi.fn(),
  requireSubscriptions: mocks.requireSubscriptions,
  requireVerbClient: mocks.requireVerbClient,
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
vi.mock('@/connection/storeFeed', () => ({ reconcileSessionsFromBoards: mocks.reconcileSessionsFromBoards }));
// @/connection/actions also imports settingsStore, which persists via
// expo-secure-store - fake it so the vitest (node) run has no native module.
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

const PROJECT_ID = 'project-1';
const connectionSubscriptions = { refreshBoard: mocks.refreshBoard };

/** A promise the test settles by hand, so a call can be inspected while the desktop has not yet answered. */
function deferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void; reject: (error: unknown) => void } {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function launchStore() {
  return useCommandTerminalStore.getState();
}

function onlyLaunch() {
  const launches = Object.values(launchStore().launchesById);
  if (launches.length !== 1) throw new Error(`expected exactly one launch, found ${launches.length}`);
  return launches[0];
}

beforeEach(() => {
  mocks.startCommandTerminal.mockReset();
  mocks.stopCommandTerminal.mockReset();
  mocks.requireVerbClient.mockReset();
  mocks.requireVerbClient.mockReturnValue({
    startCommandTerminal: mocks.startCommandTerminal,
    stopCommandTerminal: mocks.stopCommandTerminal,
  });
  mocks.getActiveConnection.mockReset();
  mocks.getActiveConnection.mockReturnValue({ subscriptions: connectionSubscriptions });
  mocks.reconcileSessionsFromBoards.mockReset();
  mocks.refreshBoard.mockReset();
  useBoardStore.getState().reset();
  useActivityStore.getState().reset();
  useCommandTerminalStore.getState().reset();
});

describe('commandTerminalStartFailureLine', () => {
  it('says the desktop did not answer for a timeout', () => {
    expect(commandTerminalStartFailureLine(new CapabilityTimeoutError('command-terminal'))).toBe("The desktop didn't answer.");
  });

  it('says it is not connected for a missing connection and for a channel that dropped mid-request', () => {
    expect(commandTerminalStartFailureLine(new mocks.NotConnectedError())).toBe('Not connected to the desktop.');
    expect(commandTerminalStartFailureLine(new ChannelDisconnectedError('closed'))).toBe('Not connected to the desktop.');
  });

  // Each refusal carries desktop text that would mislead a text-parser; the
  // line must come from the code.
  it.each([
    [COMMAND_TERMINAL_LIMIT_ERROR_CODE, 'The project has no slot for a start', 'This project already runs four.'],
    [UNKNOWN_PROJECT_ERROR_CODE, 'No such terminal', "The desktop doesn't have this project."],
    [UNSUPPORTED_VERB_ERROR_CODE, 'Something about a limit', "This desktop can't start terminals."],
  ] as const)('maps the typed code %s to its own line, whatever the desktop wrote', (code, desktopText, expectedLine) => {
    expect(commandTerminalStartFailureLine(new CapabilityError('command-terminal', desktopText, code))).toBe(expectedLine);
  });

  it.each([AGENT_UNAVAILABLE_ERROR_CODE, COMMAND_TERMINAL_START_FAILED_ERROR_CODE])(
    'shows the desktop\'s own words for the code %s, which names no phone line',
    (code) => {
      const error = new CapabilityError('command-terminal', 'Claude is not installed on this machine.', code);

      expect(commandTerminalStartFailureLine(error)).toBe('Claude is not installed on this machine.');
    },
  );

  it('shows the desktop\'s words for a refusal with no code, trimmed', () => {
    expect(commandTerminalStartFailureLine(new CapabilityError('command-terminal', '  Git is busy.\n'))).toBe('Git is busy.');
  });

  it('caps the desktop\'s words at 160 characters, since they are peer-supplied display text', () => {
    const line = commandTerminalStartFailureLine(new CapabilityError('command-terminal', `Failed ${'and more '.repeat(60)}`));

    expect(line).toHaveLength(160);
    expect(line.startsWith('Failed and more')).toBe(true);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '  \n\t '],
  ])('falls back to the generic line for a refusal whose text is %s, with or without a code', (_label, desktopText) => {
    expect(commandTerminalStartFailureLine(new CapabilityError('command-terminal', desktopText))).toBe("The desktop couldn't start it.");
    expect(commandTerminalStartFailureLine(new CapabilityError('command-terminal', desktopText, AGENT_UNAVAILABLE_ERROR_CODE))).toBe(
      "The desktop couldn't start it.",
    );
  });

  it('falls back to the generic line for an error that is not a refusal at all', () => {
    expect(commandTerminalStartFailureLine(new Error('boom'))).toBe("The desktop couldn't start it.");
    expect(commandTerminalStartFailureLine('boom')).toBe("The desktop couldn't start it.");
  });
});

describe('launchCommandTerminal', () => {
  const answered = { ok: true as const, sessionId: 'sess-terminal-1', slot: 2, name: 'Command Terminal 2' };

  it('returns the launch id at once, with the launch starting and the verb asked for the project', async () => {
    const pending = deferred<typeof answered>();
    mocks.startCommandTerminal.mockReturnValue(pending.promise);

    const launchId = launchCommandTerminal(PROJECT_ID);

    expect(launchStore().launchesById[launchId]).toMatchObject({ projectId: PROJECT_ID, phase: 'starting', sessionId: null });
    await flushMicrotasks();
    expect(mocks.startCommandTerminal).toHaveBeenCalledTimes(1);
    expect(mocks.startCommandTerminal).toHaveBeenCalledWith(PROJECT_ID);
    pending.resolve(answered);
    await flushMicrotasks();
  });

  /**
   * The prediction only titles the screen until the answer carries the real
   * slot, so it is read while the verb is still outstanding. Slots 1 and 3 are
   * on the board and 2 is taken by a start already in flight: the lowest free
   * one is 4. A prediction that looked at the board alone says 2, one that
   * looked at the starts alone says 1.
   */
  it('predicts the lowest slot neither the board nor another start in flight holds', async () => {
    useBoardStore.getState().applyBoardSnapshot(
      boardSnapshotFixture({
        projectId: PROJECT_ID,
        tasks: [],
        commandTerminals: [commandTerminalWire({ sessionId: 'sess-a', slot: 1 }), commandTerminalWire({ sessionId: 'sess-c', slot: 3 })],
      }),
    );
    launchStore().beginLaunch(PROJECT_ID, 2);
    mocks.startCommandTerminal.mockReturnValue(deferred().promise);

    const launchId = launchCommandTerminal(PROJECT_ID);

    expect(launchStore().launchesById[launchId]).toMatchObject({ slot: 4, name: 'Command Terminal 4' });
  });

  it('predicts slot 1 for a project with no terminals, and counts only its own project\'s starts', async () => {
    launchStore().beginLaunch('project-other', 1);
    mocks.startCommandTerminal.mockReturnValue(deferred().promise);

    const launchId = launchCommandTerminal(PROJECT_ID);

    expect(launchStore().launchesById[launchId]).toMatchObject({ slot: 1, name: 'Command Terminal 1' });
  });

  it('marks the launch started with the desktop\'s answer BEFORE the reconcile reads it, then re-reads the board', async () => {
    mocks.startCommandTerminal.mockResolvedValue(answered);
    let phaseSeenByReconcile: string | undefined;
    mocks.reconcileSessionsFromBoards.mockImplementation(() => {
      phaseSeenByReconcile = onlyLaunch().phase;
    });

    const launchId = launchCommandTerminal(PROJECT_ID);
    await flushMicrotasks();

    expect(launchStore().launchesById[launchId]).toMatchObject({
      phase: 'started',
      sessionId: answered.sessionId,
      slot: answered.slot,
      name: answered.name,
    });
    // The reconcile keeps the new stream wanted by reading the launch; run
    // before it was marked started it would find nothing to keep.
    expect(phaseSeenByReconcile).toBe('started');
    expect(mocks.reconcileSessionsFromBoards).toHaveBeenCalledWith(connectionSubscriptions);
    expect(mocks.refreshBoard).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('still marks the launch started when no connection is active to reconcile on', async () => {
    mocks.startCommandTerminal.mockResolvedValue(answered);
    mocks.getActiveConnection.mockReturnValue(null);

    launchCommandTerminal(PROJECT_ID);
    await flushMicrotasks();

    expect(onlyLaunch().phase).toBe('started');
    expect(mocks.reconcileSessionsFromBoards).not.toHaveBeenCalled();
    expect(mocks.refreshBoard).not.toHaveBeenCalled();
  });

  it('marks the launch failed with the typed line, and does not re-read the board for a refusal', async () => {
    mocks.startCommandTerminal.mockRejectedValue(new CapabilityError('command-terminal', 'No room', COMMAND_TERMINAL_LIMIT_ERROR_CODE));

    launchCommandTerminal(PROJECT_ID);
    await flushMicrotasks();

    expect(onlyLaunch()).toMatchObject({ phase: 'failed', failureMessage: 'This project already runs four.' });
    expect(mocks.refreshBoard).not.toHaveBeenCalled();
    expect(mocks.reconcileSessionsFromBoards).not.toHaveBeenCalled();
  });

  /**
   * The desktop may be starting the terminal after all: only its answer timed
   * out. Re-reading the board is how a terminal that did start shows up.
   */
  it('re-reads the board when the start times out, because the terminal may be running', async () => {
    mocks.startCommandTerminal.mockRejectedValue(new CapabilityTimeoutError('command-terminal'));

    launchCommandTerminal(PROJECT_ID);
    await flushMicrotasks();

    expect(onlyLaunch()).toMatchObject({ phase: 'failed', failureMessage: "The desktop didn't answer." });
    expect(mocks.refreshBoard).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('fails the launch as not connected when there is no verb client to ask', async () => {
    mocks.requireVerbClient.mockImplementation(() => {
      throw new mocks.NotConnectedError();
    });

    launchCommandTerminal(PROJECT_ID);
    await flushMicrotasks();

    expect(onlyLaunch()).toMatchObject({ phase: 'failed', failureMessage: 'Not connected to the desktop.' });
    expect(mocks.refreshBoard).not.toHaveBeenCalled();
  });
});

describe('stopCommandTerminal', () => {
  const SESSION_ID = 'sess-terminal-1';

  beforeEach(() => {
    // The project the Stop re-reads is the activity entry's, so a Stop test
    // that skipped registering one would never see refreshBoard fire.
    useActivityStore.getState().registerCommandTerminal(SESSION_ID, PROJECT_ID);
  });

  const stopPhase = () => launchStore().stopsBySessionId[SESSION_ID];

  it('marks the terminal stopping the moment it is asked, and keeps it stopping once the desktop answers', async () => {
    const pending = deferred<void>();
    mocks.stopCommandTerminal.mockReturnValue(pending.promise);

    const stopped = stopCommandTerminal(SESSION_ID);

    expect(stopPhase()).toBe('stopping');
    expect(mocks.stopCommandTerminal).toHaveBeenCalledWith(SESSION_ID);
    pending.resolve();
    await stopped;
    // "Stopping..." lasts until the board drops the terminal, not until the verb answers.
    expect(stopPhase()).toBe('stopping');
    expect(mocks.refreshBoard).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('treats unknown-session as already stopped: it stays stopping and the board is re-read', async () => {
    mocks.stopCommandTerminal.mockRejectedValue(new CapabilityError('command-terminal', 'No such session', UNKNOWN_SESSION_ERROR_CODE));

    await stopCommandTerminal(SESSION_ID);

    expect(stopPhase()).toBe('stopping');
    expect(mocks.refreshBoard).toHaveBeenCalledWith(PROJECT_ID);
  });

  it.each([
    ['a refusal with another code', new CapabilityError('command-terminal', 'Not a terminal', 'not-command-terminal')],
    ['a refusal with no code', new CapabilityError('command-terminal', 'The desktop is busy')],
    ['a timeout', new CapabilityTimeoutError('command-terminal')],
    ['a lost connection', new ChannelDisconnectedError('closed')],
  ])('marks the stop failed after %s, and re-reads the board in case it landed anyway', async (_label, failure) => {
    mocks.stopCommandTerminal.mockRejectedValue(failure);

    await stopCommandTerminal(SESSION_ID);

    expect(stopPhase()).toBe('failed');
    expect(mocks.refreshBoard).toHaveBeenCalledWith(PROJECT_ID);
  });

  it('sends nothing for a second tap while a stop is already in flight', async () => {
    mocks.stopCommandTerminal.mockReturnValue(deferred<void>().promise);

    void stopCommandTerminal(SESSION_ID);
    await stopCommandTerminal(SESSION_ID);

    expect(mocks.stopCommandTerminal).toHaveBeenCalledTimes(1);
  });

  it('sends a fresh stop for a retry after a failed one, and shows it stopping again', async () => {
    mocks.stopCommandTerminal.mockRejectedValueOnce(new CapabilityTimeoutError('command-terminal'));
    await stopCommandTerminal(SESSION_ID);
    expect(stopPhase()).toBe('failed');

    mocks.stopCommandTerminal.mockResolvedValueOnce(undefined);
    await stopCommandTerminal(SESSION_ID);

    expect(mocks.stopCommandTerminal).toHaveBeenCalledTimes(2);
    expect(stopPhase()).toBe('stopping');
  });

  it('re-reads no board for a terminal the phone holds no activity entry for', async () => {
    mocks.stopCommandTerminal.mockResolvedValue(undefined);

    await stopCommandTerminal('sess-unregistered');

    expect(launchStore().stopsBySessionId['sess-unregistered']).toBe('stopping');
    expect(mocks.refreshBoard).not.toHaveBeenCalled();
  });
});
