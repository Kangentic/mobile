import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { CreateTaskScreen } from '@/screens/CreateTaskScreen';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
let mockParams: { projectId?: string } = { projectId: 'project-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: jest.fn(), back: mockBack, push: jest.fn() }),
}));

const mockCreateTask = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/actions', () => ({
  createTask: (input: unknown) => mockCreateTask(input),
}));

function seedBoard(): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [
          boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 }),
          boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 }),
        ],
        tasksById: {},
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
    },
    pendingMoves: [],
  });
}

function renderCreateTaskScreen(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <CreateTaskScreen />
    </ThemeProvider>,
  );
}

describe('CreateTaskScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { projectId: 'project-1' };
    useBoardStore.getState().reset();
    seedBoard();
  });

  /**
   * The column defaults to the board's FIRST column, never whichever one the
   * pager happened to be showing: a new task is new work, not a continuation
   * of whatever was being read.
   */
  it('creates in the first column by default and dismisses the sheet on success', async () => {
    renderCreateTaskScreen();

    fireEvent.changeText(screen.getByTestId('create-task-title'), 'New feature');
    await act(async () => {
      fireEvent.press(screen.getByTestId('create-task-confirm'));
    });

    expect(mockCreateTask).toHaveBeenCalledWith({
      projectId: 'project-1',
      title: 'New feature',
      description: '',
      column: 'To Do',
    });
    // Dismissing IS router.back() now: the sheet is a route, so there is no
    // visible prop for anything to leave stuck open.
    expect(mockBack).toHaveBeenCalled();
  });

  it('sends the tapped column, and offers Backlog alongside the real ones', async () => {
    renderCreateTaskScreen();

    expect(screen.getByTestId('create-task-column-Backlog')).toBeTruthy();
    fireEvent.press(screen.getByTestId('create-task-column-Doing'));
    expect(screen.getByTestId('create-task-column-Doing').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('create-task-column-To Do').props.accessibilityState).toEqual({ selected: false });

    fireEvent.changeText(screen.getByTestId('create-task-title'), 'Ship it');
    await act(async () => {
      fireEvent.press(screen.getByTestId('create-task-confirm'));
    });

    expect(mockCreateTask).toHaveBeenCalledWith({
      projectId: 'project-1',
      title: 'Ship it',
      description: '',
      column: 'Doing',
    });
  });

  it('trims the title and blocks confirm on a blank one', async () => {
    renderCreateTaskScreen();

    // Whitespace only: the button stays disabled and nothing is sent.
    fireEvent.changeText(screen.getByTestId('create-task-title'), '   ');
    await act(async () => {
      fireEvent.press(screen.getByTestId('create-task-confirm'));
    });
    expect(mockCreateTask).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByTestId('create-task-title'), '  Padded  ');
    fireEvent.changeText(screen.getByTestId('create-task-description'), '  notes  ');
    await act(async () => {
      fireEvent.press(screen.getByTestId('create-task-confirm'));
    });
    expect(mockCreateTask).toHaveBeenCalledWith({
      projectId: 'project-1',
      title: 'Padded',
      description: 'notes',
      column: 'To Do',
    });
  });

  /** A failed create keeps the sheet open with the reason, so the typing is not lost. */
  it('surfaces a failure and stays open', async () => {
    mockCreateTask.mockRejectedValueOnce(new Error('relay down'));
    renderCreateTaskScreen();

    fireEvent.changeText(screen.getByTestId('create-task-title'), 'New feature');
    await act(async () => {
      fireEvent.press(screen.getByTestId('create-task-confirm'));
    });

    expect(screen.getByText('Create failed - check the connection')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByTestId('create-task-title').props.value).toBe('New feature');
  });
});
