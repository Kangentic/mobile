import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { QuickKeyBar } from '@/components/terminal/QuickKeyBar';
import { useTerminalUiStore } from '@/state/terminalUiStore';

jest.mock('@/connection/actions', () => ({
  writeTerminal: jest.fn().mockResolvedValue(undefined),
}));

/**
 * The whole bar. Six keys, chosen so every common terminal interaction
 * completes WITHOUT raising the keyboard: navigate a numbered prompt or
 * recall history with the arrows, commit with Enter, back out with Esc,
 * interrupt a running agent with Ctrl+C.
 *
 * Enter is here despite the soft keyboard having a Return key, because both
 * arrow flows are navigate-then-commit and arrows without Enter would strand
 * the user at a choice they cannot take. Left/right are absent: they edit
 * inside an input line, which is keyboard-up work anyway, and dropping them
 * keeps every target over the 44pt minimum.
 */
const EXPECTED_SEQUENCES: { testID: string; sequence: string }[] = [
  { testID: 'quick-key-esc', sequence: '\x1b' },
  { testID: 'quick-key-tab', sequence: '\t' },
  { testID: 'quick-key-up', sequence: '\x1b[A' },
  { testID: 'quick-key-down', sequence: '\x1b[B' },
  { testID: 'quick-key-enter', sequence: '\r' },
  { testID: 'quick-key-ctrl-c', sequence: '\x03' },
];

// In application-cursor mode (DECCKM) the arrows switch from CSI to SS3.
const SS3_ARROWS: { testID: string; sequence: string }[] = [
  { testID: 'quick-key-up', sequence: '\x1bOA' },
  { testID: 'quick-key-down', sequence: '\x1bOB' },
];

describe('QuickKeyBar', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useTerminalUiStore.setState({ applicationCursorModeBySessionId: {} });
  });

  it.each(EXPECTED_SEQUENCES)('writes the CSI byte sequence for $testID in normal cursor mode', ({ testID, sequence }) => {
    const { writeTerminal } = jest.requireMock<{ writeTerminal: jest.Mock }>('@/connection/actions');

    render(
      <ThemeProvider>
        <QuickKeyBar sessionId="sess-1" />
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId(testID));
    expect(writeTerminal).toHaveBeenCalledTimes(1);
    expect(writeTerminal).toHaveBeenCalledWith('sess-1', sequence);
  });

  it.each(SS3_ARROWS)('writes the SS3 arrow sequence for $testID when the session is in application cursor mode', ({ testID, sequence }) => {
    const { writeTerminal } = jest.requireMock<{ writeTerminal: jest.Mock }>('@/connection/actions');
    useTerminalUiStore.getState().setApplicationCursorMode('sess-1', true);

    render(
      <ThemeProvider>
        <QuickKeyBar sessionId="sess-1" />
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId(testID));
    expect(writeTerminal).toHaveBeenCalledWith('sess-1', sequence);
  });

  it('keys DECCKM by session id: a different session stays in CSI mode', () => {
    const { writeTerminal } = jest.requireMock<{ writeTerminal: jest.Mock }>('@/connection/actions');
    useTerminalUiStore.getState().setApplicationCursorMode('other-session', true);

    render(
      <ThemeProvider>
        <QuickKeyBar sessionId="sess-1" />
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('quick-key-up'));
    expect(writeTerminal).toHaveBeenCalledWith('sess-1', '\x1b[A');
  });
});
