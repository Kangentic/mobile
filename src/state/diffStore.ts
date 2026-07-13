import { create } from 'zustand';
import type { DiffFileContentWire, DiffFileListWire, ReadDiffScope } from '@kangentic/protocol';

export type DiffFetchStatus = 'idle' | 'loading' | 'error';

export interface TaskDiffState {
  scope: ReadDiffScope;
  fileList: DiffFileListWire | null;
  fileListStatus: DiffFetchStatus;
  /** Keyed by file path, scoped to (scope, revision): applyFileList clears it because content is only valid against the list it came with. */
  contentByPath: Record<string, DiffFileContentWire>;
  /** Set by a DiffEvent ("something changed, re-fetch"); cleared by the next applyFileList. */
  stale: boolean;
}

interface DiffStoreState {
  byTaskId: Record<string, TaskDiffState>;
  applyFileList: (taskId: string, scope: ReadDiffScope, fileList: DiffFileListWire) => void;
  applyFileContent: (taskId: string, filePath: string, content: DiffFileContentWire) => void;
  markStale: (taskId: string) => void;
  setStatus: (taskId: string, scope: ReadDiffScope, status: DiffFetchStatus) => void;
  clearTask: (taskId: string) => void;
  reset: () => void;
}

const EMPTY_TASK_DIFF: Omit<TaskDiffState, 'scope'> = {
  fileList: null,
  fileListStatus: 'idle',
  contentByPath: {},
  stale: false,
};

export const useDiffStore = create<DiffStoreState>((set) => ({
  byTaskId: {},

  applyFileList: (taskId, scope, fileList) =>
    set((state) => ({
      byTaskId: {
        ...state.byTaskId,
        [taskId]: { scope, fileList, fileListStatus: 'idle', contentByPath: {}, stale: false },
      },
    })),

  applyFileContent: (taskId, filePath, content) =>
    set((state) => {
      const existing = state.byTaskId[taskId];
      if (!existing) return state;
      return {
        byTaskId: {
          ...state.byTaskId,
          [taskId]: { ...existing, contentByPath: { ...existing.contentByPath, [filePath]: content } },
        },
      };
    }),

  markStale: (taskId) =>
    set((state) => {
      const existing = state.byTaskId[taskId];
      if (!existing) return state;
      return { byTaskId: { ...state.byTaskId, [taskId]: { ...existing, stale: true } } };
    }),

  setStatus: (taskId, scope, status) =>
    set((state) => {
      const existing = state.byTaskId[taskId] ?? { scope, ...EMPTY_TASK_DIFF };
      return { byTaskId: { ...state.byTaskId, [taskId]: { ...existing, scope, fileListStatus: status } } };
    }),

  clearTask: (taskId) =>
    set((state) => {
      if (!(taskId in state.byTaskId)) return state;
      const byTaskId = { ...state.byTaskId };
      delete byTaskId[taskId];
      return { byTaskId };
    }),

  reset: () => set({ byTaskId: {} }),
}));

export function selectTaskDiff(state: DiffStoreState, taskId: string): TaskDiffState | null {
  return state.byTaskId[taskId] ?? null;
}
