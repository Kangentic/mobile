import { create } from 'zustand';

/**
 * The chat reading view's line buffer: cleaned, readable lines derived live
 * from the terminal by the WebView's clean feed (see terminalBridge's
 * 'clean-lines' message). Updates arrive already debounced (~48ms) so a
 * store write per batch is cheap; the cap bounds a long session's memory.
 */
const READING_VIEW_LINE_CAP = 500;

export interface ReadingViewState {
  /** Monotonic per session; lets list consumers key changes cheaply. */
  revision: number;
  lines: string[];
}

interface ReadingViewStoreState {
  bySessionId: Record<string, ReadingViewState>;
  applyCleanLines: (sessionId: string, lines: string[], reset: boolean) => void;
  clearSession: (sessionId: string) => void;
  reset: () => void;
}

export const useReadingViewStore = create<ReadingViewStoreState>((set) => ({
  bySessionId: {},

  applyCleanLines: (sessionId, lines, reset) =>
    set((state) => {
      const existing = state.bySessionId[sessionId] ?? { revision: 0, lines: [] };
      const merged = reset ? [...lines] : [...existing.lines, ...lines];
      const capped = merged.length > READING_VIEW_LINE_CAP ? merged.slice(merged.length - READING_VIEW_LINE_CAP) : merged;
      return {
        bySessionId: {
          ...state.bySessionId,
          [sessionId]: { revision: existing.revision + 1, lines: capped },
        },
      };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.bySessionId)) return state;
      const bySessionId = { ...state.bySessionId };
      delete bySessionId[sessionId];
      return { bySessionId };
    }),

  reset: () => set({ bySessionId: {} }),
}));
