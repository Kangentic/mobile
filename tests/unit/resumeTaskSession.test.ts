/**
 * resumeTaskSession: one `start-session` per attempt, and an attempt that
 * always ends. The desktop answers on ACCEPT, and a resume that fails after
 * that sends the phone nothing, so the wait bound is the only thing between a
 * failed resume and "Resuming agent..." forever.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CapabilityError } from '@/channel/verbClient';
import { RESUME_WAIT_MS, resumeTaskSession } from '@/connection/actions';
import { useResumeStore } from '@/state/resumeStore';

const { startSession } = vi.hoisted(() => ({
  startSession: vi.fn(),
}));

vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection: vi.fn(() => null),
  reconnectNow: vi.fn(),
  requireSubscriptions: vi.fn(),
  requireVerbClient: () => ({ startSession }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
// @/connection/actions also imports settingsStore, which persists via
// expo-secure-store - fake it so the vitest (node) run has no native module.
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

beforeEach(() => {
  vi.useFakeTimers();
  useResumeStore.setState({ byTaskId: {} });
});

afterEach(() => {
  vi.useRealTimers();
  startSession.mockReset();
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

  it('sends nothing while an attempt is already running', async () => {
    startSession.mockResolvedValue({ ok: true, outcome: 'starting' });
    await resumeTaskSession('task-1', 'project-1');
    await resumeTaskSession('task-1', 'project-1');

    expect(startSession).toHaveBeenCalledTimes(1);
  });
});
