import { create } from 'zustand';

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
