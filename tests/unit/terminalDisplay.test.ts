/**
 * terminalDisplay: how a Command Terminal reads at a glance (WORKING green,
 * NEEDS YOU amber), the Board header button's three states, and the merge of a
 * project's listed terminals with the starts this phone has in flight.
 *
 * Entries and launches are built through the stores' own actions, so each is a
 * complete record rather than a literal that has to track the store's fields.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActivityStateWire, ReadStreamSessionStatusWire } from '@kangentic/protocol';
import { useActivityStore, type SessionActivityEntry } from '@/state/activityStore';
import { useCommandTerminalStore, type CommandTerminalLaunch } from '@/state/commandTerminalStore';
import { commandTerminalTone, projectTerminals, terminalsButtonState } from '@/screens/terminals/terminalDisplay';
import { streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { commandTerminalWire } from '../helpers/commandTerminalWire';

const PROJECT_ID = 'project-1';

/** A registered terminal entry, left unobserved (a registration alone classifies nothing). */
function unobservedEntry(sessionId = 'sess-terminal'): SessionActivityEntry {
  useActivityStore.getState().registerCommandTerminal(sessionId, PROJECT_ID);
  return useActivityStore.getState().bySessionId[sessionId];
}

/** A terminal whose snapshot has classified its state, so `activityObserved` is true. */
function observedEntry(state: ActivityStateWire, sessionStatus: ReadStreamSessionStatusWire = 'running', sessionId = 'sess-terminal'): SessionActivityEntry {
  useActivityStore.getState().registerCommandTerminal(sessionId, PROJECT_ID);
  useActivityStore.getState().applySnapshot(
    sessionId,
    '',
    PROJECT_ID,
    streamSnapshotFixture({ activity: { state, reason: null }, sessionStatus }),
  );
  return useActivityStore.getState().bySessionId[sessionId];
}

describe('commandTerminalTone', () => {
  beforeEach(() => {
    useActivityStore.getState().reset();
  });

  it('is working while the phone holds no entry yet', () => {
    expect(commandTerminalTone(null)).toBe('working');
  });

  it('is working while the desktop has not classified the agent, which a bare registration reports as idle', () => {
    const entry = unobservedEntry();
    expect(entry.state).toBe('idle');
    expect(entry.activityObserved).toBe(false);

    expect(commandTerminalTone(entry)).toBe('working');
  });

  /**
   * An OBSERVED, idle entry on purpose: with an unobserved one, 'working' would
   * come from the not-observed branch and the queued branch would never be
   * reached. The control below is the same entry running, which is the user's
   * move.
   */
  it('is working for a terminal waiting for a free slot', () => {
    expect(commandTerminalTone(observedEntry('idle', 'queued'))).toBe('working');
  });

  it('is needs-you for that same observed idle terminal once it runs (the control for the queued case)', () => {
    expect(commandTerminalTone(observedEntry('idle', 'running'))).toBe('needs-you');
  });

  it('is working while the agent is thinking', () => {
    expect(commandTerminalTone(observedEntry('thinking'))).toBe('working');
  });

  it.each<ActivityStateWire>(['idle', 'permission'])('is needs-you when the agent is %s', (state) => {
    expect(commandTerminalTone(observedEntry(state))).toBe('needs-you');
  });
});

describe('terminalsButtonState', () => {
  it('offers a new terminal when none is running', () => {
    expect(terminalsButtonState([])).toEqual({ kind: 'new' });
  });

  it('shows the count, green, when every terminal is working', () => {
    expect(terminalsButtonState(['working', 'working', 'working'])).toEqual({ kind: 'running', count: 3, tone: 'working' });
  });

  it('turns amber as soon as any one terminal needs the user, wherever it sits in the list', () => {
    expect(terminalsButtonState(['working', 'needs-you', 'working'])).toEqual({ kind: 'running', count: 3, tone: 'needs-you' });
    expect(terminalsButtonState(['needs-you'])).toEqual({ kind: 'running', count: 1, tone: 'needs-you' });
  });
});

describe('projectTerminals', () => {
  beforeEach(() => {
    useCommandTerminalStore.getState().reset();
  });

  function launches(): CommandTerminalLaunch[] {
    return Object.values(useCommandTerminalStore.getState().launchesById);
  }

  it('is only the listed terminals when this phone has no start in flight', () => {
    const rows = projectTerminals(
      [commandTerminalWire({ sessionId: 'sess-a', slot: 1, name: 'Fix the login bug', named: true })],
      [],
      PROJECT_ID,
    );

    expect(rows).toEqual([{ sessionId: 'sess-a', slot: 1, name: 'Fix the login bug', named: true }]);
  });

  it('merges listed terminals with the starts in flight and orders them all by slot', () => {
    const store = useCommandTerminalStore.getState();
    store.beginLaunch(PROJECT_ID, 2);
    const answered = store.beginLaunch(PROJECT_ID, 4);
    store.markLaunchStarted(answered, { sessionId: 'sess-d', slot: 4, name: 'Command Terminal 4' });

    const rows = projectTerminals(
      [commandTerminalWire({ sessionId: 'sess-c', slot: 3 }), commandTerminalWire({ sessionId: 'sess-a', slot: 1 })],
      launches(),
      PROJECT_ID,
    );

    expect(rows.map((row) => row.slot)).toEqual([1, 2, 3, 4]);
    // The unanswered start has no session yet; the answered one has, and neither is "named".
    expect(rows.map((row) => row.sessionId)).toEqual(['sess-a', null, 'sess-c', 'sess-d']);
    expect(rows[1]).toEqual({ sessionId: null, slot: 2, name: 'Command Terminal 2', named: false });
  });

  it('does not double a started launch the board already lists, and shows the board\'s name for it', () => {
    const store = useCommandTerminalStore.getState();
    const launchId = store.beginLaunch(PROJECT_ID, 1);
    store.markLaunchStarted(launchId, { sessionId: 'sess-a', slot: 1, name: 'Command Terminal 1' });

    const rows = projectTerminals(
      [commandTerminalWire({ sessionId: 'sess-a', slot: 1, name: 'Fix the login bug', named: true })],
      launches(),
      PROJECT_ID,
    );

    expect(rows).toEqual([{ sessionId: 'sess-a', slot: 1, name: 'Fix the login bug', named: true }]);
  });

  it('leaves a failed start out, since it holds no slot', () => {
    const store = useCommandTerminalStore.getState();
    const launchId = store.beginLaunch(PROJECT_ID, 1);
    store.markLaunchFailed(launchId, "The desktop didn't answer.");

    expect(projectTerminals([], launches(), PROJECT_ID)).toEqual([]);
  });

  it('leaves another project\'s starts out', () => {
    useCommandTerminalStore.getState().beginLaunch('project-other', 1);

    expect(projectTerminals([], launches(), PROJECT_ID)).toEqual([]);
  });
});
