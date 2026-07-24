import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { MoveTaskSheet, type MoveTaskSheetProps } from '@/components/board/MoveTaskSheet';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

function baseProps(overrides: Partial<MoveTaskSheetProps> = {}): MoveTaskSheetProps {
  return {
    visible: true,
    task: boardTaskFixture({ id: 'task-1', title: 'Fix the login bug', swimlane_id: 'lane-todo' }),
    columns: [
      boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 }),
      boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 }),
    ],
    onClose: jest.fn(),
    onMove: jest.fn(),
    moveInFlight: false,
    errorMessage: null,
    ...overrides,
  };
}

describe('MoveTaskSheet', () => {
  it('selecting a non-current column enables the confirm button', () => {
    const props = baseProps();
    render(
      <ThemeProvider>
        <MoveTaskSheet {...props} />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(true);

    fireEvent.press(screen.getByTestId('move-target-lane-doing'));

    expect(screen.getByTestId('move-target-lane-doing').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(false);
  });

  it('does not carry a stale selection across a hide/reopen cycle (regression: closing via visible must reset the pick)', () => {
    // Every caller (BoardScreen, TriageHomeScreen) closes a successful move
    // by flipping `visible` to false, bypassing this component's own
    // `close` handler - which is exactly the path that used to leak the
    // selected column into the next open, pre-enabling Move with no visible
    // choice (or, in the multi-project Triage reuse, aiming at a column
    // absent from the next task's board).
    const props = baseProps();
    const view = render(
      <ThemeProvider>
        <MoveTaskSheet {...props} />
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('move-target-lane-doing'));
    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(false);

    // The parent hides the sheet the way a successful move actually does:
    // by flipping `visible`, not by calling `onClose`.
    view.rerender(
      <ThemeProvider>
        <MoveTaskSheet {...props} visible={false} />
      </ThemeProvider>,
    );

    // Reopen (e.g. the next long-press, possibly on a different task/board).
    view.rerender(
      <ThemeProvider>
        <MoveTaskSheet {...props} visible />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('move-target-lane-todo').props.accessibilityState.selected).toBe(false);
    expect(screen.getByTestId('move-target-lane-doing').props.accessibilityState.selected).toBe(false);
  });
});
