import { describe, expect, it } from 'vitest';
import type { ReadStreamSessionStatusWire } from '@kangentic/protocol';
import { SPAWN_LABEL_MAX_LENGTH, cardSessionDisplay, type CardSession, type CardTaskRow } from '@/components/board/cardSessionDisplay';
import type { RespawnInFlight } from '@/state/activityStore';

function respawnWith(label: string | null): RespawnInFlight {
  return { label, reportedAt: 0, endedSessionId: 'session-ended' };
}

function sessionWith(status: ReadStreamSessionStatusWire | null | undefined, overrides: Partial<CardSession> = {}): CardSession {
  return { status, resuming: false, ended: false, ...overrides };
}

/** A board row as a 0.16.0 desktop sends it: the session it names, its label, its Resume gate. */
function rowWith(overrides: Partial<CardTaskRow> = {}): CardTaskRow {
  return { session_id: 'session-live', spawn_progress: null, resumable: false, ...overrides };
}

/** The same row from a pre-0.16.0 desktop: both fields parse as null. */
function legacyRowWith(sessionId: string | null): CardTaskRow {
  return { session_id: sessionId, spawn_progress: null, resumable: null };
}

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

  describe('against a pre-0.16.0 desktop (both board fields null, no status push)', () => {
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
