/**
 * storeFeed's Command Terminal half (protocol 0.20.0): the reconcile that
 * registers and streams every terminal a board lists, the phone's own starts
 * that no board lists yet, and the feed events that touch a terminal.
 *
 * A terminal is an agent with no task, so everything the task path does to keep
 * a row on screen across a respawn must NOT happen to it: no retention window
 * after its board row goes, no respawn sweep after its end, no successor hop.
 * The failures here are silent in the UI until a user sees a ghost card or a
 * terminal screen stuck on its starting face, which is why the assertions read
 * the stores and the desired-stream set rather than anything rendered.
 *
 * The harness is storeFeedSessionLifecycle.test.ts's: a fake SessionManager
 * feeding a real FeedRouter into the real bindings, and a SubscriptionManager
 * double whose `setDesiredStreams` argument is the wanted set under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandTerminalWire } from '@kangentic/protocol';
import type { SubscriptionManager } from '@/channel/subscriptionManager';
import { FeedRouter } from '@/channel/feedRouter';
import type { SessionManager } from '@/channel/sessionManager';
import { bindFeedToStores, createSnapshotSinks, reconcileSessionsFromBoards } from '@/connection/storeFeed';
import { ENDED_ROW_GRACE_MS, RESPAWN_ROW_GRACE_MS, useActivityStore } from '@/state/activityStore';
import { selectCommandTerminals, useBoardStore } from '@/state/boardStore';
import { LAUNCH_LISTING_GRACE_MS, useCommandTerminalStore } from '@/state/commandTerminalStore';
import { projectTerminals } from '@/screens/terminals/terminalDisplay';
import { diffKeyFor, useDiffStore } from '@/state/diffStore';
import { boardSnapshotFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { commandTerminalWire } from '../helpers/commandTerminalWire';

const PROJECT_ID = 'project-1';
const TERMINAL_ONE = 'sess-terminal-1';
const TERMINAL_TWO = 'sess-terminal-2';
/** The id the desktop invents for a terminal's events; it names no board row. */
const MADE_UP_TASK_ID = 'terminal-task-made-up';

describe('storeFeed and Command Terminals', () => {
  let deliverMessage: ((message: unknown) => void) | null = null;
  let sinks: ReturnType<typeof createSnapshotSinks>;
  let unbind: (() => void) | null = null;
  let feed: FeedRouter | null = null;
  let subscriptions: SubscriptionManager;
  let setDesiredStreams: ReturnType<typeof vi.fn>;
  let refreshBoard: ReturnType<typeof vi.fn>;
  let refreshDiff: ReturnType<typeof vi.fn>;

  /** A `view: 'sessions'` board listing these terminals (and these tasks), as the desktop sends it. */
  const publishBoard = (
    terminals: CommandTerminalWire[],
    tasks: ReturnType<typeof boardTaskFixture>[] = [],
  ): void => {
    sinks.onBoardSnapshot(
      boardSnapshotFixture({ projectId: PROJECT_ID, view: 'sessions', tasks, commandTerminals: terminals, commandTerminalsOffered: true }),
    );
  };

  const pushActivity = (sessionId: string, payload: Record<string, unknown>): void => {
    if (!deliverMessage) throw new Error('feed not wired');
    deliverMessage({ type: 'event', event: { kind: 'activity', sessionId, taskId: MADE_UP_TASK_ID, payload } });
  };

  const entryOf = (sessionId: string) => useActivityStore.getState().bySessionId[sessionId];
  const hasEntry = (sessionId: string): boolean => entryOf(sessionId) !== undefined;
  const lastDesiredStreams = (): string[] => {
    const calls = setDesiredStreams.mock.calls;
    const last = calls[calls.length - 1]?.[0] as ReadonlySet<string> | undefined;
    if (last === undefined) throw new Error('setDesiredStreams was never called');
    return [...last].sort();
  };
  const launchOf = (launchId: string) => useCommandTerminalStore.getState().launchesById[launchId];

  /** A start the desktop has answered, as launchCommandTerminal records it. */
  const startLaunch = (sessionId: string, slot = 1): string => {
    const store = useCommandTerminalStore.getState();
    const launchId = store.beginLaunch(PROJECT_ID, slot);
    store.markLaunchStarted(launchId, { sessionId, slot, name: `Command Terminal ${slot}` });
    return launchId;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    useActivityStore.getState().reset();
    useBoardStore.getState().reset();
    useCommandTerminalStore.getState().reset();
    useDiffStore.getState().reset();
    const fakeSessionManager = {
      onMessage: (listener: (message: unknown) => void) => {
        deliverMessage = listener;
        return () => {
          deliverMessage = null;
        };
      },
    } as unknown as SessionManager;
    setDesiredStreams = vi.fn();
    refreshBoard = vi.fn();
    refreshDiff = vi.fn();
    subscriptions = {
      refreshStream: vi.fn(),
      refreshBoard,
      refreshDiff,
      setDesiredStreams,
    } as unknown as SubscriptionManager;
    sinks = createSnapshotSinks(() => subscriptions);
    feed = new FeedRouter(fakeSessionManager);
    unbind = bindFeedToStores(feed, subscriptions);
  });

  afterEach(() => {
    unbind?.();
    feed?.dispose();
    useActivityStore.getState().reset();
    useBoardStore.getState().reset();
    useCommandTerminalStore.getState().reset();
    useDiffStore.getState().reset();
    vi.useRealTimers();
  });

  describe('a board that lists terminals', () => {
    /**
     * Mutation seen failing: removing `reconcileCommandTerminals(liveSessionIds);`
     * from reconcileSessionsFromBoards - the entries are never registered and the
     * desired set holds only the task's session.
     */
    it('registers each as a command-terminal entry and wants its stream beside the task sessions', () => {
      publishBoard(
        [commandTerminalWire({ sessionId: TERMINAL_ONE, slot: 1 }), commandTerminalWire({ sessionId: TERMINAL_TWO, slot: 2 })],
        [boardTaskFixture({ id: 'task-1', session_id: 'sess-task' })],
      );

      expect(lastDesiredStreams()).toEqual(['sess-task', TERMINAL_ONE, TERMINAL_TWO].sort());
      expect(entryOf(TERMINAL_ONE)).toMatchObject({ kind: 'command-terminal', taskId: '', projectId: PROJECT_ID });
      expect(entryOf(TERMINAL_TWO)).toMatchObject({ kind: 'command-terminal', taskId: '', projectId: PROJECT_ID });
      expect(entryOf('sess-task')).toMatchObject({ kind: 'task', taskId: 'task-1' });
    });

    /**
     * No retention: a task's ended session keeps its row for a window, a
     * terminal ends with its agent. Ended through the real push first, so a
     * store that kept the made-up task's end fact (and so a retention window)
     * would still hold the row here.
     */
    it('removes a terminal the moment a later board no longer lists it, even after its end push, with no retention window', () => {
      publishBoard([commandTerminalWire({ sessionId: TERMINAL_ONE }), commandTerminalWire({ sessionId: TERMINAL_TWO, slot: 2 })]);
      pushActivity(TERMINAL_ONE, { type: 'session-ended', intentional: true });

      publishBoard([commandTerminalWire({ sessionId: TERMINAL_TWO, slot: 2 })]);

      expect(hasEntry(TERMINAL_ONE)).toBe(false);
      expect(hasEntry(TERMINAL_TWO)).toBe(true);
      expect(lastDesiredStreams()).toEqual([TERMINAL_TWO]);

      // Still gone after every retention window a task's ghost could earn.
      vi.advanceTimersByTime(RESPAWN_ROW_GRACE_MS + 1);
      expect(hasEntry(TERMINAL_ONE)).toBe(false);
    });
  });

  describe('a stream snapshot for a terminal', () => {
    /**
     * The board is applied to the store DIRECTLY here, not through
     * `sinks.onBoardSnapshot`, on purpose. The sink runs the reconcile, which
     * registers the terminal's entry; `sessionOwnerFor` would then resolve the
     * owner from that entry (its fallback for a terminal the board has not
     * listed yet) and the test would pass with the board branch deleted. With
     * no entry and only the board row to go on, the board branch is the sole
     * way the snapshot can learn the terminal's project and kind.
     *
     * Mutation seen failing: removing the commandTerminals branch from
     * sessionOwnerFor - the snapshot creates a kind 'task' entry with no project.
     */
    it('lands with the listing project and the command-terminal kind when only the board names it', () => {
      useBoardStore.getState().applyBoardSnapshot(
        boardSnapshotFixture({ projectId: PROJECT_ID, tasks: [], commandTerminals: [commandTerminalWire({ sessionId: TERMINAL_ONE })] }),
      );
      expect(hasEntry(TERMINAL_ONE)).toBe(false);

      sinks.onStreamSnapshot(TERMINAL_ONE, streamSnapshotFixture());

      expect(entryOf(TERMINAL_ONE)).toMatchObject({
        kind: 'command-terminal',
        taskId: '',
        projectId: PROJECT_ID,
        feedStatus: 'live',
        activityObserved: true,
      });
    });

    it('keeps the project and kind of a terminal this phone started and no board lists yet', () => {
      startLaunch(TERMINAL_ONE);
      publishBoard([]);
      expect(entryOf(TERMINAL_ONE)).toMatchObject({ kind: 'command-terminal', projectId: PROJECT_ID });

      sinks.onStreamSnapshot(TERMINAL_ONE, streamSnapshotFixture());

      expect(entryOf(TERMINAL_ONE)).toMatchObject({ kind: 'command-terminal', taskId: '', projectId: PROJECT_ID, feedStatus: 'live' });
    });

    it('does not claim the stream of a task session', () => {
      publishBoard([], [boardTaskFixture({ id: 'task-1', session_id: 'sess-task' })]);

      sinks.onStreamSnapshot('sess-task', streamSnapshotFixture());

      expect(entryOf('sess-task')).toMatchObject({ kind: 'task', taskId: 'task-1', projectId: PROJECT_ID });
    });
  });

  describe('a terminal this phone started that no board lists yet', () => {
    it('is registered and wanted while inside the listing grace window, and not after it', () => {
      const launchId = startLaunch(TERMINAL_ONE);

      publishBoard([]);
      expect(entryOf(TERMINAL_ONE)).toMatchObject({ kind: 'command-terminal', projectId: PROJECT_ID });
      expect(lastDesiredStreams()).toEqual([TERMINAL_ONE]);

      // The last millisecond inside the window: still wanted, still held.
      vi.advanceTimersByTime(LAUNCH_LISTING_GRACE_MS - 1);
      reconcileSessionsFromBoards(subscriptions);
      expect(lastDesiredStreams()).toEqual([TERMINAL_ONE]);
      expect(hasEntry(TERMINAL_ONE)).toBe(true);
      expect(launchOf(launchId)).toBeDefined();

      // Nothing re-runs the reconcile at the deadline by itself, so this is
      // the pass that decides: the window is closed, the stream is dropped and
      // the launch is cleared with it.
      vi.advanceTimersByTime(1);
      reconcileSessionsFromBoards(subscriptions);
      expect(lastDesiredStreams()).toEqual([]);
      expect(hasEntry(TERMINAL_ONE)).toBe(false);
      expect(launchOf(launchId)).toBeUndefined();
    });

    /**
     * The race this pins: the terminal's screen binds its session by READING the
     * launch. A board snapshot that lands between the start's answer and that
     * screen's first render lists the terminal, and clearing the launch the
     * moment a board lists it stranded the screen on its starting face.
     *
     * Mutation seen failing: clearing a started launch whenever its session is
     * in the listed set (the earlier rule) - "expected undefined to be defined".
     */
    it('is NOT cleared by a reconcile that finds the board already listing it, and is wanted once', () => {
      const launchId = startLaunch(TERMINAL_ONE);

      publishBoard([commandTerminalWire({ sessionId: TERMINAL_ONE })]);

      expect(launchOf(launchId)).toMatchObject({ phase: 'started', sessionId: TERMINAL_ONE });
      // Wanted via the board; the launch's own claim on it adds no second entry.
      expect(lastDesiredStreams()).toEqual([TERMINAL_ONE]);
      expect(entryOf(TERMINAL_ONE)).toMatchObject({ kind: 'command-terminal', projectId: PROJECT_ID });
    });

    it('clears any started launch, listed or not, in the first reconcile after its grace has passed', () => {
      const listedLaunchId = startLaunch(TERMINAL_ONE, 1);
      const unlistedLaunchId = startLaunch(TERMINAL_TWO, 2);
      publishBoard([commandTerminalWire({ sessionId: TERMINAL_ONE })]);
      expect(launchOf(listedLaunchId)).toBeDefined();
      expect(launchOf(unlistedLaunchId)).toBeDefined();

      vi.advanceTimersByTime(LAUNCH_LISTING_GRACE_MS);
      publishBoard([commandTerminalWire({ sessionId: TERMINAL_ONE })]);

      expect(launchOf(listedLaunchId)).toBeUndefined();
      expect(launchOf(unlistedLaunchId)).toBeUndefined();
      // The board still lists the first, so clearing its launch cost it nothing.
      expect(hasEntry(TERMINAL_ONE)).toBe(true);
      expect(lastDesiredStreams()).toEqual([TERMINAL_ONE]);
      expect(hasEntry(TERMINAL_TWO)).toBe(false);
    });

    /**
     * The other half of the race rule above: "not listed" AFTER "listed" means
     * the terminal ENDED, not that the board has yet to catch up. Before
     * `listedOnce`, a terminal started from this phone and stopped inside its
     * grace window stayed wanted, drawn on the sheet and button, and
     * "Stopping...", until a reconcile ran after the grace (none does on a
     * quiet desktop).
     *
     * Mutation seen failing: dropping `!launch.listedOnce` from
     * selectUnlistedStartedLaunches - the ended terminal is re-registered and
     * wanted again.
     */
    it('stops protecting a launch the moment its terminal, once listed, leaves the board', () => {
      startLaunch(TERMINAL_ONE);
      publishBoard([commandTerminalWire({ sessionId: TERMINAL_ONE })]);
      useCommandTerminalStore.getState().markStopping(TERMINAL_ONE);
      pushActivity(TERMINAL_ONE, { type: 'session-ended', intentional: true });

      publishBoard([]);

      expect(lastDesiredStreams()).toEqual([]);
      expect(hasEntry(TERMINAL_ONE)).toBe(false);
      expect(useCommandTerminalStore.getState().stopsBySessionId).toEqual({});
      const launches = Object.values(useCommandTerminalStore.getState().launchesById);
      expect(projectTerminals(selectCommandTerminals(useBoardStore.getState(), PROJECT_ID), launches, PROJECT_ID)).toEqual([]);
    });

    it('leaves a start that has not been answered, and one that failed, alone', () => {
      const store = useCommandTerminalStore.getState();
      const startingLaunchId = store.beginLaunch(PROJECT_ID, 1);
      const failedLaunchId = store.beginLaunch(PROJECT_ID, 2);
      store.markLaunchFailed(failedLaunchId, "The desktop didn't answer.");

      vi.advanceTimersByTime(LAUNCH_LISTING_GRACE_MS * 2);
      publishBoard([]);

      expect(launchOf(startingLaunchId)?.phase).toBe('starting');
      expect(launchOf(failedLaunchId)?.phase).toBe('failed');
      expect(lastDesiredStreams()).toEqual([]);
    });
  });

  describe('a Stop in stopsBySessionId', () => {
    it('is cleared once no board lists the terminal any more, and survives snapshots that still do', () => {
      const store = useCommandTerminalStore.getState();
      publishBoard([commandTerminalWire({ sessionId: TERMINAL_ONE }), commandTerminalWire({ sessionId: TERMINAL_TWO, slot: 2 })]);
      store.markStopping(TERMINAL_ONE);
      store.markStopFailed(TERMINAL_TWO);

      // Both terminals still listed: neither stop is over.
      publishBoard([commandTerminalWire({ sessionId: TERMINAL_ONE }), commandTerminalWire({ sessionId: TERMINAL_TWO, slot: 2 })]);
      expect(useCommandTerminalStore.getState().stopsBySessionId).toEqual({ [TERMINAL_ONE]: 'stopping', [TERMINAL_TWO]: 'failed' });

      // The first goes: its "Stopping..." goes with the row. The second stays.
      publishBoard([commandTerminalWire({ sessionId: TERMINAL_TWO, slot: 2 })]);
      expect(useCommandTerminalStore.getState().stopsBySessionId).toEqual({ [TERMINAL_TWO]: 'failed' });

      // A failed Stop whose terminal then goes anyway (the Stop that timed out had landed).
      publishBoard([]);
      expect(useCommandTerminalStore.getState().stopsBySessionId).toEqual({});
    });
  });

  describe('a session-ended push for a terminal', () => {
    beforeEach(() => {
      publishBoard([commandTerminalWire({ sessionId: TERMINAL_ONE })]);
    });

    /**
     * The backstop for a board event that never arrives: the desktop's own
     * `command-terminals-changed` normally drops the row.
     */
    it('re-reads the terminal\'s project board', () => {
      refreshBoard.mockClear();

      pushActivity(TERMINAL_ONE, { type: 'session-ended', intentional: true });

      expect(refreshBoard).toHaveBeenCalledTimes(1);
      expect(refreshBoard).toHaveBeenCalledWith(PROJECT_ID);
      expect(entryOf(TERMINAL_ONE).feedStatus).toBe('ended');
    });

    /**
     * The sweep's only observable effect is a reconcile, which re-declares the
     * desired streams, so the count of `setDesiredStreams` calls past the
     * longest window a sweep could wait is the assertion.
     *
     * Mutation seen failing: removing the `endedEntry?.kind === 'command-terminal'`
     * early return in the activity handler - the made-up task id arms a sweep
     * and the pass after the window re-declares the streams.
     */
    it('arms no respawn sweep', () => {
      const desiredCallsBefore = setDesiredStreams.mock.calls.length;

      pushActivity(TERMINAL_ONE, { type: 'session-ended', intentional: true });
      vi.advanceTimersByTime(RESPAWN_ROW_GRACE_MS + 1);

      expect(setDesiredStreams.mock.calls.length).toBe(desiredCallsBefore);
    });

    it('does not hop to a successor it names', () => {
      const desiredCallsBefore = setDesiredStreams.mock.calls.length;

      pushActivity(TERMINAL_ONE, { type: 'session-ended', intentional: true, successorSessionId: 'sess-would-be-successor' });

      expect(setDesiredStreams.mock.calls.length).toBe(desiredCallsBefore);
      expect(lastDesiredStreams()).toEqual([TERMINAL_ONE]);
    });

    /**
     * The board's drop prunes the entry, and the desktop's end push can land
     * after it. With no entry left to say "terminal", the end (carrying the
     * desktop's made-up task id) was read as a task's: a respawn record and a
     * pending successor under that id, and an armed sweep.
     *
     * Mutation seen failing: dropping the `commandTerminalSessionIds` clause
     * from activityStore's `ownedByTask` - the made-up task id gets a record.
     */
    it('treats an end that lands after the board dropped the terminal as a terminal end too', () => {
      publishBoard([]);
      expect(hasEntry(TERMINAL_ONE)).toBe(false);
      const desiredCallsBefore = setDesiredStreams.mock.calls.length;

      pushActivity(TERMINAL_ONE, { type: 'session-ended', intentional: true, successorSessionId: 'sess-would-be-successor' });
      vi.advanceTimersByTime(RESPAWN_ROW_GRACE_MS + 1);

      expect(useActivityStore.getState().respawnByTaskId).toEqual({});
      expect(useActivityStore.getState().pendingSuccessorByTaskId).toEqual({});
      expect(setDesiredStreams.mock.calls.length).toBe(desiredCallsBefore);
      // The end itself is still recorded, for a screen still bound to it.
      expect(useActivityStore.getState().endedSessionIds[TERMINAL_ONE]).toBe(true);
    });

    it('arms the sweep for a TASK session end (the control that proves the sweep is observable here)', () => {
      publishBoard([], [boardTaskFixture({ id: 'task-1', session_id: 'sess-task' })]);
      const desiredCallsBefore = setDesiredStreams.mock.calls.length;

      deliverMessage?.({
        type: 'event',
        event: { kind: 'activity', sessionId: 'sess-task', taskId: 'task-1', payload: { type: 'session-ended', intentional: true } },
      });
      expect(setDesiredStreams.mock.calls.length).toBe(desiredCallsBefore);

      vi.advanceTimersByTime(ENDED_ROW_GRACE_MS + 1);
      expect(setDesiredStreams.mock.calls.length).toBe(desiredCallsBefore + 1);
    });
  });

  describe('a diff event for a project folder', () => {
    const projectFolderKey = diffKeyFor({ taskId: null, projectId: PROJECT_ID });

    const pushDiff = (target: { taskId?: string; projectId?: string }): void => {
      if (!deliverMessage) throw new Error('feed not wired');
      deliverMessage({ type: 'event', event: { kind: 'diff', payload: null, ...target } });
    };

    it('marks the project-folder key stale and re-fetches it, leaving a task\'s key alone', () => {
      useDiffStore.getState().setStatus(projectFolderKey, 'working', 'loading');
      useDiffStore.getState().setStatus('task-1', 'working', 'loading');

      pushDiff({ projectId: PROJECT_ID });

      expect(projectFolderKey).toBe(`project:${PROJECT_ID}`);
      expect(useDiffStore.getState().byKey[projectFolderKey]?.stale).toBe(true);
      expect(useDiffStore.getState().byKey['task-1']?.stale).toBe(false);
      expect(refreshDiff).toHaveBeenCalledTimes(1);
      expect(refreshDiff).toHaveBeenCalledWith(projectFolderKey);
    });

    it('still keys a task\'s diff event by the task id (the control)', () => {
      useDiffStore.getState().setStatus('task-1', 'working', 'loading');
      useDiffStore.getState().setStatus(projectFolderKey, 'working', 'loading');

      pushDiff({ taskId: 'task-1' });

      expect(useDiffStore.getState().byKey['task-1']?.stale).toBe(true);
      expect(useDiffStore.getState().byKey[projectFolderKey]?.stale).toBe(false);
      expect(refreshDiff).toHaveBeenCalledWith('task-1');
    });
  });
});
