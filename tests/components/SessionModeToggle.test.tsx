import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SessionModeToggle, type SessionMode } from '@/screens/task/SessionModeToggle';

function renderToggle(mode: SessionMode, chatAttention = false): jest.Mock {
  const onModeChange = jest.fn();
  render(
    <ThemeProvider>
      <SessionModeToggle mode={mode} onModeChange={onModeChange} chatAttention={chatAttention} />
    </ThemeProvider>,
  );
  return onModeChange;
}

describe('SessionModeToggle', () => {
  it('marks the active segment via accessibility state', () => {
    renderToggle('terminal');
    expect(screen.getByTestId('session-mode-terminal').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('session-mode-chat').props.accessibilityState).toEqual({ selected: false });
  });

  it('reports segment taps', () => {
    const onModeChange = renderToggle('terminal');
    fireEvent.press(screen.getByTestId('session-mode-chat'));
    expect(onModeChange).toHaveBeenCalledWith('chat');
    fireEvent.press(screen.getByTestId('session-mode-terminal'));
    expect(onModeChange).toHaveBeenCalledWith('terminal');
  });

  it('shows the needs-you dot on the chat segment only when flagged', () => {
    renderToggle('terminal', true);
    expect(screen.getByTestId('session-mode-chat-attention')).toBeTruthy();
  });

  it('hides the needs-you dot when nothing is pending', () => {
    renderToggle('terminal', false);
    expect(screen.queryByTestId('session-mode-chat-attention')).toBeNull();
  });
});
