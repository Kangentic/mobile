import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TaskActionsSheet } from '@/components/board/TaskActionsSheet';
import { boardTaskFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

interface RenderOverrides {
  archiveAvailable?: boolean;
  onMove?: jest.Mock;
  onEdit?: jest.Mock;
  onArchive?: jest.Mock;
  onDelete?: jest.Mock;
}

function renderSheet(overrides: RenderOverrides = {}): Required<RenderOverrides> {
  const handlers = {
    archiveAvailable: overrides.archiveAvailable ?? true,
    onMove: overrides.onMove ?? jest.fn(),
    onEdit: overrides.onEdit ?? jest.fn(),
    onArchive: overrides.onArchive ?? jest.fn(),
    onDelete: overrides.onDelete ?? jest.fn(),
  };
  render(
    <ThemeProvider>
      <TaskActionsSheet
        visible
        task={boardTaskFixture({ id: 'task-1', title: 'Fix the login bug' })}
        archiveAvailable={handlers.archiveAvailable}
        onClose={jest.fn()}
        onMove={handlers.onMove}
        onEdit={handlers.onEdit}
        onArchive={handlers.onArchive}
        onDelete={handlers.onDelete}
        actionInFlight={false}
        errorMessage={null}
      />
    </ThemeProvider>,
  );
  return handlers;
}

describe('TaskActionsSheet', () => {
  it('routes move, edit, and archive actions', () => {
    const handlers = renderSheet();
    fireEvent.press(screen.getByTestId('task-action-move'));
    expect(handlers.onMove).toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('task-action-edit'));
    expect(handlers.onEdit).toHaveBeenCalled();
    fireEvent.press(screen.getByTestId('task-action-archive'));
    expect(handlers.onArchive).toHaveBeenCalled();
  });

  it('requires the two-step confirm before deleting', () => {
    const handlers = renderSheet();
    fireEvent.press(screen.getByTestId('task-action-delete'));
    expect(handlers.onDelete).not.toHaveBeenCalled();
    expect(screen.getByText('Tap again to delete')).toBeTruthy();
    fireEvent.press(screen.getByTestId('task-action-delete-confirm'));
    expect(handlers.onDelete).toHaveBeenCalled();
  });

  it('disarms the delete confirm after the window elapses', () => {
    jest.useFakeTimers();
    try {
      const handlers = renderSheet();
      fireEvent.press(screen.getByTestId('task-action-delete'));
      act(() => {
        jest.advanceTimersByTime(5100);
      });
      expect(screen.getByTestId('task-action-delete')).toBeTruthy();
      expect(handlers.onDelete).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('disables archive when the board has no done column', () => {
    const handlers = renderSheet({ archiveAvailable: false });
    expect(screen.getByText('No Done column on this board')).toBeTruthy();
    fireEvent.press(screen.getByTestId('task-action-archive'));
    expect(handlers.onArchive).not.toHaveBeenCalled();
  });
});
