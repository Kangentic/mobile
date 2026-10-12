import { create } from 'zustand';
import type { DiffFileContentWire, DiffFileListWire, ReadDiffScope } from '@kangentic/protocol';

export type DiffFetchStatus = 'idle' | 'loading' | 'error';

/**
 * What a Changes pane diffs: a task's worktree, or (protocol 0.20.0) a
 * project's own folder against its default base branch, which is what a
 * Command Terminal's Changes tab shows. `taskId: null` is the project folder.
 *
 * Kept as the explicit pair all the way down to the verb, never squeezed into
 * one id: a project folder sent to the desktop as a made-up `taskId` would be
 * refused as an unknown task at best.
 */
export interface DiffTarget {
  taskId: string | null;
  projectId: string;
}

/**
 * The store key for a target. A task keeps its bare id; a project folder gets
 * a prefixed key no task id can collide with (task ids are UUIDs). A key is
 * local bookkeeping only and never leaves the phone.
 */
export function diffKeyFor(target: Pick<DiffTarget, 'taskId' | 'projectId'>): string {
  return target.taskId !== null ? target.taskId : `project:${target.projectId}`;
}

export interface DiffState {
  scope: ReadDiffScope;
  fileList: DiffFileListWire | null;
  fileListStatus: DiffFetchStatus;
  /** Keyed by file path, scoped to (scope, revision): applyFileList clears it because content is only valid against the list it came with. */
  contentByPath: Record<string, DiffFileContentWire>;
  /** Set by a DiffEvent ("something changed, re-fetch"); cleared by the next applyFileList. */
  stale: boolean;
}

interface DiffStoreState {
  /** By diff key (`diffKeyFor`): a task id, or a project folder's prefixed key. */
  byKey: Record<string, DiffState>;
  applyFileList: (diffKey: string, scope: ReadDiffScope, fileList: DiffFileListWire) => void;
  applyFileContent: (diffKey: string, filePath: string, content: DiffFileContentWire) => void;
  markStale: (diffKey: string) => void;
  setStatus: (diffKey: string, scope: ReadDiffScope, status: DiffFetchStatus) => void;
  clearKey: (diffKey: string) => void;
  reset: () => void;
}

const EMPTY_DIFF: Omit<DiffState, 'scope'> = {
  fileList: null,
  fileListStatus: 'idle',
  contentByPath: {},
  stale: false,
};

export const useDiffStore = create<DiffStoreState>((set) => ({
  byKey: {},

  applyFileList: (diffKey, scope, fileList) =>
    set((state) => ({
      byKey: {
        ...state.byKey,
        [diffKey]: { scope, fileList, fileListStatus: 'idle', contentByPath: {}, stale: false },
      },
    })),

  applyFileContent: (diffKey, filePath, content) =>
    set((state) => {
      const existing = state.byKey[diffKey];
      if (!existing) return state;
      return {
        byKey: {
          ...state.byKey,
          [diffKey]: { ...existing, contentByPath: { ...existing.contentByPath, [filePath]: content } },
        },
      };
    }),

  markStale: (diffKey) =>
    set((state) => {
      const existing = state.byKey[diffKey];
      if (!existing) return state;
      return { byKey: { ...state.byKey, [diffKey]: { ...existing, stale: true } } };
    }),

  setStatus: (diffKey, scope, status) =>
    set((state) => {
      const existing = state.byKey[diffKey] ?? { scope, ...EMPTY_DIFF };
      return { byKey: { ...state.byKey, [diffKey]: { ...existing, scope, fileListStatus: status } } };
    }),

  clearKey: (diffKey) =>
    set((state) => {
      if (!(diffKey in state.byKey)) return state;
      const byKey = { ...state.byKey };
      delete byKey[diffKey];
      return { byKey };
    }),

  reset: () => set({ byKey: {} }),
}));

export function selectDiff(state: DiffStoreState, diffKey: string): DiffState | null {
  return state.byKey[diffKey] ?? null;
}
