import { create } from 'zustand';
import type { BoardTaskWire } from '@kangentic/protocol';
import { hasSpawnLabel } from '@/state/boardStore';

/**
 * One Resume attempt for a paused task, shared by every surface that offers
 * Resume (the session screen's button, the header's play button, the
 * long-press menu), so they all show the same "Resuming agent..." and the same
 * failure. Task-keyed because a resume ends one session and binds another.
 *
 * In memory only: an attempt means nothing after a relaunch, when the next
 * subscribe reports the session's real status.
 */
export type ResumeAttempt =
  | { phase: 'resuming'; startedAt: number }
  /** `message` is the desktop's own refusal text when it gave one, or null for the generic failure line. */
  | { phase: 'failed'; message: string | null };

interface ResumeStoreState {
  byTaskId: Record<string, ResumeAttempt>;
  markResuming: (taskId: string, startedAt: number) => void;
  markFailed: (taskId: string, message: string | null) => void;
  clear: (taskId: string) => void;
}

export const useResumeStore = create<ResumeStoreState>((set) => ({
  byTaskId: {},
  markResuming: (taskId, startedAt) => set((state) => ({ byTaskId: { ...state.byTaskId, [taskId]: { phase: 'resuming', startedAt } } })),
  markFailed: (taskId, message) => set((state) => ({ byTaskId: { ...state.byTaskId, [taskId]: { phase: 'failed', message } } })),
  clear: (taskId) =>
    set((state) => {
      if (state.byTaskId[taskId] === undefined) return state;
      const next = { ...state.byTaskId };
      delete next[taskId];
      return { byTaskId: next };
    }),
}));

export function selectResumeAttempt(state: { byTaskId: Record<string, ResumeAttempt> }, taskId: string | null): ResumeAttempt | null {
  if (taskId === null) return null;
  return state.byTaskId[taskId] ?? null;
}

/** Where an accepted resume stands; see `resumeProgress`. */
export type ResumeProgress = 'labelled' | 'bound' | 'spawn-failed' | 'waiting';

/**
 * Where an accepted resume stands, read off the task's BOARD ROW, the
 * desktop's own record of it (protocol 0.16.0). A 0.16.0 desktop labels the
 * row "Resuming session..." through the resume's git phase, then either binds
 * a NEW session to it (the label clears in the same write) or, when the spawn
 * fails, clears the label and leaves the task paused: no session, still
 * `resumable`. That last shape is the only failure the desktop shows the phone,
 * and it reads as an ordinary pause unless the attempt saw the label first.
 *
 * - `'labelled'`: the desktop is working on it.
 * - `'bound'`: a session other than the one paused at the start now holds the
 *   task. The resume landed.
 * - `'spawn-failed'`: the label came and went with nothing bound, and the task
 *   is paused again.
 * - `'waiting'`: nothing to read yet (no label so far, or no row cached).
 *
 * `pausedSessionId` is the row's `session_id` when the resume was sent: null
 * after a user's pause, the paused session's own id for a row the desktop
 * suspended in place (idle timeout), so that id staying put is not a bind.
 */
export function resumeProgress(
  row: Pick<BoardTaskWire, 'session_id' | 'spawn_progress' | 'resumable'> | null,
  pausedSessionId: string | null,
  sawLabel: boolean,
): ResumeProgress {
  if (row === null) return 'waiting';
  if (hasSpawnLabel(row)) return 'labelled';
  if (row.session_id !== null && row.session_id !== pausedSessionId) return 'bound';
  return sawLabel && row.resumable === true ? 'spawn-failed' : 'waiting';
}
