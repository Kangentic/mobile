import { beforeEach, describe, expect, it } from 'vitest';
import type { ReadStreamSessionStatusWire } from '@kangentic/protocol';
import {
  SPAWN_LABEL_MAX_LENGTH,
  boardRowPaused,
  cardSessionDisplay,
  toCardSession,
  toCardTaskRow,
  type CardSession,
  type CardTaskRow,
} from '@/components/board/cardSessionDisplay';
import { useActivityStore, type RespawnInFlight } from '@/state/activityStore';
import { streamSnapshotFixture } from '@/devsupport/desktopFixtures';

function respawnWith(label: string | null): RespawnInFlight {
  return { label, reportedAt: 0, endedSessionId: 'session-ended' };
}

function sessionWith(status: ReadStreamSessionStatusWire | null | undefined, overrides: Partial<CardSession> = {}): CardSession {
  return { status, resuming: false, ended: false, ...overrides };
}

/**
 * A board row as a 0.16.0 desktop sends it: the session it names, its label,
 * its Resume gate, and no `paused` (0.17.0 parses as null there), so every
 * test built on it pins the `resumable`-only fallback.
 */
function rowWith(overrides: Partial<CardTaskRow> = {}): CardTaskRow {
  return { session_id: 'session-live', spawn_progress: null, resumable: false, paused: null, archived_at: null, ...overrides };
}

/** The same row from a 0.17.0 desktop, which also sends the paused fact. */
function rowWithPausedField(overrides: Partial<CardTaskRow> = {}): CardTaskRow {
  return { session_id: 'session-live', spawn_progress: null, resumable: false, paused: false, archived_at: null, ...overrides };
}

/** The same row from a pre-0.16.0 desktop: every board field parses as null. */
function legacyRowWith(sessionId: string | null): CardTaskRow {
  return { session_id: sessionId, spawn_progress: null, resumable: null, paused: null, archived_at: null };
}

const ARCHIVED_AT = '2026-10-07T12:00:00.000Z';

/**
 * The desktop's precedence (kangentic `getTaskProgress`, task-progress.ts):
 * a step label wins only over a session that is gone or parked, then the
 * session's status decides, and a running session with nothing reported is
 * still running.
 */
describe('cardSessionDisplay', () => {
  it('reads a running session, or one whose status was never reported, as running', () => {
    expect(cardSessionDisplay({ session: sessionWith('running'), respawn: null, task: null })).toEqual({ kind: 'running', resuming: false });
    expect(cardSessionDisplay({ session: sessionWith(null), respawn: null, task: null })).toEqual({ kind: 'running', resuming: false });
    expect(cardSessionDisplay({ session: sessionWith(undefined), respawn: null, task: null })).toEqual({ kind: 'running', resuming: false });
  });

  it('carries the session\'s resuming flag on a running card, for the footer\'s "Resuming agent..."', () => {
    expect(cardSessionDisplay({ session: sessionWith('running', { resuming: true }), respawn: null, task: rowWith() })).toEqual({
      kind: 'running',
      resuming: true,
    });
  });

  it('maps the desktop\'s queued, suspended and exited statuses to their own states', () => {
    expect(cardSessionDisplay({ session: sessionWith('queued'), respawn: null, task: null })).toEqual({ kind: 'queued' });
    expect(cardSessionDisplay({ session: sessionWith('suspended'), respawn: null, task: null })).toEqual({ kind: 'suspended' });
    expect(cardSessionDisplay({ session: sessionWith('exited'), respawn: null, task: null })).toEqual({ kind: 'exited' });
  });

  it('is none for a task with no session and nothing in flight', () => {
    expect(cardSessionDisplay({ session: null, respawn: null, task: null })).toEqual({ kind: 'none' });
    expect(cardSessionDisplay({ session: null, respawn: null, task: rowWith({ session_id: null }) })).toEqual({ kind: 'none' });
  });

  /**
   * The session-ended push's label: a respawn in flight means the session is
   * gone. It must win over whatever status the ended session's entry still
   * carries, exactly as the desktop's label wins over a missing or suspended
   * session.
   */
  it('shows a respawn\'s step, even over the ended session\'s stale status', () => {
    expect(cardSessionDisplay({ session: sessionWith('running'), respawn: respawnWith('Switching model...'), task: null })).toEqual({
      kind: 'preparing',
      label: 'Switching model...',
    });
    expect(cardSessionDisplay({ session: null, respawn: respawnWith('Starting new session...'), task: null })).toEqual({
      kind: 'preparing',
      label: 'Starting new session...',
    });
  });

  it('reads an end with no step as an ended session, never a guessed step', () => {
    expect(cardSessionDisplay({ session: sessionWith('running'), respawn: respawnWith(null), task: null })).toEqual({ kind: 'exited' });
    expect(cardSessionDisplay({ session: sessionWith('running'), respawn: respawnWith('   '), task: null })).toEqual({ kind: 'exited' });
  });

  it('caps the desktop\'s step text, which is untrusted display data', () => {
    expect(cardSessionDisplay({ session: null, respawn: respawnWith('x'.repeat(500)), task: null })).toEqual({
      kind: 'preparing',
      label: 'x'.repeat(SPAWN_LABEL_MAX_LENGTH),
    });
    expect(cardSessionDisplay({ session: null, respawn: null, task: rowWith({ session_id: null, spawn_progress: 'y'.repeat(500) }) })).toEqual({
      kind: 'preparing',
      label: 'y'.repeat(SPAWN_LABEL_MAX_LENGTH),
    });
  });
});

/**
 * Protocol 0.16.0's board-row inputs. The desktop card (getTaskProgress) lets
 * its spawn label override a SUSPENDED session and never a running or queued
 * one - it suspends before every model, agent or effort respawn, so without
 * that rule the card would read "Paused" through every switch.
 */
describe('cardSessionDisplay - the 0.16.0 board row', () => {
  it('shows the board\'s spawn label for a task with no session (a first start)', () => {
    expect(cardSessionDisplay({ session: null, respawn: null, task: rowWith({ session_id: null, spawn_progress: 'Creating worktree...' }) })).toEqual({
      kind: 'preparing',
      label: 'Creating worktree...',
    });
  });

  it('lets the board label win over a suspended session, so a respawn never reads Paused', () => {
    expect(
      cardSessionDisplay({ session: sessionWith('suspended'), respawn: null, task: rowWith({ spawn_progress: 'Switching model...', resumable: true }) }),
    ).toEqual({ kind: 'preparing', label: 'Switching model...' });
  });

  it('never lets a board label mask a running or queued session', () => {
    const labelled = rowWith({ spawn_progress: 'Starting agent...' });
    expect(cardSessionDisplay({ session: sessionWith('running'), respawn: null, task: labelled })).toEqual({ kind: 'running', resuming: false });
    expect(cardSessionDisplay({ session: sessionWith('queued'), respawn: null, task: labelled })).toEqual({ kind: 'queued' });
  });

  it('prefers the board\'s label to the end\'s, the fresher of the two', () => {
    expect(
      cardSessionDisplay({
        session: sessionWith('suspended', { ended: true }),
        respawn: respawnWith('Switching model...'),
        task: rowWith({ session_id: null, spawn_progress: 'Starting agent... (base 3 behind)' }),
      }),
    ).toEqual({ kind: 'preparing', label: 'Starting agent... (base 3 behind)' });
  });

  /**
   * A blank label says nothing: the desktop's `spawn_progress` is a step the
   * card draws, and an empty or whitespace-only one is no step. It must not read
   * as a preparing card with nothing in it, over a parked session or a bare row.
   */
  it('ignores a blank board label, over a suspended session and a bare row alike', () => {
    expect(cardSessionDisplay({ session: sessionWith('suspended'), respawn: null, task: rowWith({ spawn_progress: '   ', resumable: true }) })).toEqual({
      kind: 'suspended',
    });
    expect(cardSessionDisplay({ session: null, respawn: null, task: rowWith({ session_id: null, spawn_progress: '' }) })).toEqual({ kind: 'none' });
  });

  it('reads a paused task with NO session as Paused when the board row says resumable', () => {
    // A desktop pause clears session_id, so this is the only paused signal there is.
    expect(cardSessionDisplay({ session: null, respawn: null, task: rowWith({ session_id: null, resumable: true }) })).toEqual({ kind: 'suspended' });
  });

  it('reads an ended ghost past its window by the board row, not its stale status', () => {
    const ghost = sessionWith('running', { ended: true });
    expect(cardSessionDisplay({ session: ghost, respawn: null, task: rowWith({ session_id: null, resumable: true }) })).toEqual({ kind: 'suspended' });
    expect(cardSessionDisplay({ session: ghost, respawn: null, task: rowWith({ session_id: null }) })).toEqual({ kind: 'none' });
  });

  /**
   * An end in flight (a respawn) over a session the phone still holds as LIVE:
   * the board row's label is the desktop's current step and the end's own is
   * older, or absent. The board label has to win here too, not only over a
   * missing, ended or suspended session, or the card reads the stale step (or,
   * for an unlabelled end, "ended") while the desktop is visibly working.
   */
  it.each([
    ['a different label of its own', respawnWith('Switching model...')],
    ['no label (an unlabelled end)', respawnWith(null)],
  ])('lets the board\'s label win over a live running session whose end is in flight with %s', (_description, respawn) => {
    const labelled = rowWith({ session_id: 'session-live', spawn_progress: 'Starting agent...' });

    expect(cardSessionDisplay({ session: sessionWith('running'), respawn, task: labelled })).toEqual({
      kind: 'preparing',
      label: 'Starting agent...',
    });
  });

  /**
   * No cached board holds the task, so only the session's own status can say
   * whether an unlabelled end is a park: a suspended one is (the desktop pushes
   * `suspended` just ahead of the end), anything else simply ended.
   */
  it.each([
    ['a suspended session', 'suspended', sessionWith('suspended', { ended: true })],
    ['a running session', 'exited', sessionWith('running', { ended: true })],
    ['no session held at all', 'exited', null],
  ] as const)('reads an unlabelled end and no board row, over %s, as %s', (_description, expectedKind, session) => {
    expect(cardSessionDisplay({ session, respawn: respawnWith(null), task: null })).toEqual({ kind: expectedKind });
  });

  describe('an unlabelled end (a park, on a desktop that labels every respawn)', () => {
    it('reads Paused from the session\'s pushed status before the board refreshes past the ended id', () => {
      // The board still names the ended session: it has not caught up yet.
      const staleRow = rowWith({ session_id: 'session-ended', resumable: false });
      expect(cardSessionDisplay({ session: sessionWith('suspended', { ended: true }), respawn: respawnWith(null), task: staleRow })).toEqual({
        kind: 'suspended',
      });
      expect(cardSessionDisplay({ session: sessionWith('running', { ended: true }), respawn: respawnWith(null), task: staleRow })).toEqual({
        kind: 'exited',
      });
    });

    it('lets the refreshed board row decide once it has moved past the ended id', () => {
      const ghost = sessionWith('suspended', { ended: true });
      expect(cardSessionDisplay({ session: ghost, respawn: respawnWith(null), task: rowWith({ session_id: null, resumable: true }) })).toEqual({
        kind: 'suspended',
      });
      // Moved to Done: not resumable, so the stale 'suspended' must not paint a Paused card.
      expect(cardSessionDisplay({ session: ghost, respawn: respawnWith(null), task: rowWith({ session_id: null, resumable: false }) })).toEqual({
        kind: 'exited',
      });
    });
  });

  describe('against a pre-0.16.0 desktop (every board field null, no status push)', () => {
    it('reduces to the earlier precedence', () => {
      expect(cardSessionDisplay({ session: sessionWith('running'), respawn: respawnWith(null), task: legacyRowWith(null) })).toEqual({ kind: 'exited' });
      expect(cardSessionDisplay({ session: sessionWith('running'), respawn: respawnWith('Switching model...'), task: legacyRowWith(null) })).toEqual({
        kind: 'preparing',
        label: 'Switching model...',
      });
      expect(cardSessionDisplay({ session: null, respawn: null, task: legacyRowWith(null) })).toEqual({ kind: 'none' });
      expect(cardSessionDisplay({ session: sessionWith('suspended'), respawn: null, task: legacyRowWith('session-live') })).toEqual({ kind: 'suspended' });
    });
  });
});

/**
 * Protocol 0.17.0's `paused`: the desktop card's own "Paused" fact, sent apart
 * from the Resume gate. A paused task in Done reads `paused: true,
 * resumable: false`, which a 0.16.0 row could not say at all. The precedence
 * is unchanged around it: a spawn label and a live session both still win.
 */
describe('cardSessionDisplay - the 0.17.0 board row', () => {
  it('reads a paused task the desktop offers no Resume for as Paused (a task sitting in Done unarchived)', () => {
    expect(
      cardSessionDisplay({ session: null, respawn: null, task: rowWithPausedField({ session_id: null, paused: true, resumable: false }) }),
    ).toEqual({ kind: 'suspended' });
  });

  /**
   * The desktop draws an archived task as a compact card with no footer, and
   * every move into Done archives the task, so `paused: true` there must not
   * put "Paused" on the phone's completed cards.
   */
  it('never reads an archived row as Paused, though it says paused', () => {
    expect(
      cardSessionDisplay({
        session: null,
        respawn: null,
        task: rowWithPausedField({ session_id: null, paused: true, resumable: false, archived_at: ARCHIVED_AT }),
      }),
    ).toEqual({ kind: 'none' });
  });

  it('reads paused: false with no session as nothing at all (a task moved to To Do loses its session rows)', () => {
    expect(cardSessionDisplay({ session: null, respawn: null, task: rowWithPausedField({ session_id: null }) })).toEqual({ kind: 'none' });
  });

  it('lets a spawn label win over the paused fact, as the desktop card does', () => {
    expect(
      cardSessionDisplay({
        session: null,
        respawn: null,
        task: rowWithPausedField({ session_id: null, paused: true, resumable: true, spawn_progress: 'Resuming session...' }),
      }),
    ).toEqual({ kind: 'preparing', label: 'Resuming session...' });
  });

  it('lets a live session decide over the paused fact', () => {
    const pausedRow = rowWithPausedField({ paused: true });
    expect(cardSessionDisplay({ session: sessionWith('running'), respawn: null, task: pausedRow })).toEqual({ kind: 'running', resuming: false });
    expect(cardSessionDisplay({ session: sessionWith('queued'), respawn: null, task: pausedRow })).toEqual({ kind: 'queued' });
  });

  describe('an unlabelled end the board row has moved past', () => {
    const ghost = sessionWith('suspended', { ended: true });

    it('reads Paused from the paused fact where no Resume is offered', () => {
      expect(
        cardSessionDisplay({ session: ghost, respawn: respawnWith(null), task: rowWithPausedField({ session_id: null, paused: true }) }),
      ).toEqual({ kind: 'suspended' });
    });

    it('reads the move into Done (archived, paused) as an ended session with no footer', () => {
      expect(
        cardSessionDisplay({
          session: ghost,
          respawn: respawnWith(null),
          task: rowWithPausedField({ session_id: null, paused: true, archived_at: ARCHIVED_AT }),
        }),
      ).toEqual({ kind: 'exited' });
    });

    it('reads an end with nothing paused behind it as ended', () => {
      expect(cardSessionDisplay({ session: ghost, respawn: respawnWith(null), task: rowWithPausedField({ session_id: null }) })).toEqual({
        kind: 'exited',
      });
    });
  });

  it('falls back to resumable alone when paused is null (a 0.16.0 desktop)', () => {
    expect(cardSessionDisplay({ session: null, respawn: null, task: rowWith({ session_id: null, resumable: true }) })).toEqual({ kind: 'suspended' });
    expect(cardSessionDisplay({ session: null, respawn: null, task: rowWith({ session_id: null, resumable: false }) })).toEqual({ kind: 'none' });
  });
});

describe('boardRowPaused', () => {
  it('is the paused fact, else the Resume gate, and never true for an archived row', () => {
    expect(boardRowPaused(rowWithPausedField({ paused: true }))).toBe(true);
    expect(boardRowPaused(rowWithPausedField({ paused: false }))).toBe(false);
    expect(boardRowPaused(rowWith({ resumable: true }))).toBe(true);
    expect(boardRowPaused(rowWith({ resumable: false }))).toBe(false);
    expect(boardRowPaused(rowWithPausedField({ paused: true, archived_at: ARCHIVED_AT }))).toBe(false);
  });
});

describe('toCardTaskRow', () => {
  /** Every reader that narrows the row (the session screen, its header, the Resume gate) reads through this, so a dropped field reads as null there. */
  it('keeps the paused fact and the archive stamp', () => {
    const row = toCardTaskRow(rowWithPausedField({ paused: true, archived_at: ARCHIVED_AT }));

    expect(row).toEqual(expect.objectContaining({ paused: true, archived_at: ARCHIVED_AT }));
  });
});

/**
 * The activity entry as the card reads it. The `ended` flag is the one that
 * decides whether a ghost's stale status may speak at all: an entry the desktop
 * ended is a place-holder for its row, and the board row, not the status it
 * held when it ended, says what the task is now.
 */
describe('toCardSession', () => {
  beforeEach(() => {
    useActivityStore.getState().reset();
  });

  it('reads a live entry as its status and resuming flag, not ended', () => {
    useActivityStore
      .getState()
      .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'queued', resuming: true }));

    expect(toCardSession(useActivityStore.getState().bySessionId['sess-1'])).toEqual({ status: 'queued', resuming: true, ended: false });
  });

  it('reads an entry the desktop ended as ended, keeping the stale status it ended with', () => {
    useActivityStore.getState().applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'running' }));
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'session-ended', intentional: true },
    });

    expect(toCardSession(useActivityStore.getState().bySessionId['sess-1'])).toEqual({ status: 'running', resuming: false, ended: true });
  });

  /** The reading that matters end to end: the stale 'running' of an ended ghost must not draw a running card for a task the board says is paused. */
  it('lets the board row, not an ended ghost\'s stale running status, decide a paused task\'s card', () => {
    useActivityStore.getState().applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'running' }));
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'session-ended', intentional: true },
    });
    const ghost = toCardSession(useActivityStore.getState().bySessionId['sess-1']);

    expect(cardSessionDisplay({ session: ghost, respawn: null, task: rowWith({ session_id: null, resumable: true }) })).toEqual({ kind: 'suspended' });
  });
});
