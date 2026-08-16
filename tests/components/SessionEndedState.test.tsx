import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SessionEndedState } from '@/screens/task/SessionEndedState';

/**
 * Props-level coverage of the ended-state buttons. The signals that decide
 * WHEN the overlay shows (and whether the task is still movable) live in
 * SessionScreen and are locked by SessionScreen.session-swap.test.tsx; this
 * suite only pins the overlay's own contract. `session-ended-view-changes`
 * is a Maestro anchor (.maestro/paired/session-ended-state.yaml) - its
 * testID must never change.
 */
describe('SessionEndedState', () => {
  it('renders both buttons and fires their callbacks when the task is movable', () => {
    const onViewChanges = jest.fn();
    const onMoveTask = jest.fn();
    render(
      <ThemeProvider>
        <SessionEndedState onViewChanges={onViewChanges} onMoveTask={onMoveTask} />
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('session-ended-view-changes'));
    expect(onViewChanges).toHaveBeenCalledTimes(1);

    fireEvent.press(screen.getByTestId('session-ended-move-task'));
    expect(onMoveTask).toHaveBeenCalledTimes(1);
  });

  it('omits the Move button when the task cannot be moved (null or absent callback)', () => {
    const { rerender } = render(
      <ThemeProvider>
        <SessionEndedState onViewChanges={jest.fn()} onMoveTask={null} />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('session-ended-move-task')).toBeNull();
    expect(screen.getByTestId('session-ended-view-changes')).toBeTruthy();

    rerender(
      <ThemeProvider>
        <SessionEndedState onViewChanges={jest.fn()} />
      </ThemeProvider>,
    );
    expect(screen.queryByTestId('session-ended-move-task')).toBeNull();
  });
});
