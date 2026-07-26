import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SessionModeToggle } from '@/screens/task/SessionModeToggle';
import type { SessionMode } from '@/screens/task/sessionModes';

function renderToggle(mode: SessionMode, chatAttention = false): { onModeChange: jest.Mock } {
  const onModeChange = jest.fn();
  render(
    <ThemeProvider>
      <SessionModeToggle mode={mode} onModeChange={onModeChange} chatAttention={chatAttention} />
    </ThemeProvider>,
  );
  return { onModeChange };
}

describe('SessionModeToggle', () => {
  it('marks the active surface via accessibility state', () => {
    renderToggle('terminal');
    expect(screen.getByTestId('session-mode-terminal').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('session-mode-chat').props.accessibilityState).toEqual({ selected: false });
    expect(screen.getByTestId('session-mode-changes').props.accessibilityState).toEqual({ selected: false });
  });

  it('reports a tap on an inactive surface and ignores the active one', () => {
    const { onModeChange } = renderToggle('terminal');

    fireEvent.press(screen.getByTestId('session-mode-chat'));
    expect(onModeChange).toHaveBeenCalledWith('chat');

    onModeChange.mockClear();
    fireEvent.press(screen.getByTestId('session-mode-terminal'));
    expect(onModeChange).not.toHaveBeenCalled();
  });

  /**
   * The switcher holds the three SURFACES and nothing else. Move used to sit
   * here as a fourth segment, which made a command look like a place you could
   * be; it belongs to the long-press actions hub.
   */
  it('offers only the three surfaces, with no action segments', () => {
    renderToggle('terminal');
    expect(screen.queryByTestId('session-mode-move')).toBeNull();
  });

  /**
   * This dot is how you learn a prompt is waiting in Chat while you are
   * reading the terminal, so it must appear on the CHAT segment specifically.
   */
  it('shows the needs-you dot on the chat surface only when flagged', () => {
    renderToggle('terminal', true);
    expect(screen.getByTestId('session-mode-chat-attention')).toBeTruthy();
  });

  it('hides the needs-you dot when nothing is pending', () => {
    renderToggle('terminal', false);
    expect(screen.queryByTestId('session-mode-chat-attention')).toBeNull();
  });
});
