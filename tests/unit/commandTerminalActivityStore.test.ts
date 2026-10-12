/**
 * activityStore's Command Terminal entries (protocol 0.20.0): a terminal is an
 * agent with no task, registered as its own kind of entry.
 *
 * Two things are load-bearing and each fails silently if it regresses:
 *
 *   1. NO TASK BOOKKEEPING. The desktop stamps a terminal's stream events with a
 *      made-up task id. Recording that id in `respawnByTaskId` or
 *      `pendingSuccessorByTaskId` would make a terminal's END read as a task's
 *      session swap, keeping its card on the Agents feed for the retention
 *      window and hopping a stream to a "successor" of a task that does not
 *      exist.
 *   2. `activityObserved`, the latch that holds a terminal's input closed until
 *      the desktop has classified its agent (the phone's half of the desktop's
 *      "no shell reach" promise): a bare shell sits behind the agent for a
 *      moment after spawn.
 *
 * Entries are built through the store's own actions, never as literals.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEvent, ActivityEventPayload } from '@kangentic/protocol';
import { useActivityStore } from '@/state/activityStore';
import { streamSnapshotFixture, usageFixture } from '@/devsupport/desktopFixtures';

const PROJECT_ID = 'project-1';
const TERMINAL_SESSION_ID = 'sess-terminal-1';
/** The id the desktop invents for a terminal's events; it names no board row. */
const MADE_UP_TASK_ID = 'terminal-task-made-up';

function activityEvent(sessionId: string, taskId: string, payload: ActivityEventPayload): ActivityEvent {
  return { kind: 'activity', sessionId, taskId, payload };
}

/** A snapshot whose activity has not been classified yet: the desktop's engine has said nothing. */
function unclassifiedSnapshot(): ReturnType<typeof streamSnapshotFixture> {
  return streamSnapshotFixture({ activity: { state: null, reason: null } });
}

function terminalEntry(sessionId = TERMINAL_SESSION_ID) {
  const entry = useActivityStore.getState().bySessionId[sessionId];
  if (entry === undefined) throw new Error(`no activity entry for ${sessionId}`);
  return entry;
}

describe('Command Terminal activity entries', () => {
  beforeEach(() => {
    useActivityStore.getState().reset();
  });

  describe('registerCommandTerminal', () => {
    it('creates a pending entry of kind command-terminal with no task', () => {
      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, PROJECT_ID);

      const entry = terminalEntry();
      expect(entry.kind).toBe('command-terminal');
      expect(entry.taskId).toBe('');
      expect(entry.projectId).toBe(PROJECT_ID);
      expect(entry.feedStatus).toBe('pending');
      expect(entry.sessionStatus).toBeNull();
    });

    it('is idempotent: registering again leaves the very same state object', () => {
      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, PROJECT_ID);
      const before = useActivityStore.getState().bySessionId;

      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, PROJECT_ID);

      // Identity, not equality: the reconcile registers every listed terminal on
      // EVERY board snapshot, and a fresh map each time would re-render every
      // subscriber of the feed on every snapshot.
      expect(useActivityStore.getState().bySessionId).toBe(before);
    });

    it('keeps what the entry has learned when it is registered again', () => {
      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, PROJECT_ID);
      useActivityStore.getState().applySnapshot(TERMINAL_SESSION_ID, '', PROJECT_ID, streamSnapshotFixture());

      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, PROJECT_ID);

      expect(terminalEntry().feedStatus).toBe('live');
      expect(terminalEntry().activityObserved).toBe(true);
    });

    it('never relabels a task entry that already holds the session id', () => {
      useActivityStore.getState().registerSession('sess-shared', 'task-1', PROJECT_ID);

      useActivityStore.getState().registerCommandTerminal('sess-shared', PROJECT_ID);

      expect(terminalEntry('sess-shared').kind).toBe('task');
      expect(terminalEntry('sess-shared').taskId).toBe('task-1');
    });

    it('registers a task session as kind task (the control for the kind field)', () => {
      useActivityStore.getState().registerSession('sess-task', 'task-1', PROJECT_ID);

      expect(terminalEntry('sess-task').kind).toBe('task');
    });
  });

  describe('applySnapshot', () => {
    it('keeps a terminal\'s empty task id even when handed one', () => {
      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, PROJECT_ID);

      useActivityStore.getState().applySnapshot(TERMINAL_SESSION_ID, MADE_UP_TASK_ID, PROJECT_ID, streamSnapshotFixture());

      expect(terminalEntry().taskId).toBe('');
      expect(terminalEntry().kind).toBe('command-terminal');
    });

    it('adopts the handed task id for a task entry (the control: only the terminal kind pins it)', () => {
      useActivityStore.getState().registerSession('sess-task', 'task-1', PROJECT_ID);

      useActivityStore.getState().applySnapshot('sess-task', 'task-2', PROJECT_ID, streamSnapshotFixture());

      expect(terminalEntry('sess-task').taskId).toBe('task-2');
    });
  });

  describe('session-ended', () => {
    /**
     * `successorSessionId` is set on purpose: without a named successor
     * `pendingSuccessorByTaskId` is never written even by a store that
     * mishandles the terminal, which would leave half of this assertion vacuous.
     */
    const endedWithSuccessor: ActivityEventPayload = {
      type: 'session-ended',
      intentional: true,
      spawnProgressLabel: 'Switching model...',
      successorSessionId: 'sess-would-be-successor',
    };

    it('writes no respawn record and no pending successor for a terminal, but still records the end', () => {
      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, PROJECT_ID);

      useActivityStore.getState().applyActivityEvent(activityEvent(TERMINAL_SESSION_ID, MADE_UP_TASK_ID, endedWithSuccessor));

      const state = useActivityStore.getState();
      expect(state.respawnByTaskId).toEqual({});
      expect(state.pendingSuccessorByTaskId).toEqual({});
      expect(state.endedSessionIds[TERMINAL_SESSION_ID]).toBe(true);
      expect(terminalEntry().feedStatus).toBe('ended');
      expect(terminalEntry().endedIntentionally).toBe(true);
    });

    it('writes both records for a task entry given the same event (the positive control)', () => {
      useActivityStore.getState().registerSession('sess-task', MADE_UP_TASK_ID, PROJECT_ID);

      useActivityStore.getState().applyActivityEvent(activityEvent('sess-task', MADE_UP_TASK_ID, endedWithSuccessor));

      const state = useActivityStore.getState();
      expect(state.respawnByTaskId[MADE_UP_TASK_ID]?.endedSessionId).toBe('sess-task');
      expect(state.pendingSuccessorByTaskId[MADE_UP_TASK_ID]?.sessionId).toBe('sess-would-be-successor');
    });
  });

  describe('activityObserved', () => {
    beforeEach(() => {
      useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, PROJECT_ID);
    });

    it('is false straight after registration', () => {
      expect(terminalEntry().activityObserved).toBe(false);
    });

    it('stays false on a snapshot whose activity state is null, which is recorded as idle', () => {
      useActivityStore.getState().applySnapshot(TERMINAL_SESSION_ID, '', PROJECT_ID, unclassifiedSnapshot());

      expect(terminalEntry().activityObserved).toBe(false);
      // The distinction the flag exists for: `state` alone cannot say it.
      expect(terminalEntry().state).toBe('idle');
      expect(terminalEntry().feedStatus).toBe('live');
    });

    it('is true after a snapshot with a classified state', () => {
      useActivityStore.getState().applySnapshot(
        TERMINAL_SESSION_ID,
        '',
        PROJECT_ID,
        streamSnapshotFixture({ activity: { state: 'idle', reason: { kind: 'idle' } } }),
      );

      expect(terminalEntry().activityObserved).toBe(true);
    });

    it('is true after an activity event', () => {
      useActivityStore.getState().applyActivityEvent(
        activityEvent(TERMINAL_SESSION_ID, MADE_UP_TASK_ID, { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }),
      );

      expect(terminalEntry().activityObserved).toBe(true);
    });

    it('is true after a permission event', () => {
      useActivityStore.getState().applyActivityEvent(
        activityEvent(TERMINAL_SESSION_ID, MADE_UP_TASK_ID, { type: 'permission', promptId: `${TERMINAL_SESSION_ID}:tool-1`, pending: true }),
      );

      expect(terminalEntry().activityObserved).toBe(true);
    });

    it('is not set by an event that says nothing about the agent being up (usage)', () => {
      useActivityStore.getState().applyActivityEvent(
        activityEvent(TERMINAL_SESSION_ID, MADE_UP_TASK_ID, { type: 'usage', usage: usageFixture() }),
      );

      expect(terminalEntry().activityObserved).toBe(false);
    });

    /**
     * The latch. A re-subscribe takes a snapshot while the desktop's engine
     * reclassifies, and its state reads null for that instant; the input the
     * user already had open must not lock again.
     */
    it('is latched: a later snapshot with a null state keeps it true', () => {
      useActivityStore.getState().applySnapshot(TERMINAL_SESSION_ID, '', PROJECT_ID, streamSnapshotFixture());
      expect(terminalEntry().activityObserved).toBe(true);

      useActivityStore.getState().applySnapshot(TERMINAL_SESSION_ID, '', PROJECT_ID, unclassifiedSnapshot());

      expect(terminalEntry().activityObserved).toBe(true);
    });
  });
});
