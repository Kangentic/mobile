/**
 * storeFeed's share of protocol 0.16.0's session lifecycle: the live `status`
 * push, the successor hop, and a paused task's row held by the board.
 *
 * Three behaviours, each with its own failure:
 *   1. THE SUSPEND HOLD. The desktop pushes `status: 'suspended'` up to ~3 s
 *      before the PTY exit's `session-ended`, and suspends ahead of every
 *      respawn. Applied at once, a model switch read "Paused" (and moved its
 *      Agents row into Paused) for the whole gap.
 *   2. THE SUCCESSOR HOP. A resume of a paused row ends that row's feed naming
 *      a new session id. The phone subscribes it at once, keeps the ghost's row
 *      until the successor's own snapshot, and never draws the task twice.
 *   3. BOARD-HELD RETENTION. A desktop pause clears `session_id`, and the
 *      `'sessions'` board keeps the task with `resumable: true`, so the ended
 *      session's row stays as the Paused card for as long as the board says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTaskWire } from '@kangentic/protocol';
import type { SubscriptionManager } from '@/channel/subscriptionManager';
import { SUSPEND_PUSH_HOLD_MS, bindFeedToStores, createSnapshotSinks } from '@/connection/storeFeed';
import { FeedRouter } from '@/channel/feedRouter';
import type { SessionManager } from '@/channel/sessionManager';
import { cardSessionDisplay, toCardSession } from '@/components/board/cardSessionDisplay';
import { feedSectionForEntry } from '@/screens/home/feedSections';
import { ENDED_ROW_GRACE_MS, RESPAWN_ROW_GRACE_MS, selectTaskRespawn, useActivityStore } from '@/state/activityStore';
import { findTaskById, useBoardStore } from '@/state/boardStore';
import { boardSnapshotFixture, boardTaskFixture, streamSnapshotFixture, usageFixture } from '@/devsupport/desktopFixtures';

const PROJECT_ID = 'project-1';
const TASK_ID = 'task-lifecycle';
const OLD_SESSION_ID = 'sess-old';
const NEW_SESSION_ID = 'sess-new';

describe('storeFeed and the 0.16.0 session lifecycle', () => {
  let deliverMessage: ((message: unknown) => void) | null = null;
  let sinks: ReturnType<typeof createSnapshotSinks>;
  let unbind: (() => void) | null = null;
  let feed: FeedRouter | null = null;
  let setDesiredStreams: ReturnType<typeof vi.fn>;

  /** A `view: 'sessions'` board carrying the task as given (no task at all for null). */
  const publishBoard = (task: Partial<BoardTaskWire> | null): void => {
    sinks.onBoardSnapshot(
      boardSnapshotFixture({
        projectId: PROJECT_ID,
        view: 'sessions',
        tasks: task === null ? [] : [boardTaskFixture({ id: TASK_ID, swimlane_id: 'lane-doing', ...task })],
      }),
    );
  };

  const pushActivity = (sessionId: string, payload: Record<string, unknown>): void => {
    if (!deliverMessage) throw new Error('feed not wired');
    deliverMessage({ type: 'event', event: { kind: 'activity', sessionId, taskId: TASK_ID, payload } });
  };
  const pushStatus = (sessionId: string, status: string, resumable = true): void =>
    pushActivity(sessionId, { type: 'status', status, resuming: false, resumable });
  const pushEnded = (sessionId: string, extra: Record<string, unknown> = {}): void =>
    pushActivity(sessionId, { type: 'session-ended', intentional: true, ...extra });

  const entryOf = (sessionId: string) => useActivityStore.getState().bySessionId[sessionId];
  const hasRow = (sessionId: string): boolean => entryOf(sessionId) !== undefined;
  /** What the task's card draws, read exactly the way the feed row reads it. */
  const displayOf = (sessionId: string | null) =>
    cardSessionDisplay({
      session: toCardSession(sessionId === null ? null : (entryOf(sessionId) ?? null)),
      respawn: selectTaskRespawn(useActivityStore.getState(), TASK_ID),
      task: findTaskById(useBoardStore.getState(), TASK_ID)?.task ?? null,
    });
  const lastDesiredStreams = (): string[] => {
    const calls = setDesiredStreams.mock.calls;
    const last = calls[calls.length - 1]?.[0] as ReadonlySet<string> | undefined;
    return last === undefined ? [] : [...last].sort();
  };

  beforeEach(() => {
    vi.useFakeTimers();
    useActivityStore.getState().reset();
    useBoardStore.getState().reset();
    const fakeSessionManager = {
      onMessage: (listener: (message: unknown) => void) => {
        deliverMessage = listener;
        return () => {
          deliverMessage = null;
        };
      },
    } as unknown as SessionManager;
    setDesiredStreams = vi.fn();
    const fakeSubscriptions = {
      refreshStream: vi.fn(),
      refreshBoard: vi.fn(),
      refreshDiff: vi.fn(),
      setDesiredStreams,
    } as unknown as SubscriptionManager;
    sinks = createSnapshotSinks(() => fakeSubscriptions);
    feed = new FeedRouter(fakeSessionManager);
    unbind = bindFeedToStores(feed, fakeSubscriptions);
  });

  afterEach(() => {
    unbind?.();
    feed?.dispose();
    useActivityStore.getState().reset();
    useBoardStore.getState().reset();
    vi.useRealTimers();
  });

  describe('the suspend hold', () => {
    beforeEach(() => {
      publishBoard({ session_id: OLD_SESSION_ID });
      sinks.onStreamSnapshot(OLD_SESSION_ID, streamSnapshotFixture({ sessionStatus: 'running' }));
    });

    /**
     * The model switch: suspended pushed first, the labelled end behind it.
     * At no point between them may the card read Paused, or the row sit in
     * the Paused section.
     */
    it('never lets a respawn read Paused: the suspended push waits for its labelled end', () => {
      pushStatus(OLD_SESSION_ID, 'suspended');

      expect(entryOf(OLD_SESSION_ID).sessionStatus).toBe('running');
      expect(displayOf(OLD_SESSION_ID).kind).toBe('running');

      pushEnded(OLD_SESSION_ID, { spawnProgressLabel: 'Switching model...' });

      expect(entryOf(OLD_SESSION_ID).sessionStatus).toBe('suspended');
      expect(displayOf(OLD_SESSION_ID)).toEqual({ kind: 'preparing', label: 'Switching model...' });
    });

    it('reads a genuine pause as Paused at its unlabelled end', () => {
      pushStatus(OLD_SESSION_ID, 'suspended');
      pushEnded(OLD_SESSION_ID);

      expect(displayOf(OLD_SESSION_ID)).toEqual({ kind: 'suspended' });
      expect(entryOf(OLD_SESSION_ID).resumable).toBe(true);
    });

    it('applies a held suspend on its own once the cap passes with no end', () => {
      pushStatus(OLD_SESSION_ID, 'suspended');

      vi.advanceTimersByTime(SUSPEND_PUSH_HOLD_MS - 1);
      expect(entryOf(OLD_SESSION_ID).sessionStatus).toBe('running');

      vi.advanceTimersByTime(2);
      expect(entryOf(OLD_SESSION_ID).sessionStatus).toBe('suspended');
    });

    it('drops a held suspend when a newer status supersedes it', () => {
      pushStatus(OLD_SESSION_ID, 'suspended');
      pushStatus(OLD_SESSION_ID, 'running', false);
      vi.advanceTimersByTime(SUSPEND_PUSH_HOLD_MS * 2);

      expect(entryOf(OLD_SESSION_ID).sessionStatus).toBe('running');
    });

    it('applies a push for a session that is ALREADY suspended at once (only resumable changed)', () => {
      sinks.onStreamSnapshot(OLD_SESSION_ID, streamSnapshotFixture({ sessionStatus: 'suspended', resumable: true }));
      pushStatus(OLD_SESSION_ID, 'suspended', false);

      expect(entryOf(OLD_SESSION_ID).resumable).toBe(false);
    });

    it('applies every other status at once', () => {
      pushStatus(OLD_SESSION_ID, 'exited', false);

      expect(entryOf(OLD_SESSION_ID).sessionStatus).toBe('exited');
      // An 'exited' status is not an end: the session-ended push stays the authority.
      expect(entryOf(OLD_SESSION_ID).feedStatus).toBe('live');
    });

    it('drops a held suspend when the feed unbinds', () => {
      pushStatus(OLD_SESSION_ID, 'suspended');
      unbind?.();
      unbind = null;
      vi.advanceTimersByTime(SUSPEND_PUSH_HOLD_MS * 2);

      expect(entryOf(OLD_SESSION_ID).sessionStatus).toBe('running');
    });
  });

  describe('the successor hop', () => {
    /** A paused row the phone holds a feed on: the idle-timeout suspend leaves session_id on it. */
    beforeEach(() => {
      publishBoard({ session_id: OLD_SESSION_ID, resumable: true });
      sinks.onStreamSnapshot(OLD_SESSION_ID, streamSnapshotFixture({ sessionStatus: 'suspended', resumable: true }));
      setDesiredStreams.mockClear();
    });

    const pushResumedEnd = (): void =>
      pushEnded(OLD_SESSION_ID, { spawnProgressLabel: 'Resuming session...', successorSessionId: NEW_SESSION_ID });

    it('subscribes the named successor at once, before any board names it, and keeps the ghost\'s row', () => {
      pushResumedEnd();

      expect(lastDesiredStreams()).toEqual([NEW_SESSION_ID]);
      expect(hasRow(OLD_SESSION_ID)).toBe(true);
      // Not registered until its own snapshot: the ghost still reads the step.
      expect(hasRow(NEW_SESSION_ID)).toBe(false);
      expect(displayOf(OLD_SESSION_ID)).toEqual({ kind: 'preparing', label: 'Resuming session...' });
    });

    it('registers the successor on its snapshot in the ghost\'s place, reading "Resuming agent..."', () => {
      pushResumedEnd();
      sinks.onStreamSnapshot(NEW_SESSION_ID, streamSnapshotFixture({ sessionStatus: 'running', resuming: true, usage: null }));

      expect(hasRow(OLD_SESSION_ID)).toBe(false);
      expect(entryOf(NEW_SESSION_ID).taskId).toBe(TASK_ID);
      expect(entryOf(NEW_SESSION_ID).projectId).toBe(PROJECT_ID);
      expect(displayOf(NEW_SESSION_ID)).toEqual({ kind: 'running', resuming: true });
      // The ghost was paused and resumable; the successor must not inherit either.
      expect(entryOf(NEW_SESSION_ID).resumable).toBe(false);
    });

    /**
     * The interleaving the one-row-per-task rule exists for: a board refresh
     * lands between the end and the successor's snapshot, showing the task
     * sessionless with the resume's label (which VOUCHES for the ghost). The
     * successor's registration must still release the ghost.
     */
    it('draws one row when a vouching board refresh lands between the end and the successor\'s snapshot', () => {
      pushResumedEnd();
      publishBoard({ session_id: null, spawn_progress: 'Resuming session...', resumable: true });
      expect(lastDesiredStreams()).toEqual([NEW_SESSION_ID]);

      sinks.onStreamSnapshot(NEW_SESSION_ID, streamSnapshotFixture({ sessionStatus: 'running', resuming: true, usage: null }));

      expect(Object.keys(useActivityStore.getState().bySessionId)).toEqual([NEW_SESSION_ID]);
    });

    it('releases the pending successor once the board names it', () => {
      pushResumedEnd();
      publishBoard({ session_id: NEW_SESSION_ID });

      expect(useActivityStore.getState().pendingSuccessorByTaskId[TASK_ID]).toBeUndefined();
      expect(lastDesiredStreams()).toEqual([NEW_SESSION_ID]);
    });

    it('stops wanting a successor no board ever confirms once its window passes', () => {
      pushResumedEnd();
      publishBoard({ session_id: null });

      vi.advanceTimersByTime(RESPAWN_ROW_GRACE_MS + 1);

      expect(lastDesiredStreams()).toEqual([]);
      expect(useActivityStore.getState().pendingSuccessorByTaskId[TASK_ID]).toBeUndefined();
    });

    it('fills in a snapshot\'s owner from the registered entry when no board lists the session', () => {
      // A snapshot that beats the board used to blank the entry's taskId to ''.
      publishBoard(null);
      useActivityStore.getState().registerSession('sess-unlisted', TASK_ID, PROJECT_ID);
      sinks.onStreamSnapshot('sess-unlisted', streamSnapshotFixture({ sessionStatus: 'running' }));

      expect(entryOf('sess-unlisted')?.taskId).toBe(TASK_ID);
      expect(entryOf('sess-unlisted')?.projectId).toBe(PROJECT_ID);
    });
  });

  describe('a paused task\'s row, held by the board', () => {
    beforeEach(() => {
      publishBoard({ session_id: OLD_SESSION_ID });
      sinks.onStreamSnapshot(OLD_SESSION_ID, streamSnapshotFixture({ sessionStatus: 'running', usage: usageFixture() }));
    });

    const pauseOnDesktop = (): void => {
      pushStatus(OLD_SESSION_ID, 'suspended');
      pushEnded(OLD_SESSION_ID);
      publishBoard({ session_id: null, resumable: true });
    };

    it('keeps the ended session\'s row as the Paused card past the end\'s window, while the board says resumable', () => {
      pauseOnDesktop();

      vi.advanceTimersByTime(ENDED_ROW_GRACE_MS + 1);

      expect(hasRow(OLD_SESSION_ID)).toBe(true);
      expect(displayOf(OLD_SESSION_ID)).toEqual({ kind: 'suspended' });
      expect(feedSectionForEntry(entryOf(OLD_SESSION_ID), {
        ...useActivityStore.getState(),
        boardsByProjectId: useBoardStore.getState().boardsByProjectId,
      })).toBe('paused');
    });

    it('drops the expired respawn record at the sweep, a store write that re-renders the held row', () => {
      pauseOnDesktop();
      expect(useActivityStore.getState().respawnByTaskId[TASK_ID]).toBeDefined();

      vi.advanceTimersByTime(ENDED_ROW_GRACE_MS + 1);

      expect(useActivityStore.getState().respawnByTaskId[TASK_ID]).toBeUndefined();
    });

    it('lets the row go once the board stops vouching for the task (moved to Done)', () => {
      pauseOnDesktop();
      vi.advanceTimersByTime(ENDED_ROW_GRACE_MS + 1);

      publishBoard({ session_id: null, resumable: false });

      expect(hasRow(OLD_SESSION_ID)).toBe(false);
    });

    /**
     * An entry whose end the phone never saw (it was offline through the
     * pause) still LOOKS running. Holding it would draw a running card for a
     * paused task; pruning it lets the feed's task row draw the truth.
     */
    it('does not hold an entry the desktop never ended', () => {
      publishBoard({ session_id: null, resumable: true });

      expect(hasRow(OLD_SESSION_ID)).toBe(false);
    });

    it('releases the held row the moment the resumed session lands on the board', () => {
      pauseOnDesktop();
      vi.advanceTimersByTime(ENDED_ROW_GRACE_MS + 1);

      publishBoard({ session_id: NEW_SESSION_ID });

      expect(hasRow(OLD_SESSION_ID)).toBe(false);
      expect(hasRow(NEW_SESSION_ID)).toBe(true);
    });
  });
});
