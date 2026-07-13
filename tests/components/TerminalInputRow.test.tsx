import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TerminalInputRow } from '@/components/terminal/TerminalInputRow';

jest.mock('@/connection/actions', () => ({
  writeTerminal: jest.fn().mockResolvedValue(undefined),
}));

function renderInputRow(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <TerminalInputRow sessionId="sess-1" />
    </ThemeProvider>,
  );
}

describe('TerminalInputRow', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('sends the typed text with a trailing carriage return and clears the field', async () => {
    const { writeTerminal } = jest.requireMock<{ writeTerminal: jest.Mock }>('@/connection/actions');
    renderInputRow();

    fireEvent.changeText(screen.getByTestId('terminal-input'), 'ls -la');
    fireEvent.press(screen.getByTestId('terminal-input-send'));

    expect(writeTerminal).toHaveBeenCalledTimes(1);
    expect(writeTerminal).toHaveBeenCalledWith('sess-1', 'ls -la\r');
    await waitFor(() => expect(screen.getByTestId('terminal-input').props.value).toBe(''));
  });

  it('keeps the draft and shows an inline error when the write fails', async () => {
    const { writeTerminal } = jest.requireMock<{ writeTerminal: jest.Mock }>('@/connection/actions');
    writeTerminal.mockRejectedValueOnce(new Error('Not connected to the desktop'));
    renderInputRow();

    fireEvent.changeText(screen.getByTestId('terminal-input'), 'ls');
    fireEvent.press(screen.getByTestId('terminal-input-send'));

    await waitFor(() => expect(screen.getByTestId('terminal-input-error')).toBeTruthy());
    expect(screen.getByText('Not connected to the desktop')).toBeTruthy();
    expect(screen.getByTestId('terminal-input').props.value).toBe('ls');
  });
});
