import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { EditTaskScreen } from '@/screens/EditTaskScreen';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
let mockParams: { taskId?: string; projectId?: string } = { taskId: 'task-1', projectId: 'project-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: jest.fn(), back: mockBack, push: jest.fn() }),
}));

const mockUpdateTaskFields = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/actions', () => ({
  updateTaskFields: (input: unknown) => mockUpdateTaskFields(input),
}));

function seedBoard(): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture()],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', title: 'Original title', description: 'Original description' }),
        },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
    },
    pendingMoves: [],
  });
}

function renderEditTaskScreen(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <EditTaskScreen />
    </ThemeProvider>,
  );
}

describe('EditTaskScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
    useBoardStore.getState().reset();
    seedBoard();
  });

  it('prefills the current values and gates save on dirtiness', () => {
    renderEditTaskScreen();
    expect(screen.getByTestId('edit-task-title').props.value).toBe('Original title');
    expect(screen.getByTestId('edit-task-description').props.value).toBe('Original description');

    // Unchanged: save is disabled, so an untouched open cannot overwrite a
    // field the desktop changed underneath.
    fireEvent.press(screen.getByTestId('edit-task-save'));
    expect(mockUpdateTaskFields).not.toHaveBeenCalled();
  });

  it('sends only the changed fields, with the task and project from the params', async () => {
    renderEditTaskScreen();
    fireEvent.changeText(screen.getByTestId('edit-task-title'), 'Renamed title');
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-task-save'));
    });

    expect(mockUpdateTaskFields).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskId: 'task-1',
      title: 'Renamed title',
    });
    expect(mockBack).toHaveBeenCalled();
  });

  it('never saves an empty title', async () => {
    renderEditTaskScreen();
    fireEvent.changeText(screen.getByTestId('edit-task-title'), '   ');
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-task-save'));
    });
    expect(mockUpdateTaskFields).not.toHaveBeenCalled();
  });

  it('keeps the sheet open with the reason when the save fails', async () => {
    mockUpdateTaskFields.mockRejectedValueOnce(new Error('The desktop rejected the edit'));
    renderEditTaskScreen();
    fireEvent.changeText(screen.getByTestId('edit-task-title'), 'Renamed title');
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-task-save'));
    });

    expect(screen.getByText('The desktop rejected the edit')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });

  /** A task the board has not located yet must not render a form over empty values. */
  it('renders nothing for an unknown task', () => {
    mockParams = { taskId: 'task-missing', projectId: 'project-1' };
    renderEditTaskScreen();
    expect(screen.queryByTestId('edit-task-title')).toBeNull();
  });
});
