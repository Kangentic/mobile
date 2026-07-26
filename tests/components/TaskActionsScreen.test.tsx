import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TaskActionsScreen } from '@/screens/TaskActionsScreen';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockParams: { taskId?: string; projectId?: string } = { taskId: 'task-1', projectId: 'project-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: mockReplace, back: mockBack, push: jest.fn() }),
}));

const mockArchiveTask = jest.fn().mockResolvedValue(undefined);
const mockDeleteTaskFromBoard = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/actions', () => ({
  archiveTask: (input: unknown) => mockArchiveTask(input),
  deleteTaskFromBoard: (input: unknown) => mockDeleteTaskFromBoard(input),
}));

/** `withDoneColumn` decides whether Archive is even possible - it is a move into a done-role column. */
function seedBoard({ withDoneColumn }: { withDoneColumn: boolean }): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [
          boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 }),
          ...(withDoneColumn ? [boardColumnFixture({ id: 'lane-done', name: 'Done', position: 1, role: 'done' })] : []),
        ],
        tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', title: 'Fix the login bug', swimlane_id: 'lane-todo' }) },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
    },
    pendingMoves: [],
  });
}

function renderTaskActions(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <TaskActionsScreen />
    </ThemeProvider>,
  );
}

describe('TaskActionsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
    useBoardStore.getState().reset();
    seedBoard({ withDoneColumn: true });
  });

  it('titles itself with the task and offers the full lifecycle', () => {
    renderTaskActions();
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    expect(screen.getByTestId('task-action-move')).toBeTruthy();
    expect(screen.getByTestId('task-action-edit')).toBeTruthy();
    expect(screen.getByTestId('task-action-archive')).toBeTruthy();
    expect(screen.getByTestId('task-action-delete')).toBeTruthy();
  });

  /**
   * REPLACE, not push: dismissing the sheet these open should return to the
   * board, not to a menu the user has already finished with.
   */
  it('replaces itself with the move and edit sheets rather than stacking on them', () => {
    renderTaskActions();

    fireEvent.press(screen.getByTestId('task-action-move'));
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/move-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });

    fireEvent.press(screen.getByTestId('task-action-edit'));
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/edit-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });

  it('archives and dismisses', async () => {
    renderTaskActions();
    await act(async () => {
      fireEvent.press(screen.getByTestId('task-action-archive'));
    });
    expect(mockArchiveTask).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
    expect(mockBack).toHaveBeenCalled();
  });

  /** Archive is a move into the done column, so a board without one cannot offer it. */
  it('disables archive on a board with no done column, and says why', () => {
    seedBoard({ withDoneColumn: false });
    renderTaskActions();
    expect(screen.getByTestId('task-action-archive').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByText('No Done column on this board')).toBeTruthy();
  });

  /** Delete also kills the task's live desktop session, so one tap must never fire it. */
  it('requires a second tap to delete', async () => {
    renderTaskActions();

    fireEvent.press(screen.getByTestId('task-action-delete'));
    expect(mockDeleteTaskFromBoard).not.toHaveBeenCalled();
    expect(screen.getByText('Removes the task and stops its session on your desktop')).toBeTruthy();

    await act(async () => {
      fireEvent.press(screen.getByTestId('task-action-delete-confirm'));
    });
    expect(mockDeleteTaskFromBoard).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
    expect(mockBack).toHaveBeenCalled();
  });

  it('keeps the sheet open with the reason when an action fails', async () => {
    mockArchiveTask.mockRejectedValueOnce(new Error('The desktop refused'));
    renderTaskActions();
    await act(async () => {
      fireEvent.press(screen.getByTestId('task-action-archive'));
    });
    expect(screen.getByText('The desktop refused')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });
});
