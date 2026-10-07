/**
 * feedSections: the Agents feed's section model. The four titles the user sees
 * and the section filter lists, the partition of sessions into sections (queued
 * and suspended sessions leave their activity bucket), the order inside Queued
 * and Paused, and the per-title counts the filter shows.
 *
 * Entries are built through the activity store's own registerSession and
 * applySnapshot, so each one is a complete SessionActivityEntry (it carries
 * fields such as `resumable` that a hand-written literal would have to track).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActivityReasonWire, ActivityStateWire, BoardTaskWire, ReadStreamSessionStatusWire } from '@kangentic/protocol';
import {
  FEED_SECTION_DISPLAY_TITLES,
  countFeedSectionsByTitle,
  feedRowKey,
  selectFeedSections,
  type FeedSection,
  type FeedSectionSources,
} from '@/screens/home/feedSections';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { boardSnapshotFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';

/** The store slices the feed reads, as the screen hands them over. */
function feedSources(): FeedSectionSources {
  const activityState = useActivityStore.getState();
  return {
    bySessionId: activityState.bySessionId,
    respawnByTaskId: activityState.respawnByTaskId,
    spawnProgressLabelBySessionId: activityState.spawnProgressLabelBySessionId,
    boardsByProjectId: useBoardStore.getState().boardsByProjectId,
  };
}

/** Installs one project's `'sessions'` board holding exactly these tasks. */
function seedBoard(tasks: BoardTaskWire[]): void {
  useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-1', tasks, view: 'sessions' }));
}

const REASON_FOR_STATE: Record<ActivityStateWire, ActivityReasonWire> = {
  thinking: { kind: 'turn-active' },
  idle: { kind: 'idle' },
  permission: { kind: 'permission' },
};

interface SeededSession {
  state: ActivityStateWire;
  sessionStatus: ReadStreamSessionStatusWire;
  /** The feed's ordering key, pinned so the order under test is the one written here and not the wall clock's. */
  enteredSectionAt: number;
}

function seedSession(sessionId: string, { state, sessionStatus, enteredSectionAt }: SeededSession): void {
  const taskId = `task-for-${sessionId}`;
  useActivityStore.getState().registerSession(sessionId, taskId, 'project-1');
  useActivityStore.getState().applySnapshot(
    sessionId,
    taskId,
    'project-1',
    streamSnapshotFixture({ activity: { state, reason: REASON_FOR_STATE[state] }, sessionStatus }),
  );
  useActivityStore.setState((current) => ({
    bySessionId: { ...current.bySessionId, [sessionId]: { ...current.bySessionId[sessionId], enteredSectionAt } },
  }));
}

/** Every row's key in one section: a session row's session id, a task row's `task-<id>`. */
function sessionIdsIn(section: FeedSection): string[] {
  const found = selectFeedSections(feedSources()).find((candidate) => candidate.section === section);
  if (found === undefined) throw new Error(`selectFeedSections returned no "${section}" section`);
  return found.rows.map(feedRowKey);
}

/**
 * Three running sessions, one per activity bucket, then four queued and four
 * suspended ones spread across the same buckets.
 *
 * The spread is what makes the order and partition assertions able to fail. A
 * Queued or Paused list built by walking the activity buckets in turn would
 * come out in BUCKET order (needs-you, working, idle). Each queued and paused
 * set below is arranged so that bucket order, insertion order and the correct
 * order all differ: dropping the feed's own sort, or its tiebreak, changes the
 * result. The two tied entries sit in different buckets for the same reason, and
 * the tied pair is registered b before a so insertion order does not hand over
 * the right answer either.
 */
function seedMixedFeed(): void {
  seedSession('sess-run-permission', { state: 'permission', sessionStatus: 'running', enteredSectionAt: 500 });
  seedSession('sess-run-working', { state: 'thinking', sessionStatus: 'running', enteredSectionAt: 500 });
  seedSession('sess-run-idle', { state: 'idle', sessionStatus: 'running', enteredSectionAt: 500 });

  seedSession('sess-queued-tie-b', { state: 'permission', sessionStatus: 'queued', enteredSectionAt: 2000 });
  seedSession('sess-queued-old', { state: 'thinking', sessionStatus: 'queued', enteredSectionAt: 1000 });
  seedSession('sess-queued-new', { state: 'idle', sessionStatus: 'queued', enteredSectionAt: 3000 });
  seedSession('sess-queued-tie-a', { state: 'idle', sessionStatus: 'queued', enteredSectionAt: 2000 });

  seedSession('sess-paused-tie-b', { state: 'permission', sessionStatus: 'suspended', enteredSectionAt: 5000 });
  seedSession('sess-paused-old', { state: 'thinking', sessionStatus: 'suspended', enteredSectionAt: 4000 });
  seedSession('sess-paused-new', { state: 'idle', sessionStatus: 'suspended', enteredSectionAt: 6000 });
  seedSession('sess-paused-tie-a', { state: 'idle', sessionStatus: 'suspended', enteredSectionAt: 5000 });
}

beforeEach(() => {
  useActivityStore.getState().reset();
  useBoardStore.getState().reset();
});

describe('FEED_SECTION_DISPLAY_TITLES', () => {
  it('lists the four sections the user sees, once each, in display order', () => {
    // needs-you and idle both display as "Idle", so the list must collapse them
    // to one title rather than carry it twice.
    expect(FEED_SECTION_DISPLAY_TITLES).toEqual(['Idle', 'Active', 'Queued', 'Paused']);
  });
});

describe('selectFeedSections', () => {
  it('moves queued and suspended sessions out of their activity bucket into Queued and Paused', () => {
    seedMixedFeed();

    expect(sessionIdsIn('needs-you')).toEqual(['sess-run-permission']);
    expect(sessionIdsIn('working')).toEqual(['sess-run-working']);
    expect(sessionIdsIn('idle')).toEqual(['sess-run-idle']);
    expect([...sessionIdsIn('queued')].sort()).toEqual(['sess-queued-new', 'sess-queued-old', 'sess-queued-tie-a', 'sess-queued-tie-b']);
    expect([...sessionIdsIn('paused')].sort()).toEqual(['sess-paused-new', 'sess-paused-old', 'sess-paused-tie-a', 'sess-paused-tie-b']);
  });

  it('puts every session in exactly one section', () => {
    seedMixedFeed();

    const placedSessionIds = selectFeedSections(feedSources()).flatMap((section) => section.rows.map(feedRowKey));

    expect([...placedSessionIds].sort()).toEqual(Object.keys(useActivityStore.getState().bySessionId).sort());
    expect(placedSessionIds).toHaveLength(11);
  });

  it('orders Queued newest arrival first, breaking a tie by ascending session id', () => {
    seedMixedFeed();

    expect(sessionIdsIn('queued')).toEqual(['sess-queued-new', 'sess-queued-tie-a', 'sess-queued-tie-b', 'sess-queued-old']);
  });

  it('orders Paused newest arrival first, breaking a tie by ascending session id', () => {
    seedMixedFeed();

    expect(sessionIdsIn('paused')).toEqual(['sess-paused-new', 'sess-paused-tie-a', 'sess-paused-tie-b', 'sess-paused-old']);
  });

  /**
   * Within Idle, finished work the user has not seen outranks a quiet idle, even
   * a newer one. The unread session is the OLDER arrival and its id sorts last,
   * so neither the recency sort nor the id tiebreak can hand over the answer.
   */
  it('puts an unread idle session above a newer quiet one', () => {
    seedSession('sess-idle-quiet-new', { state: 'idle', sessionStatus: 'running', enteredSectionAt: 2000 });
    seedSession('sess-idle-unread-old', { state: 'idle', sessionStatus: 'running', enteredSectionAt: 1000 });
    useActivityStore.setState((current) => ({
      bySessionId: { ...current.bySessionId, 'sess-idle-unread-old': { ...current.bySessionId['sess-idle-unread-old'], unreadCount: 3 } },
    }));

    expect(sessionIdsIn('idle')).toEqual(['sess-idle-unread-old', 'sess-idle-quiet-new']);
  });
});

describe('countFeedSectionsByTitle', () => {
  it('sums needs-you and idle into Idle, and leaves queued sessions out of it', () => {
    // One needs-you and two idle running sessions make three in Idle. The queued
    // session is itself in the needs-you activity bucket: it counts under Queued
    // and must not also count under Idle.
    seedSession('sess-run-permission', { state: 'permission', sessionStatus: 'running', enteredSectionAt: 500 });
    seedSession('sess-run-idle-one', { state: 'idle', sessionStatus: 'running', enteredSectionAt: 500 });
    seedSession('sess-run-idle-two', { state: 'idle', sessionStatus: 'running', enteredSectionAt: 500 });
    seedSession('sess-run-working', { state: 'thinking', sessionStatus: 'running', enteredSectionAt: 500 });
    seedSession('sess-queued-permission', { state: 'permission', sessionStatus: 'queued', enteredSectionAt: 500 });

    const counts = countFeedSectionsByTitle(feedSources());

    expect(Object.fromEntries(counts)).toEqual({ Idle: 3, Active: 1, Queued: 1, Paused: 0 });
    expect([...counts.keys()]).toEqual(['Idle', 'Active', 'Queued', 'Paused']);
  });

  it('reports 0 for every displayed section when no session exists', () => {
    const counts = countFeedSectionsByTitle(feedSources());

    expect(Object.fromEntries(counts)).toEqual({ Idle: 0, Active: 0, Queued: 0, Paused: 0 });
  });

  it('counts a sessionless task row under its section', () => {
    seedBoard([boardTaskFixture({ id: 'task-paused', swimlane_id: 'lane-doing', session_id: null, resumable: true })]);

    expect(Object.fromEntries(countFeedSectionsByTitle(feedSources()))).toEqual({ Idle: 0, Active: 0, Queued: 0, Paused: 1 });
  });
});

/** A session for an explicit task, built through the store's own actions like seedSession. */
function seedTaskSession(sessionId: string, taskId: string, state: ActivityStateWire, sessionStatus: ReadStreamSessionStatusWire): void {
  useActivityStore.getState().registerSession(sessionId, taskId, 'project-1');
  useActivityStore
    .getState()
    .applySnapshot(sessionId, taskId, 'project-1', streamSnapshotFixture({ activity: { state, reason: REASON_FOR_STATE[state] }, sessionStatus }));
}

function sectionOf(rowKey: string): FeedSection | null {
  return selectFeedSections(feedSources()).find((section) => section.rows.some((row) => feedRowKey(row) === rowKey))?.section ?? null;
}

/**
 * Protocol 0.16.0: the desktop keeps a sessionless task in its `'sessions'`
 * projection when it carries a spawn label or a Resume, and a board row can
 * carry both at once (the suspended row counts as paused through every respawn
 * gap and every resume's git phase). The section has to come from what the row
 * WAS, or a model switch hops it into Paused and a Resume moves it twice.
 */
describe('selectFeedSections - the 0.16.0 board row', () => {
  it('draws a sessionless resumable task as a Paused task row', () => {
    seedBoard([boardTaskFixture({ id: 'task-paused', swimlane_id: 'lane-doing', session_id: null, resumable: true })]);

    expect(sessionIdsIn('paused')).toEqual(['task-task-paused']);
  });

  it('draws a sessionless first start (labelled, not resumable) in Active', () => {
    seedBoard([boardTaskFixture({ id: 'task-starting', swimlane_id: 'lane-doing', session_id: null, spawn_progress: 'Creating worktree...' })]);

    expect(sessionIdsIn('working')).toEqual(['task-task-starting']);
  });

  it('keeps a paused task whose resume is labelled in Paused', () => {
    seedBoard([
      boardTaskFixture({ id: 'task-resuming', swimlane_id: 'lane-doing', session_id: null, spawn_progress: 'Resuming session...', resumable: true }),
    ]);

    expect(sessionIdsIn('paused')).toEqual(['task-task-resuming']);
  });

  it('draws no task row for an archived task, a task with nothing in flight, or a pre-0.16.0 row', () => {
    seedBoard([
      boardTaskFixture({ id: 'task-archived', session_id: null, resumable: true, archived_at: '2026-10-01T00:00:00.000Z' }),
      boardTaskFixture({ id: 'task-quiet', session_id: null }),
      boardTaskFixture({ id: 'task-legacy', session_id: null, spawn_progress: undefined, resumable: undefined }),
    ]);

    expect(selectFeedSections(feedSources()).flatMap((section) => section.rows)).toEqual([]);
  });

  it('draws the session row, never a second task row, for a task an entry already claims', () => {
    seedBoard([boardTaskFixture({ id: 'task-paused', swimlane_id: 'lane-doing', session_id: null, resumable: true })]);
    seedTaskSession('sess-ghost', 'task-paused', 'idle', 'running');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-ghost',
      taskId: 'task-paused',
      payload: { type: 'status', status: 'suspended', resuming: false, resumable: true },
    });
    useActivityStore.getState().applyActivityEvent({ kind: 'activity', sessionId: 'sess-ghost', taskId: 'task-paused', payload: { type: 'session-ended', intentional: true } });

    expect(sessionIdsIn('paused')).toEqual(['sess-ghost']);
  });

  it('keeps a respawning row in its activity bucket: suspended, ended with a label, the board labelled and resumable', () => {
    seedTaskSession('sess-switching', 'task-switching', 'thinking', 'running');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-switching',
      taskId: 'task-switching',
      payload: { type: 'status', status: 'suspended', resuming: false, resumable: true },
    });
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-switching',
      taskId: 'task-switching',
      payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 'Switching model...' },
    });
    seedBoard([
      boardTaskFixture({ id: 'task-switching', swimlane_id: 'lane-doing', session_id: null, spawn_progress: 'Switching model...', resumable: true }),
    ]);

    expect(sectionOf('sess-switching')).toBe('working');
  });

  it('moves a paused row once on a Resume: Paused through the label, its bucket at the labelled end', () => {
    // A paused row the phone holds a feed on (the idle-timeout suspend keeps session_id on it).
    seedTaskSession('sess-parked', 'task-parked', 'idle', 'suspended');
    seedBoard([boardTaskFixture({ id: 'task-parked', swimlane_id: 'lane-doing', session_id: 'sess-parked', resumable: true })]);
    expect(sectionOf('sess-parked')).toBe('paused');

    seedBoard([
      boardTaskFixture({ id: 'task-parked', swimlane_id: 'lane-doing', session_id: 'sess-parked', spawn_progress: 'Resuming session...', resumable: true }),
    ]);
    expect(sectionOf('sess-parked')).toBe('paused');

    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-parked',
      taskId: 'task-parked',
      payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 'Resuming session...', successorSessionId: 'sess-resumed' },
    });
    expect(sectionOf('sess-parked')).toBe('idle');
  });

  it('keeps a queued session that ended in Queued for its window, rather than hopping it into Idle', () => {
    seedTaskSession('sess-cancelled', 'task-cancelled', 'idle', 'queued');
    useActivityStore.getState().applyActivityEvent({ kind: 'activity', sessionId: 'sess-cancelled', taskId: 'task-cancelled', payload: { type: 'session-ended', intentional: true } });

    expect(sectionOf('sess-cancelled')).toBe('queued');
  });

  it('draws one row per task when a ghost and a live session share it, preferring the live one', () => {
    seedTaskSession('sess-ghost', 'task-shared', 'idle', 'running');
    useActivityStore.getState().applyActivityEvent({ kind: 'activity', sessionId: 'sess-ghost', taskId: 'task-shared', payload: { type: 'session-ended', intentional: true } });
    seedTaskSession('sess-live', 'task-shared', 'idle', 'running');

    const placed = selectFeedSections(feedSources()).flatMap((section) => section.rows.map(feedRowKey));
    expect(placed).toEqual(['sess-live']);
  });

  /**
   * A paused task whose resume is under way carries a label AND `resumable` on
   * its board row, and the row it belongs to may be a ghost that never learned it
   * was suspended: the phone missed the live status push, so the entry still
   * reads running, and its end carried no label. The board's own `resumable` is
   * then the only thing that says where the preparing card came from.
   */
  it('keeps a labelled, resumable task in Paused for an ended row whose status never said suspended', () => {
    seedTaskSession('sess-missed', 'task-missed', 'idle', 'running');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-missed',
      taskId: 'task-missed',
      payload: { type: 'session-ended', intentional: true },
    });
    seedBoard([
      boardTaskFixture({ id: 'task-missed', swimlane_id: 'lane-doing', session_id: null, spawn_progress: 'Resuming session...', resumable: true }),
    ]);

    expect(sectionOf('sess-missed')).toBe('paused');
  });

  /**
   * Two LIVE entries for one task are two sessions the desktop reported, and
   * hiding either would be guessing: only an ENDED entry is ever folded into a
   * live one.
   */
  it('keeps two live sessions that share a task, rather than guessing which one to hide', () => {
    seedTaskSession('sess-live-a', 'task-shared', 'idle', 'running');
    seedTaskSession('sess-live-b', 'task-shared', 'thinking', 'running');

    const placed = selectFeedSections(feedSources()).flatMap((section) => section.rows.map(feedRowKey));
    expect([...placed].sort()).toEqual(['sess-live-a', 'sess-live-b']);
  });

  /** An entry with no known task (an empty `taskId`) is never folded into another one that also has none. */
  it('never folds an ended entry with no known task into a live one with none', () => {
    useActivityStore.getState().registerSession('sess-unowned-ended', '', 'project-1');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-unowned-ended',
      taskId: '',
      payload: { type: 'session-ended', intentional: true },
    });
    useActivityStore.getState().registerSession('sess-unowned-live', '', 'project-1');

    const placed = selectFeedSections(feedSources()).flatMap((section) => section.rows.map(feedRowKey));
    expect([...placed].sort()).toEqual(['sess-unowned-ended', 'sess-unowned-live']);
  });

  it('orders task rows among the section\'s session rows, newest first', () => {
    seedTaskSession('sess-paused', 'task-session-paused', 'idle', 'suspended');
    useActivityStore.setState((current) => ({
      bySessionId: { ...current.bySessionId, 'sess-paused': { ...current.bySessionId['sess-paused'], enteredSectionAt: Date.parse('2026-10-02T00:00:00.000Z') } },
    }));
    seedBoard([
      boardTaskFixture({ id: 'task-older', session_id: null, resumable: true, updated_at: '2026-10-01T00:00:00.000Z' }),
      boardTaskFixture({ id: 'task-newer', session_id: null, resumable: true, updated_at: '2026-10-03T00:00:00.000Z' }),
    ]);

    expect(sessionIdsIn('paused')).toEqual(['task-task-newer', 'sess-paused', 'task-task-older']);
  });
});
