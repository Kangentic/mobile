import { pausedComposerSessionId, type PausedComposerInput } from '@/screens/task/sessionResolution';

/**
 * Pure rules, filed beside the SessionScreen.resume cases that exercise them
 * through the screen. Named `.test.tsx` because jest's testMatch takes that
 * extension alone; a `.test.ts` here would run under neither runner.
 *
 * Since protocol 0.26.0 the desktop HOLDS a message sent to a session with no
 * running agent for the task's next agent. A desktop pause clears the row's
 * `session_id`, but the session it paused is still in the desktop's registry,
 * so a screen that was bound when the task paused can keep composing to it.
 * Each case below is one way that offer must NOT be made: it is the offer the
 * desktop would refuse (To Do, Done and an archived task are not `resumable`),
 * or one the swap window and the launch face already own.
 */
describe('pausedComposerSessionId', () => {
  const pausedRow: NonNullable<PausedComposerInput['row']> = { resumable: true, spawn_progress: null };
  const boundThenPaused: PausedComposerInput = { row: pausedRow, currentSessionId: null, lastBoundSessionId: 'sess-1' };

  it('returns the last bound session for a resumable row the pause cleared the session from', () => {
    expect(pausedComposerSessionId(boundThenPaused)).toBe('sess-1');
  });

  it('returns null while the board names a current session, whatever was bound before it', () => {
    expect(pausedComposerSessionId({ ...boundThenPaused, currentSessionId: 'sess-2' })).toBeNull();
    expect(pausedComposerSessionId({ ...boundThenPaused, currentSessionId: 'sess-1' })).toBeNull();
  });

  it('returns null for a screen that never bound a session: there is nothing to name', () => {
    expect(pausedComposerSessionId({ ...boundThenPaused, lastBoundSessionId: null })).toBeNull();
  });

  it('returns null for a row the desktop does not offer Resume for', () => {
    expect(pausedComposerSessionId({ ...boundThenPaused, row: { resumable: false, spawn_progress: null } })).toBeNull();
  });

  it('returns null for a pre-0.16.0 row, whose resumable parses as null', () => {
    expect(pausedComposerSessionId({ ...boundThenPaused, row: { resumable: null, spawn_progress: null } })).toBeNull();
  });

  it('returns null while the row carries a spawn label: a swap or a resume in flight owns the footer', () => {
    expect(pausedComposerSessionId({ ...boundThenPaused, row: { resumable: true, spawn_progress: 'Resuming session...' } })).toBeNull();
  });

  it('does not read a blank spawn label as a spawn in flight', () => {
    expect(pausedComposerSessionId({ ...boundThenPaused, row: { resumable: true, spawn_progress: '   ' } })).toBe('sess-1');
  });

  it('returns null when no cached board holds the task', () => {
    expect(pausedComposerSessionId({ ...boundThenPaused, row: null })).toBeNull();
  });
});
