import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TaskHeader } from '@/screens/task/TaskHeader';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

/**
 * The header's current-column chip: status (which column the task sits in)
 * and affordance (tap = the move sheet, long-press = the actions hub) in one
 * element. It renders only once a cached board locates the task, because
 * MoveTaskScreen renders a dead sheet against a board it cannot find - the
 * guard lives HERE, once, rather than in each screen that hosts the header.
 */
function seedLocatedTask(swimlaneId: string = 'lane-todo'): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture(), boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 })],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: swimlaneId }),
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

function renderTaskHeader(props: Partial<React.ComponentProps<typeof TaskHeader>> = {}): void {
  render(
    <ThemeProvider>
      <TaskHeader taskTitle="Fix the login bug" sessionId={null} taskId="task-1" {...props} />
    </ThemeProvider>,
  );
}

describe('TaskHeader column chip', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
  });

  it('shows the current-column chip when a cached board locates the task', () => {
    seedLocatedTask();
    renderTaskHeader();
    expect(screen.getByTestId('task-header-column')).toBeTruthy();
    expect(screen.getByText('To Do')).toBeTruthy();
  });

  it('renders no chip when no board has located the task', () => {
    renderTaskHeader();
    expect(screen.queryByTestId('task-header-column')).toBeNull();
  });

  it("renders no chip when the task's swimlane names no column", () => {
    seedLocatedTask('lane-gone');
    renderTaskHeader();
    expect(screen.queryByTestId('task-header-column')).toBeNull();
  });

  /** The CompletedTaskScreen contract: archived tasks are on no board, so it passes no taskId and gets no chip. */
  it('renders no chip without a taskId', () => {
    seedLocatedTask();
    renderTaskHeader({ taskId: null });
    expect(screen.queryByTestId('task-header-column')).toBeNull();
  });

  it("tapping the chip pushes the move-task form sheet with the task and its board's project", () => {
    seedLocatedTask();
    renderTaskHeader();

    fireEvent.press(screen.getByTestId('task-header-column'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/move-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });

  it('long-pressing the chip pushes the task-actions hub with the same params', () => {
    seedLocatedTask();
    renderTaskHeader();

    fireEvent(screen.getByTestId('task-header-column'), 'longPress');

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/task-actions',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });
});
