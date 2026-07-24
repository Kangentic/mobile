import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SessionModeToggle, type SessionMode } from '@/screens/task/SessionModeToggle';

function renderToggle(mode: SessionMode, chatAttention = false): { onModeChange: jest.Mock; onMove: jest.Mock } {
  const onModeChange = jest.fn();
  const onMove = jest.fn();
  render(
    <ThemeProvider>
      <SessionModeToggle mode={mode} onModeChange={onModeChange} chatAttention={chatAttention} onMove={onMove} />
    </ThemeProvider>,
  );
  return { onModeChange, onMove };
}

describe('SessionModeToggle', () => {
  it('marks the active segment via accessibility state', () => {
    renderToggle('terminal');
    expect(screen.getByTestId('session-mode-terminal').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('session-mode-chat').props.accessibilityState).toEqual({ selected: false });
  });

  it('reports a tap on the inactive segment and ignores the active one', () => {
    const { onModeChange } = renderToggle('terminal');
    fireEvent.press(screen.getByTestId('session-mode-chat'));
    expect(onModeChange).toHaveBeenCalledWith('chat');
    onModeChange.mockClear();
    fireEvent.press(screen.getByTestId('session-mode-terminal'));
    expect(onModeChange).not.toHaveBeenCalled();
  });

  it('never marks the Move segment selected and fires onMove without changing mode', () => {
    const { onModeChange, onMove } = renderToggle('terminal');
    expect(screen.getByTestId('session-mode-move').props.accessibilityState).toEqual({ selected: false });
    fireEvent.press(screen.getByTestId('session-mode-move'));
    expect(onMove).toHaveBeenCalledTimes(1);
    expect(onModeChange).not.toHaveBeenCalled();
    expect(screen.getByTestId('session-mode-move').props.accessibilityState).toEqual({ selected: false });
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
