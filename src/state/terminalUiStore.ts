import { create } from 'zustand';
import type { TerminalStickyModes } from '@/terminal/modeRestore';

interface TerminalUiStoreState {
  /**
   * DECCKM (application cursor mode) per session, reported by the xterm
   * WebView's VT parser. The quick-key bar reads it to build SS3 arrow
   * sequences instead of CSI; everything defaults to false (normal mode).
   */
  applicationCursorModeBySessionId: Record<string, boolean>;
  /**
   * The last sticky VT modes the WebView reported per session, replayed ahead
   * of the scrollback on every re-init. It OUTLIVES the WebView deliberately:
   * a terminal recreated from a ring that no longer holds the TUI's startup
   * DECSETs cannot rediscover them, and this is the only surviving record.
   * Cleared with the rest of the session's render state on unmount.
   */
  stickyModesBySessionId: Record<string, TerminalStickyModes>;
  /**
   * A one-shot request to flip the session's lens, raised by deep chat
   * content (the prompt cards' "Answer in terminal" escape hatch - the
   * agent-agnostic path for free-text and exotic prompt options).
   * SessionScreen consumes and clears it.
   */
  requestedModeBySessionId: Record<string, 'terminal' | 'chat'>;
  /**
   * A one-shot request to raise the OS keyboard once the terminal lens is
   * visible and ready, raised alongside a `requestSessionMode('terminal')`
   * from the escape hatch only - never set on a manual lens toggle, so
   * switching to Terminal by hand never pops the keyboard. TerminalPane
   * consumes and clears it once it can actually focus (pane active and the
   * WebView ready).
   */
  focusKeyboardRequestBySessionId: Record<string, boolean>;
  setApplicationCursorMode: (sessionId: string, enabled: boolean) => void;
  setStickyModes: (sessionId: string, modes: TerminalStickyModes) => void;
  requestSessionMode: (sessionId: string, mode: 'terminal' | 'chat', options?: { focusKeyboard?: boolean }) => void;
  consumeRequestedMode: (sessionId: string) => void;
  consumeFocusKeyboardRequest: (sessionId: string) => void;
  clearSession: (sessionId: string) => void;
}

/**
 * Terminal render-layer state shared across the task screen's separate
 * component trees (the xterm pane owns the WebView that knows the VT modes;
 * the footer's quick keys need them). Ephemeral, never persisted.
 */
export const useTerminalUiStore = create<TerminalUiStoreState>((set) => ({
  applicationCursorModeBySessionId: {},
  stickyModesBySessionId: {},
  requestedModeBySessionId: {},
  focusKeyboardRequestBySessionId: {},

  setApplicationCursorMode: (sessionId, enabled) =>
    set((state) => {
      if ((state.applicationCursorModeBySessionId[sessionId] ?? false) === enabled) return state;
      return {
        applicationCursorModeBySessionId: { ...state.applicationCursorModeBySessionId, [sessionId]: enabled },
      };
    }),

  setStickyModes: (sessionId, modes) =>
    set((state) => {
      const current = state.stickyModesBySessionId[sessionId];
      if (
        current !== undefined &&
        current.applicationCursorKeys === modes.applicationCursorKeys &&
        current.mouseTrackingMode === modes.mouseTrackingMode &&
        current.mouseEncoding === modes.mouseEncoding &&
        current.alternateBuffer === modes.alternateBuffer
      ) {
        return state;
      }
      return { stickyModesBySessionId: { ...state.stickyModesBySessionId, [sessionId]: modes } };
    }),

  requestSessionMode: (sessionId, mode, options) =>
    set((state) => ({
      requestedModeBySessionId: { ...state.requestedModeBySessionId, [sessionId]: mode },
      focusKeyboardRequestBySessionId: options?.focusKeyboard
        ? { ...state.focusKeyboardRequestBySessionId, [sessionId]: true }
        : state.focusKeyboardRequestBySessionId,
    })),

  consumeRequestedMode: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.requestedModeBySessionId)) return state;
      const next = { ...state.requestedModeBySessionId };
      delete next[sessionId];
      return { requestedModeBySessionId: next };
    }),

  consumeFocusKeyboardRequest: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.focusKeyboardRequestBySessionId)) return state;
      const next = { ...state.focusKeyboardRequestBySessionId };
      delete next[sessionId];
      return { focusKeyboardRequestBySessionId: next };
    }),

  clearSession: (sessionId) =>
    set((state) => {
      const hasCursorMode = sessionId in state.applicationCursorModeBySessionId;
      const hasStickyModes = sessionId in state.stickyModesBySessionId;
      const hasRequestedMode = sessionId in state.requestedModeBySessionId;
      const hasFocusRequest = sessionId in state.focusKeyboardRequestBySessionId;
      if (!hasCursorMode && !hasStickyModes && !hasRequestedMode && !hasFocusRequest) return state;
      const nextCursorModes = { ...state.applicationCursorModeBySessionId };
      delete nextCursorModes[sessionId];
      const nextStickyModes = { ...state.stickyModesBySessionId };
      delete nextStickyModes[sessionId];
      const nextRequestedModes = { ...state.requestedModeBySessionId };
      delete nextRequestedModes[sessionId];
      const nextFocusRequests = { ...state.focusKeyboardRequestBySessionId };
      delete nextFocusRequests[sessionId];
      return {
        applicationCursorModeBySessionId: nextCursorModes,
        stickyModesBySessionId: nextStickyModes,
        requestedModeBySessionId: nextRequestedModes,
        focusKeyboardRequestBySessionId: nextFocusRequests,
      };
    }),
}));
