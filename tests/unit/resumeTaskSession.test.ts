/**
 * resumeTaskSession: one `start-session` per attempt, and an attempt that
 * always ends. The desktop answers on ACCEPT, and a resume that fails after
 * that sends the phone nothing, so the wait bound is the only thing between a
 * failed resume and "Resuming agent..." forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BoardTaskWire } from '@kangentic/protocol';
import { CapabilityError } from '@/channel/verbClient';
import { RESUME_WAIT_MS, resumeTaskSession } from '@/connection/actions';
import { boardSnapshotFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';
import { useBoardStore } from '@/state/boardStore';
import { resumeProgress, useResumeStore } from '@/state/resumeStore';

const { startSession, getActiveConnection, requireSubscriptions, runBootstrap } = vi.hoisted(() => ({
  startSession: vi.fn(),
  getActiveConnection: vi.fn(),
  requireSubscriptions: vi.fn(),
  runBootstrap: vi.fn(),
}));

// `refreshSnapshots` is the real one: it lives in the module under test, so a
// spy on the export would not intercept the call resumeTaskSession makes. Its
// one outward effect is `runBootstrap`, which is what the refresh tests observe.
vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection,
  reconnectNow: vi.fn(),
  requireSubscriptions,
  requireVerbClient: () => ({ startSession }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap }));
// @/connection/actions also imports settingsStore, which persists via
// expo-secure-store - fake it so the vitest (node) run has no native module.
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  useResumeStore.setState({ byTaskId: {} });
  useBoardStore.getState().reset();
});

afterEach(() => {
  vi.useRealTimers();
  startSession.mockReset();
  getActiveConnection.mockReset();
  requireSubscriptions.mockReset();
  runBootstrap.mockReset();
});

describe('resumeTaskSession', () => {
  it('sends start-session for the task and stays resuming once the desktop accepts', async () => {
    startSession.mockResolvedValue({ ok: true, outcome: 'starting' });

    const attempt = await resumeTaskSession('task-1', 'project-1');

    expect(startSession).toHaveBeenCalledWith({ taskId: 'task-1', projectId: 'project-1' });
    expect(attempt.phase).toBe('resuming');
    expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');
  });

  it('fails an accepted resume that never produces its session, after the wait bound', async () => {
    startSession.mockResolvedValue({ ok: true, outcome: 'starting' });
    await resumeTaskSession('task-1', 'project-1');

    vi.advanceTimersByTime(RESUME_WAIT_MS - 1);
    expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');
    vi.advanceTimersByTime(1);
    expect(useResumeStore.getState().byTaskId['task-1']).toEqual({ phase: 'failed', message: null });
  });

  /**
   * A resume that succeeded clears its attempt (the surfaces do, when the
   * paused session ends), and the user may resume again before the first
   * bound runs out: the old timer must not fail the NEW attempt.
   */
  it('never fails a newer attempt on an older attempt\'s timer', async () => {
    startSession.mockResolvedValue({ ok: true, outcome: 'starting' });
    await resumeTaskSession('task-1', 'project-1');
    useResumeStore.getState().clear('task-1');
    vi.advanceTimersByTime(RESUME_WAIT_MS / 2);
    await resumeTaskSession('task-1', 'project-1');

    vi.advanceTimersByTime(RESUME_WAIT_MS / 2);
    expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');
  });

  it('fails at once with the desktop\'s own refusal text, capped', async () => {
    startSession.mockRejectedValue(new CapabilityError('start-session', `Cannot resume a task in To Do${' and more'.repeat(40)}`));

    const attempt = await resumeTaskSession('task-1', 'project-1');

    expect(attempt.phase).toBe('failed');
    const message = attempt.phase === 'failed' ? attempt.message : null;
    expect(message?.startsWith('Cannot resume a task in To Do')).toBe(true);
    expect(message?.length).toBe(160);
  });

  it('fails at once with no text of its own for anything but a desktop refusal', async () => {
    startSession.mockRejectedValue(new Error('Not connected'));

    const attempt = await resumeTaskSession('task-1', 'project-1');

    expect(attempt).toEqual({ phase: 'failed', message: null });
  });

  /**
   * A refusal with no text must read as NO text. An empty message would be
   * shown by every surface as a blank failure line, where null makes each fall
   * back to its generic one. `''` is the plain empty case; the whitespace-only
   * one is what a `.trim()` is for, and passes a bare length check untouched.
   */
  it.each([
    ['empty', ''],
    ['whitespace-only', '  \n\t '],
  ])('fails with no text of its own when the desktop\'s refusal is %s', async (_description, refusalText) => {
    startSession.mockRejectedValue(new CapabilityError('start-session', refusalText));

    const attempt = await resumeTaskSession('task-1', 'project-1');

    expect(attempt).toEqual({ phase: 'failed', message: null });
    expect(useResumeStore.getState().byTaskId['task-1']).toEqual({ phase: 'failed', message: null });
  });

  it('trims the whitespace around the desktop\'s refusal text', async () => {
    startSession.mockRejectedValue(new CapabilityError('start-session', '  Cannot resume a task in To Do \n'));

    const attempt = await resumeTaskSession('task-1', 'project-1');

    expect(attempt).toEqual({ phase: 'failed', message: 'Cannot resume a task in To Do' });
    expect(useResumeStore.getState().byTaskId['task-1']).toEqual({ phase: 'failed', message: 'Cannot resume a task in To Do' });
  });

  it('sends nothing while an attempt is already running', async () => {
    startSession.mockResolvedValue({ ok: true, outcome: 'starting' });
    await resumeTaskSession('task-1', 'project-1');
    await resumeTaskSession('task-1', 'project-1');

    expect(startSession).toHaveBeenCalledTimes(1);
  });

  /**
   * Every surface leaves its button live after a failure, "for a retry". The
   * in-flight guard only holds back an attempt that is still RESUMING: a failed
   * one is over, and a second press must send a fresh `start-session` and
   * replace the failure with a new attempt rather than hand the failure back.
   */
  it('sends a fresh start-session on a retry after a failed attempt, replacing the failure', async () => {
    startSession.mockRejectedValueOnce(new CapabilityError('start-session', 'Cannot resume a task in To Do'));
    const failed = await resumeTaskSession('task-1', 'project-1');
    expect(failed.phase).toBe('failed');

    startSession.mockResolvedValueOnce({ ok: true, outcome: 'starting' });
    const retried = await resumeTaskSession('task-1', 'project-1');

    expect(startSession).toHaveBeenCalledTimes(2);
    expect(retried.phase).toBe('resuming');
    expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');
  });

  /**
   * Attempts are task-keyed, so each task's surfaces show their own. Another
   * task starting a resume must neither be refused by this task's guard nor
   * disturb a failure this task is still showing.
   */
  it('keeps each task\'s attempt apart: a second task resumes while the first still shows its failure', async () => {
    startSession.mockRejectedValueOnce(new CapabilityError('start-session', 'Cannot resume a task in To Do'));
    await resumeTaskSession('task-1', 'project-1');
    startSession.mockResolvedValueOnce({ ok: true, outcome: 'starting' });

    await resumeTaskSession('task-2', 'project-1');

    expect(startSession).toHaveBeenLastCalledWith({ taskId: 'task-2', projectId: 'project-1' });
    expect(useResumeStore.getState().byTaskId['task-2']?.phase).toBe('resuming');
    expect(useResumeStore.getState().byTaskId['task-1']).toEqual({ phase: 'failed', message: 'Cannot resume a task in To Do' });
  });
});

/**
 * `live` means the desktop already had a running session for the task, so the
 * successor-arrival event the phone would otherwise wait on is never coming.
 * The phone refreshes its own snapshots instead, so a stale paused view catches
 * up. `starting` is the opposite: the successor's arrival is the signal, and a
 * refresh would only race it.
 */
describe('resumeTaskSession - refreshing on a live outcome', () => {
  const establishedConnection = { controller: { session: { isEstablished: true } }, verbs: { label: 'verb client' } };
  const subscriptions = { label: 'subscription manager' };

  /**
   * The refresh is a no-op without an established connection, so every test here
   * connects one: otherwise "no refresh happened" would be true for the wrong
   * reason and the negative assertion below could never fail.
   */
  beforeEach(() => {
    getActiveConnection.mockReturnValue(establishedConnection);
    requireSubscriptions.mockReturnValue(subscriptions);
    runBootstrap.mockResolvedValue(undefined);
  });

  it('refreshes the snapshots when the desktop reports a session already live', async () => {
    startSession.mockResolvedValue({ ok: true, outcome: 'live' });

    const attempt = await resumeTaskSession('task-1', 'project-1');

    expect(runBootstrap).toHaveBeenCalledTimes(1);
    expect(runBootstrap).toHaveBeenCalledWith(establishedConnection.verbs, subscriptions);
    expect(attempt.phase).toBe('resuming');
  });

  it('does not refresh when the desktop reports the session is starting', async () => {
    startSession.mockResolvedValue({ ok: true, outcome: 'starting' });

    const attempt = await resumeTaskSession('task-1', 'project-1');

    expect(runBootstrap).not.toHaveBeenCalled();
    expect(attempt.phase).toBe('resuming');
  });

  /**
   * The refresh is best-effort and fire-and-forget. If it were awaited inside
   * the request's try, its failure would land in the catch and mark a resume the
   * desktop ACCEPTED as failed; if its rejection were left unhandled, it would
   * surface as an unhandled promise rejection.
   */
  it('keeps the attempt resuming, with no unhandled rejection, when the refresh itself rejects', async () => {
    startSession.mockResolvedValue({ ok: true, outcome: 'live' });
    runBootstrap.mockRejectedValue(new Error('bootstrap failed'));
    const unhandledReasons: unknown[] = [];
    const recordUnhandled = (reason: unknown): void => {
      unhandledReasons.push(reason);
    };
    process.on('unhandledRejection', recordUnhandled);

    try {
      const attempt = await resumeTaskSession('task-1', 'project-1');
      // Lets the rejected refresh settle, and Node's end-of-turn unhandled
      // rejection check run, before anything is asserted.
      await vi.advanceTimersByTimeAsync(0);

      expect(runBootstrap).toHaveBeenCalledTimes(1);
      expect(attempt.phase).toBe('resuming');
      expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');
      expect(unhandledReasons).toEqual([]);
    } finally {
      process.off('unhandledRejection', recordUnhandled);
    }
  });
});

/**
 * A 0.16.0 desktop runs a resume THROUGH a board-row label ("Resuming
 * session...") and reports a failed spawn only by clearing that label with
 * nothing bound. The phone used to drop its attempt the moment the label
 * appeared, so a failed spawn handed back a fresh Resume button and no error.
 */
describe('resumeTaskSession - following the board row', () => {
  const RESUME_LABEL = 'Resuming session...';
  /** The board row after a user's pause: no session, Resume offered. */
  const PAUSED_ROW: Partial<BoardTaskWire> = { session_id: null, resumable: true, spawn_progress: null };

  const publishRow = (row: Partial<BoardTaskWire>): void => {
    useBoardStore
      .getState()
      .applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-1', view: 'sessions', tasks: [boardTaskFixture({ id: 'task-1', ...row })] }));
  };
  const attemptFor = (): unknown => useResumeStore.getState().byTaskId['task-1'];

  beforeEach(() => {
    startSession.mockResolvedValue({ ok: true, outcome: 'starting' });
  });

  it('fails a resume whose spawn fails: the label comes, then clears with nothing bound', async () => {
    publishRow(PAUSED_ROW);
    await resumeTaskSession('task-1', 'project-1');

    publishRow({ ...PAUSED_ROW, spawn_progress: RESUME_LABEL });
    expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');

    publishRow(PAUSED_ROW);
    expect(attemptFor()).toEqual({ phase: 'failed', message: null });
  });

  /** The git phase can run long: once the desktop shows it is working on it, the label clearing settles the attempt, not the clock. */
  it('keeps a labelled resume resuming past the wait bound', async () => {
    publishRow(PAUSED_ROW);
    await resumeTaskSession('task-1', 'project-1');
    publishRow({ ...PAUSED_ROW, spawn_progress: RESUME_LABEL });

    vi.advanceTimersByTime(RESUME_WAIT_MS + 1);

    expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');
  });

  it('clears the attempt once the row binds the new session', async () => {
    publishRow(PAUSED_ROW);
    await resumeTaskSession('task-1', 'project-1');
    publishRow({ ...PAUSED_ROW, spawn_progress: RESUME_LABEL });

    publishRow({ session_id: 'sess-new', resumable: false, spawn_progress: null });

    expect(attemptFor()).toBeUndefined();
  });

  /** A row the desktop suspended in place (idle timeout) keeps its session id: that id staying put is not a bind. */
  it('reads a row paused in place as bound only by a different session', async () => {
    const pausedInPlace: Partial<BoardTaskWire> = { session_id: 'sess-paused', resumable: true, spawn_progress: null };
    publishRow(pausedInPlace);
    await resumeTaskSession('task-1', 'project-1');
    publishRow({ ...pausedInPlace, spawn_progress: RESUME_LABEL });

    publishRow(pausedInPlace);

    expect(attemptFor()).toEqual({ phase: 'failed', message: null });
  });

  /** An unrelated board event before the label lands must not read as a failed spawn: the row has always looked like this. */
  it('does not read the paused row as a failed spawn before any label, and still fails it at the wait bound', async () => {
    publishRow(PAUSED_ROW);
    await resumeTaskSession('task-1', 'project-1');

    publishRow(PAUSED_ROW);
    expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');

    vi.advanceTimersByTime(RESUME_WAIT_MS);
    expect(attemptFor()).toEqual({ phase: 'failed', message: null });
  });

  /**
   * The desktop answers `start-session` on ACCEPT, and the resumed session can
   * reach the board before that answer reaches the phone. The watcher only
   * starts after the answer, so its subscription never sees that snapshot: it
   * has to read the row once on starting, or the attempt stays "resuming" until
   * the wait bound rather than clearing at once.
   */
  it('clears the attempt at once when the row already binds the new session by the time the desktop accepts', async () => {
    publishRow(PAUSED_ROW);
    startSession.mockImplementation(async () => {
      publishRow({ session_id: 'sess-new', resumable: false, spawn_progress: null });
      return { ok: true, outcome: 'starting' };
    });

    await resumeTaskSession('task-1', 'project-1');

    // Nothing advanced: no timer and no later board event has had a chance to settle it.
    expect(attemptFor()).toBeUndefined();
  });

  /**
   * An attempt superseded by a newer one (a retry after the first was cleared)
   * must not be touched by the OLDER watcher when a board event lands. The
   * timer half of this is pinned above; the subscription is a separate path,
   * and it stays subscribed until its own attempt settles or it notices it was
   * replaced. The newer attempt is started directly rather than through a second
   * resumeTaskSession, whose own watcher would read the same board and mask
   * what the older one did.
   */
  it('never lets a superseded attempt\'s watcher fail the newer attempt on a board event', async () => {
    publishRow(PAUSED_ROW);
    await resumeTaskSession('task-1', 'project-1');
    publishRow({ ...PAUSED_ROW, spawn_progress: RESUME_LABEL });
    vi.advanceTimersByTime(1_000);
    useResumeStore.getState().markResuming('task-1', Date.now());
    const newerAttempt = attemptFor();

    // The label clearing onto a paused row is exactly what the older watcher
    // reads as a failed spawn, having seen the label itself.
    publishRow(PAUSED_ROW);

    expect(attemptFor()).toEqual(newerAttempt);
    expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');
  });

  /**
   * The wait bound is spent only on a resume the desktop is NOT labelling. While
   * the label stays up the bound re-arms instead of lapsing, so the label
   * clearing later onto a row that is neither bound nor resumable (the task left
   * a Resume column mid-resume, so `resumeProgress` reads it as plain "waiting")
   * still ends the attempt, at the next bound, rather than leaving it, and its
   * board subscription, waiting for good.
   */
  it('fails a labelled resume at the next bound once the label clears onto a row that is neither bound nor resumable', async () => {
    publishRow(PAUSED_ROW);
    await resumeTaskSession('task-1', 'project-1');
    publishRow({ ...PAUSED_ROW, spawn_progress: RESUME_LABEL });

    // Two whole bounds with the label up: neither may fail it.
    vi.advanceTimersByTime(RESUME_WAIT_MS * 2 + 1);
    expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');

    // Moved off the Resume column: no label, no session, not resumable. The
    // subscription reads this as "waiting", so nothing settles it yet.
    publishRow({ session_id: null, resumable: false, spawn_progress: null });
    expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');

    vi.advanceTimersByTime(RESUME_WAIT_MS);
    expect(attemptFor()).toEqual({ phase: 'failed', message: null });
  });
});

describe('resumeProgress', () => {
  const row = (fields: Partial<Pick<BoardTaskWire, 'session_id' | 'spawn_progress' | 'resumable'>>) => ({
    session_id: null,
    spawn_progress: null,
    resumable: true,
    ...fields,
  });

  it.each([
    ['no row cached', null, null, false, 'waiting'],
    ['a label', row({ spawn_progress: 'Resuming session...' }), null, false, 'labelled'],
    ['a blank label', row({ spawn_progress: '   ' }), null, false, 'waiting'],
    ['a new session', row({ session_id: 'sess-new', resumable: false }), null, true, 'bound'],
    ['the paused session still in place', row({ session_id: 'sess-paused' }), 'sess-paused', true, 'spawn-failed'],
    ['paused again after the label', row({}), null, true, 'spawn-failed'],
    ['paused, label never seen', row({}), null, false, 'waiting'],
    ['moved off a Resume column after the label', row({ resumable: false }), null, true, 'waiting'],
  ] as const)('reads %s', (_description, boardRow, pausedSessionId, sawLabel, expected) => {
    expect(resumeProgress(boardRow, pausedSessionId, sawLabel)).toBe(expected);
  });
});
