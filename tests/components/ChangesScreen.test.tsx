import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { ChangesScreen } from '@/screens/task/ChangesScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn() }),
  useLocalSearchParams: () => mockParams,
}));

// The diff list is ChangesTab's own concern (it starts a screen-scoped diff
// watch on mount); this suite pins the SCREEN's header wiring only.
jest.mock('@/screens/task/ChangesTab', () => ({
  ChangesTab: (): null => null,
}));

/**
 * ChangesScreen threads its taskId into TaskHeader, which is what puts the
 * current-column chip on the Changes destination. The chip's own behavior
 * (tap, long-press, hide-when-unlocated) is locked by TaskHeader.test.tsx;
 * this suite pins only that the screen passes the task through - dropping
 * the taskId prop from the header would leave every other test green.
 */
function seedLocatedTask(): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture(), boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 })],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-todo' }),
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

describe('ChangesScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1' };
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
  });

  it('shows the header column chip once a cached board locates the task', () => {
    seedLocatedTask();
    render(
      <ThemeProvider>
        <ChangesScreen />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('changes-screen')).toBeTruthy();
    expect(screen.getByTestId('task-header-column')).toBeTruthy();
    expect(screen.getByText('To Do')).toBeTruthy();
  });

  it('renders no chip while no board has located the task', () => {
    render(
      <ThemeProvider>
        <ChangesScreen />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('changes-screen')).toBeTruthy();
    expect(screen.queryByTestId('task-header-column')).toBeNull();
  });
});
