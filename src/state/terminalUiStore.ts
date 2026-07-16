import { create } from 'zustand';

interface TerminalUiStoreState {
  /**
   * DECCKM (application cursor mode) per session, reported by the xterm
   * WebView's VT parser. The quick-key bar reads it to build SS3 arrow
   * sequences instead of CSI; everything defaults to false (normal mode).
   */
  applicationCursorModeBySessionId: Record<string, boolean>;
  /**
   * A one-shot request to flip the session's lens, raised by deep chat
   * content (the prompt cards' "Answer in terminal" escape hatch - the
   * agent-agnostic path for free-text and exotic prompt options).
   * SessionScreen consumes and clears it.
   */
  requestedModeBySessionId: Record<string, 'terminal' | 'chat'>;
  setApplicationCursorMode: (sessionId: string, enabled: boolean) => void;
  requestSessionMode: (sessionId: string, mode: 'terminal' | 'chat') => void;
  consumeRequestedMode: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
}

/**
 * Terminal render-layer state shared across the task screen's separate
 * component trees (the xterm pane owns the WebView that knows the VT modes;
 * the footer's quick keys need them). Ephemeral, never persisted.
 */
export const useTerminalUiStore = create<TerminalUiStoreState>((set) => ({
  applicationCursorModeBySessionId: {},
  requestedModeBySessionId: {},

  setApplicationCursorMode: (sessionId, enabled) =>
    set((state) => {
      if ((state.applicationCursorModeBySessionId[sessionId] ?? false) === enabled) return state;
      return {
        applicationCursorModeBySessionId: { ...state.applicationCursorModeBySessionId, [sessionId]: enabled },
      };
    }),

  requestSessionMode: (sessionId, mode) =>
    set((state) => ({
      requestedModeBySessionId: { ...state.requestedModeBySessionId, [sessionId]: mode },
    })),

  consumeRequestedMode: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.requestedModeBySessionId)) return state;
      const next = { ...state.requestedModeBySessionId };
      delete next[sessionId];
      return { requestedModeBySessionId: next };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      const hasCursorMode = sessionId in state.applicationCursorModeBySessionId;
      const hasRequestedMode = sessionId in state.requestedModeBySessionId;
      if (!hasCursorMode && !hasRequestedMode) return state;
      const nextCursorModes = { ...state.applicationCursorModeBySessionId };
      delete nextCursorModes[sessionId];
      const nextRequestedModes = { ...state.requestedModeBySessionId };
      delete nextRequestedModes[sessionId];
      return { applicationCursorModeBySessionId: nextCursorModes, requestedModeBySessionId: nextRequestedModes };
    }),
}));
