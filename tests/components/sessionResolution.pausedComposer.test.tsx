import { pausedComposerSessionId, type PausedComposerInput } from '@/screens/task/sessionResolution';

/**
 * Pure rules, filed beside the SessionScreen.resume cases that exercise them
 * through the screen. Named `.test.tsx` because jest's testMatch takes that
 * extension alone; a `.test.ts` here would run under neither runner.
 *
 * Since protocol 0.26.0 the desktop HOLDS a message sent to a session with no
 * running agent for the task's next agent. A desktop pause clears the row's
 * `session_id`, and since 0.27.0 the row names the paused session in
 * `paused_session_id`, so any paused task can keep composing to it. Each case
 * below is one way that offer must NOT be made: it is the offer the desktop
 * would refuse (To Do, Done and an archived task are not `resumable`, and an
 * older desktop names no session), or one the swap window and the launch face
 * already own.
 */
describe('pausedComposerSessionId', () => {
  const pausedRow: NonNullable<PausedComposerInput['row']> = { resumable: true, spawn_progress: null };
  const paused: PausedComposerInput = { row: pausedRow, pausedSessionId: 'paused-1', currentSessionId: null };

  it('returns the session a resumable row names, for a screen that never bound one', () => {
    expect(pausedComposerSessionId(paused)).toBe('paused-1');
  });

  /**
   * Desktop v0.51.0 sends no `paused_session_id` and refuses a send to a paused
   * session, so a composer offered here reads "Session ended". The input has
   * no remembered id to fall back on any more, by design: this pins the row as
   * the only source. Mutation seen failing: `return input.pausedSessionId ??
   * 'remembered-session'`.
   */
  it('returns null for a resumable row that names no session: an older desktop holds nothing', () => {
    expect(pausedComposerSessionId({ ...paused, pausedSessionId: null })).toBeNull();
  });

  it('returns null while the board names a current session, whatever the row names beside it', () => {
    expect(pausedComposerSessionId({ ...paused, currentSessionId: 'sess-2' })).toBeNull();
    expect(pausedComposerSessionId({ ...paused, currentSessionId: 'paused-1' })).toBeNull();
  });

  /** A paused task in Done: the row names its session, and the desktop refuses a hold there. */
  it('returns null for a row the desktop does not offer Resume for, though it names a session', () => {
    expect(pausedComposerSessionId({ ...paused, row: { resumable: false, spawn_progress: null } })).toBeNull();
  });

  it('returns null for a pre-0.16.0 row, whose resumable parses as null', () => {
    expect(pausedComposerSessionId({ ...paused, row: { resumable: null, spawn_progress: null } })).toBeNull();
  });

  it('returns null while the row carries a spawn label: a swap or a resume in flight owns the footer', () => {
    expect(pausedComposerSessionId({ ...paused, row: { resumable: true, spawn_progress: 'Resuming session...' } })).toBeNull();
  });

  it('does not read a blank spawn label as a spawn in flight', () => {
    expect(pausedComposerSessionId({ ...paused, row: { resumable: true, spawn_progress: '   ' } })).toBe('paused-1');
  });

  it('returns null when no cached board holds the task', () => {
    expect(pausedComposerSessionId({ ...paused, row: null })).toBeNull();
  });
});
