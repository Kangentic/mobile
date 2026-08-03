import { beforeEach, describe, expect, it } from 'vitest';
import { useTerminalUiStore } from '@/state/terminalUiStore';
import type { TerminalStickyModes } from '@/terminal/modeRestore';

const SESSION_ID = 'sess-sticky-modes';

const BASELINE_MODES: TerminalStickyModes = {
  applicationCursorKeys: true,
  mouseTrackingMode: 'vt200',
  mouseEncoding: 'SGR',
  alternateBuffer: true,
};

describe('terminalUiStore setStickyModes', () => {
  beforeEach(() => {
    useTerminalUiStore.setState({
      applicationCursorModeBySessionId: {},
      stickyModesBySessionId: {},
      requestedModeBySessionId: {},
      focusKeyboardRequestBySessionId: {},
    });
  });

  it('returns the same state object (no update) when all four fields are unchanged', () => {
    useTerminalUiStore.getState().setStickyModes(SESSION_ID, BASELINE_MODES);
    const stateAfterFirstWrite = useTerminalUiStore.getState();

    let notified = false;
    const unsubscribe = useTerminalUiStore.subscribe(() => {
      notified = true;
    });
    // A fresh object with the identical field values, not the same reference -
    // the equality check must compare fields, not identity.
    useTerminalUiStore.getState().setStickyModes(SESSION_ID, { ...BASELINE_MODES });
    unsubscribe();

    expect(useTerminalUiStore.getState()).toBe(stateAfterFirstWrite);
    expect(notified).toBe(false);
  });

  it('updates when any single field changes', () => {
    useTerminalUiStore.getState().setStickyModes(SESSION_ID, BASELINE_MODES);
    const stateAfterFirstWrite = useTerminalUiStore.getState();

    let notified = false;
    const unsubscribe = useTerminalUiStore.subscribe(() => {
      notified = true;
    });
    useTerminalUiStore.getState().setStickyModes(SESSION_ID, { ...BASELINE_MODES, mouseTrackingMode: 'any' });
    unsubscribe();

    expect(useTerminalUiStore.getState()).not.toBe(stateAfterFirstWrite);
    expect(notified).toBe(true);
    expect(useTerminalUiStore.getState().stickyModesBySessionId[SESSION_ID]).toEqual({
      ...BASELINE_MODES,
      mouseTrackingMode: 'any',
    });
  });

  it('clearSession removes the session entry from stickyModesBySessionId and the other three maps', () => {
    const otherSessionId = 'sess-other';
    useTerminalUiStore.getState().setStickyModes(SESSION_ID, BASELINE_MODES);
    useTerminalUiStore.getState().setStickyModes(otherSessionId, BASELINE_MODES);
    useTerminalUiStore.getState().setApplicationCursorMode(SESSION_ID, true);
    useTerminalUiStore.getState().requestSessionMode(SESSION_ID, 'terminal', { focusKeyboard: true });

    useTerminalUiStore.getState().clearSession(SESSION_ID);

    const stateAfterClear = useTerminalUiStore.getState();
    expect(stateAfterClear.stickyModesBySessionId[SESSION_ID]).toBeUndefined();
    expect(stateAfterClear.applicationCursorModeBySessionId[SESSION_ID]).toBeUndefined();
    expect(stateAfterClear.requestedModeBySessionId[SESSION_ID]).toBeUndefined();
    expect(stateAfterClear.focusKeyboardRequestBySessionId[SESSION_ID]).toBeUndefined();
    // The other session's entry survives - clearSession is scoped, not a wipe.
    expect(stateAfterClear.stickyModesBySessionId[otherSessionId]).toEqual(BASELINE_MODES);
  });
});
