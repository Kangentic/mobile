/**
 * The respawn-gap retention in reconcileSessionsFromBoards.
 *
 * During a desktop-driven respawn the task is sessionless for several seconds:
 * the desktop suspends the old session (pushing `session-ended` with its
 * spawn-progress label), the board's `view: 'sessions'` projection drops the
 * task, and the reconciler used to delete the activity entry outright. The Home
 * feed builds its rows from `bySessionId` alone, so the row VANISHED for the
 * whole gap and then reappeared under the successor's id - named as a known
 * gap in 14aa6bd's own commit message, which fixed only the session screen.
 *
 * Three things have to hold together, and each is a separate failure:
 *   1. the entry survives the snapshot that drops its session,
 *   2. it is released by the snapshot that installs the successor - in that
 *      SAME pass, or the task would briefly own two rows,
 *   3. it is released on a clock when no successor ever lands, because board
 *      snapshots are event-driven and a quiet desktop sends no more of them.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SubscriptionManager } from '@/channel/subscriptionManager';
import { bindFeedToStores, createSnapshotSinks } from '@/connection/storeFeed';
import { FeedRouter } from '@/channel/feedRouter';
import type { SessionManager } from '@/channel/sessionManager';
import { ENDED_ROW_GRACE_MS, RESPAWN_ROW_GRACE_MS, useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { boardSnapshotFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

const PROJECT_ID = 'project-1';
const TASK_ID = 'task-respawn';
const OLD_SESSION_ID = 'sess-old';
const NEW_SESSION_ID = 'sess-new';

describe('reconcileSessionsFromBoards keeps a respawning task on screen', () => {
  let deliverMessage: ((message: unknown) => void) | null = null;
  let sinks: ReturnType<typeof createSnapshotSinks>;
  let unbind: (() => void) | null = null;
  let feed: FeedRouter | null = null;

  /** A `view: 'sessions'` board carrying the task with whichever session owns it, or none. */
  const publishBoard = (sessionId: string | null): void => {
    sinks.onBoardSnapshot(
      boardSnapshotFixture({
        projectId: PROJECT_ID,
        view: 'sessions',
        tasks: sessionId === null ? [] : [boardTaskFixture({ id: TASK_ID, session_id: sessionId })],
      }),
    );
  };

  /**
   * The desktop's end push for the outgoing session: naming the phase it is
   * entering (a labelled respawn), or saying nothing (the desktop's column-move
   * swap, or a park - indistinguishable when the push lands).
   */
  const pushRespawnEnded = (label: string | null = 'Switching model...'): void => {
    if (!deliverMessage) throw new Error('feed not wired');
    deliverMessage({
      type: 'event',
      event: {
        kind: 'activity',
        sessionId: OLD_SESSION_ID,
        taskId: TASK_ID,
        payload:
          label === null
            ? { type: 'session-ended', intentional: true }
            : { type: 'session-ended', intentional: true, spawnProgressLabel: label },
      },
    });
  };

  const hasRow = (sessionId: string): boolean => useActivityStore.getState().bySessionId[sessionId] !== undefined;

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
    const fakeSubscriptions = {
      refreshStream: vi.fn(),
      refreshBoard: vi.fn(),
      refreshDiff: vi.fn(),
      setDesiredStreams: vi.fn(),
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

  /**
   * The headline behaviour. Note the assertion is on the ENTRY surviving, not
   * on anything rendered: the row is drawn from `bySessionId`, so an entry that
   * is gone is a row that cannot exist no matter what the screen does.
   */
  it('keeps the ended session entry while the desktop says a respawn is in flight', () => {
    publishBoard(OLD_SESSION_ID);
    expect(hasRow(OLD_SESSION_ID)).toBe(true);

    pushRespawnEnded();
    publishBoard(null);

    expect(hasRow(OLD_SESSION_ID)).toBe(true);
  });

  /**
   * An UNLABELLED end is retained too, but on the short window. The desktop's
   * own column-move swap arrives with no label and cannot be told from a park
   * when the push lands, so the row must survive the gap either way; the
   * short grace is what stops a park lingering. Two halves, two mutations:
   * the label-only store write fails the first assertion, a sweep that still
   * skips unlabelled ends fails the last (the row would never prune).
   */
  it('keeps an unlabelled ended session for the short grace, then prunes it on the clock', () => {
    publishBoard(OLD_SESSION_ID);
    pushRespawnEnded(null);
    publishBoard(null);
    expect(hasRow(OLD_SESSION_ID)).toBe(true);

    vi.advanceTimersByTime(ENDED_ROW_GRACE_MS - 1);
    expect(hasRow(OLD_SESSION_ID)).toBe(true);

    vi.advanceTimersByTime(2);

    expect(hasRow(OLD_SESSION_ID)).toBe(false);
  });

  /** The two windows are different: a labelled end (explicit desktop intent) outlives the short grace. */
  it('keeps a labelled end past the short grace, since the desktop said a successor is coming', () => {
    publishBoard(OLD_SESSION_ID);
    pushRespawnEnded();
    publishBoard(null);

    vi.advanceTimersByTime(ENDED_ROW_GRACE_MS + 1);

    expect(hasRow(OLD_SESSION_ID)).toBe(true);
  });

  /**
   * One snapshot does both halves. `reconcileSessionsFromBoards` registers
   * every live session BEFORE it prunes, and `registerSession` clears the
   * task's respawn - so by the time the prune loop asks, the answer is already
   * "no respawn in flight". Asserting both rows in the same tick is what makes
   * this a test of the ORDERING rather than of eventual convergence.
   */
  it('releases the ghost in the same snapshot that installs the successor', () => {
    publishBoard(OLD_SESSION_ID);
    pushRespawnEnded();
    publishBoard(null);
    expect(hasRow(OLD_SESSION_ID)).toBe(true);

    publishBoard(NEW_SESSION_ID);

    expect(hasRow(OLD_SESSION_ID)).toBe(false);
    expect(hasRow(NEW_SESSION_ID)).toBe(true);
  });

  /**
   * The respawn that never lands. There is no further board snapshot here on
   * purpose - that is the whole point: board snapshots are event-driven, so on
   * a quiet desktop nothing would re-run the prune and the row would sit there
   * claiming "Switching model..." indefinitely. The timer armed by the activity
   * handler is the only thing that clears it.
   */
  it('prunes the ghost on a clock when no successor and no further snapshot arrive', () => {
    publishBoard(OLD_SESSION_ID);
    pushRespawnEnded();
    publishBoard(null);

    vi.advanceTimersByTime(RESPAWN_ROW_GRACE_MS - 1);
    expect(hasRow(OLD_SESSION_ID)).toBe(true);

    vi.advanceTimersByTime(2);

    expect(hasRow(OLD_SESSION_ID)).toBe(false);
  });

  /**
   * Unbinding tears the feed down, so a sweep must not fire against a
   * disconnected channel afterwards. Asserted by the entry SURVIVING: if the
   * timer had outlived the unbind it would have reconciled and pruned.
   */
  it('drops a pending sweep when the feed unbinds', () => {
    publishBoard(OLD_SESSION_ID);
    pushRespawnEnded();
    publishBoard(null);

    unbind?.();
    unbind = null;
    vi.advanceTimersByTime(RESPAWN_ROW_GRACE_MS * 2);

    expect(hasRow(OLD_SESSION_ID)).toBe(true);
  });
});
