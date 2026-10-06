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
import type { ActivityReasonWire, ActivityStateWire, ReadStreamSessionStatusWire } from '@kangentic/protocol';
import {
  FEED_SECTION_DISPLAY_TITLES,
  countFeedSectionsByTitle,
  selectFeedSections,
  type FeedSection,
} from '@/screens/home/feedSections';
import { useActivityStore } from '@/state/activityStore';
import { streamSnapshotFixture } from '@/devsupport/desktopFixtures';

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

function sessionIdsIn(section: FeedSection): string[] {
  const found = selectFeedSections(useActivityStore.getState().bySessionId).find((candidate) => candidate.section === section);
  if (found === undefined) throw new Error(`selectFeedSections returned no "${section}" section`);
  return found.entries.map((entry) => entry.sessionId);
}

/**
 * Three running sessions, one per activity bucket, then four queued and four
 * suspended ones spread across the same buckets.
 *
 * The spread is what makes the order and partition assertions able to fail. The
 * feed builds Queued and Paused by walking selectTriageRows, which has already
 * sorted each bucket on its own, so a Queued list taken straight from that walk
 * comes out in BUCKET order (needs-you, working, idle). Each queued and paused
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

    const placedSessionIds = selectFeedSections(useActivityStore.getState().bySessionId).flatMap((section) =>
      section.entries.map((entry) => entry.sessionId),
    );

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

    const counts = countFeedSectionsByTitle(useActivityStore.getState().bySessionId);

    expect(Object.fromEntries(counts)).toEqual({ Idle: 3, Active: 1, Queued: 1, Paused: 0 });
    expect([...counts.keys()]).toEqual(['Idle', 'Active', 'Queued', 'Paused']);
  });

  it('reports 0 for every displayed section when no session exists', () => {
    const counts = countFeedSectionsByTitle(useActivityStore.getState().bySessionId);

    expect(Object.fromEntries(counts)).toEqual({ Idle: 0, Active: 0, Queued: 0, Paused: 0 });
  });
});
