import { create } from 'zustand';

interface TerminalUiStoreState {
  /**
   * DECCKM (application cursor mode) per session, reported by the xterm
   * WebView's VT parser. The quick-key bar reads it to build SS3 arrow
   * sequences instead of CSI; everything defaults to false (normal mode).
   */
  applicationCursorModeBySessionId: Record<string, boolean>;
  setApplicationCursorMode: (sessionId: string, enabled: boolean) => void;
  clearSession: (sessionId: string) => void;
}

/**
 * Terminal render-layer state shared across the task screen's separate
 * component trees (the xterm pane owns the WebView that knows the VT modes;
 * the footer's quick keys need them). Ephemeral, never persisted.
 */
export const useTerminalUiStore = create<TerminalUiStoreState>((set) => ({
  applicationCursorModeBySessionId: {},

  setApplicationCursorMode: (sessionId, enabled) =>
    set((state) => {
      if ((state.applicationCursorModeBySessionId[sessionId] ?? false) === enabled) return state;
      return {
        applicationCursorModeBySessionId: { ...state.applicationCursorModeBySessionId, [sessionId]: enabled },
      };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.applicationCursorModeBySessionId)) return state;
      const next = { ...state.applicationCursorModeBySessionId };
      delete next[sessionId];
      return { applicationCursorModeBySessionId: next };
    }),
}));
