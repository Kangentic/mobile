/**
 * pauseTaskSession: one `pause-session` per tap (protocol 0.18.0), and the
 * three outcomes the long-press sheet acts on. The desktop answers on ACCEPT,
 * so none of them is "paused": the sheet settles on the board row. What this
 * pins is the split between a refusal (fail, re-read the board) and a timeout
 * (keep waiting, re-read the board), because the desktop said a timed-out
 * pause can still apply: the verb waits for the task lock.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityTimeoutError } from '@/channel/capabilityClient';
import { CapabilityError } from '@/channel/verbClient';
import { pauseTaskSession } from '@/connection/actions';

const { pauseSession, getActiveConnection, requireSubscriptions, runBootstrap } = vi.hoisted(() => ({
  pauseSession: vi.fn(),
  getActiveConnection: vi.fn(),
  requireSubscriptions: vi.fn(),
  runBootstrap: vi.fn(),
}));

// `refreshSnapshots` is the real one (see resumeTaskSession.test.ts): its one
// outward effect is `runBootstrap`, which is what the refresh tests observe.
vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection,
  reconnectNow: vi.fn(),
  requireSubscriptions,
  requireVerbClient: () => ({ pauseSession }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

/** An established connection, so `refreshSnapshots` actually re-reads. */
function establishedConnection(): void {
  getActiveConnection.mockReturnValue({ controller: { session: { isEstablished: true } }, verbs: {} });
  requireSubscriptions.mockReturnValue({});
  runBootstrap.mockResolvedValue(undefined);
}

afterEach(() => {
  pauseSession.mockReset();
  getActiveConnection.mockReset();
  requireSubscriptions.mockReset();
  runBootstrap.mockReset();
});

describe('pauseTaskSession', () => {
  it('sends pause-session for the task and reports the accept without re-reading the board', async () => {
    establishedConnection();
    pauseSession.mockResolvedValue({ ok: true });

    await expect(pauseTaskSession('task-1', 'project-1')).resolves.toEqual({ kind: 'accepted' });

    expect(pauseSession).toHaveBeenCalledWith({ taskId: 'task-1', projectId: 'project-1' });
    // The paused row arrives as a board event; an accept needs no re-read.
    expect(runBootstrap).not.toHaveBeenCalled();
  });

  /**
   * The desktop's usual refusal means the phone's view was stale: the session
   * ended or paused since the card drew. The re-read is what takes the Pause
   * away from a row that should not have offered it.
   *
   * Mutation seen failing: dropping the refreshSnapshots call from the
   * CapabilityError branch ("expected spy to be called at least once").
   */
  it('refuses with the desktop\'s own text and re-reads the board', async () => {
    establishedConnection();
    pauseSession.mockRejectedValue(new CapabilityError('pause-session', 'This task has no running session to pause.'));

    await expect(pauseTaskSession('task-1', 'project-1')).resolves.toEqual({
      kind: 'refused',
      message: 'This task has no running session to pause.',
    });
    expect(runBootstrap).toHaveBeenCalled();
  });

  it('refuses with no text of its own when the desktop\'s refusal is blank', async () => {
    establishedConnection();
    pauseSession.mockRejectedValue(new CapabilityError('pause-session', '   '));

    await expect(pauseTaskSession('task-1', 'project-1')).resolves.toEqual({ kind: 'refused', message: null });
  });

  /**
   * A timeout is not a failure. The desktop takes the task lock before it
   * pauses, and a long move can hold it past the phone's 10 s, so the pause
   * may land after the phone gave up on the answer. The board is re-read and
   * the caller keeps waiting on the row.
   *
   * Mutation seen failing: removing the CapabilityTimeoutError branch, so the
   * timeout fell through to the generic refusal ("expected { kind: 'refused'
   * ... } to deeply equal { kind: 'unconfirmed' }").
   */
  it('reports a timed-out pause as unconfirmed and re-reads the board, never as a failure', async () => {
    establishedConnection();
    pauseSession.mockRejectedValue(new CapabilityTimeoutError('pause-session'));

    await expect(pauseTaskSession('task-1', 'project-1')).resolves.toEqual({ kind: 'unconfirmed' });
    expect(runBootstrap).toHaveBeenCalled();
  });

  it('fails outright, with no text of its own, when the request never reached the desktop', async () => {
    pauseSession.mockRejectedValue(new Error('Not connected to the desktop'));

    await expect(pauseTaskSession('task-1', 'project-1')).resolves.toEqual({ kind: 'refused', message: null });
  });
});
