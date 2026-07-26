import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { BoardScreen } from '@/screens/BoardScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
  // The screen is always "focused" under test; the real hook runs the effect
  // on focus and the cleanup on blur, which is the same thing for one render.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
}));

const mockMoveTaskOptimistic = jest.fn().mockResolvedValue(undefined);
const mockCreateTask = jest.fn().mockResolvedValue(undefined);
const mockUpdateTaskFields = jest.fn().mockResolvedValue(undefined);
const mockDeleteTaskFromBoard = jest.fn().mockResolvedValue(undefined);
const mockArchiveTask = jest.fn().mockResolvedValue(undefined);
const mockOpenProjectBoard = jest.fn();
jest.mock('@/connection/actions', () => ({
  moveTaskOptimistic: (input: unknown) => mockMoveTaskOptimistic(input),
  openProjectBoard: (projectId: string) => mockOpenProjectBoard(projectId),
  createTask: (input: unknown) => mockCreateTask(input),
  updateTaskFields: (input: unknown) => mockUpdateTaskFields(input),
  deleteTaskFromBoard: (input: unknown) => mockDeleteTaskFromBoard(input),
  archiveTask: (input: unknown) => mockArchiveTask(input),
  refreshSnapshots: jest.fn().mockResolvedValue(undefined),
}));

function baseTask(id: string, title: string, swimlaneId: string, position: number, sessionId: string | null) {
  return {
    id,
    display_id: position + 1,
    title,
    description: '',
    swimlane_id: swimlaneId,
    position,
    agent: 'claude',
    session_id: sessionId,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    base_branch: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '2026-07-13T00:00:00.000Z',
    updated_at: '2026-07-13T00:00:00.000Z',
  };
}

function column(id: string, name: string, position: number) {
  return { id, name, description: null, role: null, position, color: '#3fb950', icon: null, is_archived: false, is_ghost: false };
}

function seedBoard(): void {
  useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true });
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [column('lane-todo', 'To Do', 0), column('lane-doing', 'Doing', 1)],
        tasksById: {
          'task-1': baseTask('task-1', 'Fix the login bug', 'lane-todo', 0, 'sess-1'),
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

describe('BoardScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockMoveTaskOptimistic.mockClear();
    mockCreateTask.mockClear();
    seedBoard();
  });

  /**
   * The feed projection carries only the tasks with an agent on them. Painting
   * one here would show a board missing most of its cards, which then fill in
   * a beat later - the staggered cold start this release set out to remove.
   */
  it('asks for the full board on focus and shows placeholders until it lands', () => {
    act(() => {
      useBoardStore.setState((state) => ({
        boardsByProjectId: {
          ...state.boardsByProjectId,
          'project-1': { ...state.boardsByProjectId['project-1'], view: 'sessions', taskCountsByColumnId: { 'lane-todo': 4 } },
        },
      }));
    });
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );

    expect(mockOpenProjectBoard).toHaveBeenCalledWith('project-1');
    expect(screen.getByTestId('board-loading')).toBeTruthy();
    expect(screen.queryByTestId('board-column-lane-todo')).toBeNull();
    expect(screen.queryByText('Fix the login bug')).toBeNull();
    // Not the "no board yet" empty state either - the board exists, it is
    // one round trip away from being complete.
    expect(screen.queryByTestId('board-empty-state')).toBeNull();

    act(() => {
      useBoardStore.setState((state) => ({
        boardsByProjectId: {
          ...state.boardsByProjectId,
          'project-1': { ...state.boardsByProjectId['project-1'], view: 'full' },
        },
      }));
    });
    expect(screen.queryByTestId('board-loading')).toBeNull();
    expect(screen.getByTestId('board-column-lane-todo')).toBeTruthy();
  });

  it('renders columns from the live store and navigates on card tap', () => {
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('board-column-lane-todo')).toBeTruthy();
    expect(screen.getByText('Fix the login bug')).toBeTruthy();

    fireEvent.press(screen.getByTestId('board-card-task-1'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/task/[taskId]',
      params: { taskId: 'task-1', sessionId: 'sess-1', projectId: 'project-1' },
    });
  });

  it('shows the ticket number only when the board setting is on', () => {
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('board-card-task-1-display-id')).toBeTruthy();

    act(() => {
      useBoardStore.setState((state) => ({
        boardsByProjectId: {
          ...state.boardsByProjectId,
          'project-1': { ...state.boardsByProjectId['project-1'], showTicketNumbers: false },
        },
      }));
    });
    expect(screen.queryByTestId('board-card-task-1-display-id')).toBeNull();
  });

  it('renders the model + context-usage row for a session with trusted usage', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: {
        type: 'usage',
        usage: {
          contextWindow: { usedPercentage: 47, usedTokens: 94000, cacheTokens: 0, totalInputTokens: 94000, totalOutputTokens: 4000, contextWindowSize: 200000 },
          cost: { totalCostUsd: 2.5, totalDurationMs: 120000 },
          model: { id: 'claude-fable-5', displayName: 'Fable 5' },
        },
      },
    });
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('board-card-task-1-usage')).toBeTruthy();
    expect(screen.getByText('Fable 5')).toBeTruthy();
    expect(screen.getByText('47%')).toBeTruthy();
  });

  /**
   * Move is a native form sheet ROUTE now, so the board dismisses the actions
   * sheet and navigates. The append math (targetPosition = the target column's
   * existing count, not a hardcoded 0) moved with it, and is asserted in
   * tests/components/MoveTaskScreen.test.tsx.
   */
  it('long-press opens the actions sheet; Move dismisses it and navigates to the move route', () => {
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    fireEvent(screen.getByTestId('board-card-task-1'), 'longPress');
    expect(screen.getByTestId('task-actions-sheet')).toBeTruthy();

    fireEvent.press(screen.getByTestId('task-action-move'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/move-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
    // The actions sheet must close behind it, or it would sit under the form
    // sheet and be waiting when the user dismisses.
    expect(screen.queryByTestId('task-actions-sheet')).toBeNull();
  });

  it('Edit routes to the edit sheet and saves the changed fields', async () => {
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    fireEvent(screen.getByTestId('board-card-task-1'), 'longPress');
    fireEvent.press(screen.getByTestId('task-action-edit'));
    expect(screen.getByTestId('edit-task-sheet')).toBeTruthy();

    fireEvent.changeText(screen.getByTestId('edit-task-title'), 'Renamed from the phone');
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-task-save'));
    });

    expect(mockUpdateTaskFields).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskId: 'task-1',
      title: 'Renamed from the phone',
    });
  });

  it('Delete requires the two-step confirm then calls the delete action', async () => {
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    fireEvent(screen.getByTestId('board-card-task-1'), 'longPress');
    fireEvent.press(screen.getByTestId('task-action-delete'));
    expect(mockDeleteTaskFromBoard).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.press(screen.getByTestId('task-action-delete-confirm'));
    });

    expect(mockDeleteTaskFromBoard).toHaveBeenCalledWith({ projectId: 'project-1', taskId: 'task-1' });
  });

  /**
   * The create form is a NATIVE form sheet route now, not an inline Modal, so
   * the board's only job is to navigate to it carrying the project. The form's
   * own behaviour is covered by tests/components/CreateTaskScreen.test.tsx.
   */
  it('the FAB navigates to the create-task form sheet with the current project', () => {
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('board-create-task'));

    expect(mockPush).toHaveBeenCalledWith({ pathname: '/create-task', params: { projectId: 'project-1' } });
    // The board must not render the form itself any more - that was the
    // hand-rolled Modal whose Android window laid out one tab-bar-height off
    // the bottom on first open.
    expect(screen.queryByTestId('create-task-title')).toBeNull();
  });

  it('renders named column chips, highlights the tapped one, and states empty columns', () => {
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('board-column-chip-lane-todo').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('board-column-chip-lane-doing').props.accessibilityState).toEqual({ selected: false });

    fireEvent.press(screen.getByTestId('board-column-chip-lane-doing'));
    expect(screen.getByTestId('board-column-chip-lane-doing').props.accessibilityState).toEqual({ selected: true });

    // The empty Doing column states itself instead of blank space.
    expect(screen.getByTestId('board-column-lane-doing-empty')).toBeTruthy();
  });

  it('a pager swipe moves the active chip highlight (swipe -> chip sync)', () => {
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('board-column-chip-lane-todo').props.accessibilityState).toEqual({ selected: true });

    fireEvent(screen.getByTestId('board-list'), 'pageSelected', { nativeEvent: { position: 1 } });

    expect(screen.getByTestId('board-column-chip-lane-doing').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('board-column-chip-lane-todo').props.accessibilityState).toEqual({ selected: false });
  });

  it('resets the active column id (not just the clamped display index) when it disappears, so a later re-add does not re-select it', () => {
    // The chip highlight alone (activeIndex === columnIndex) cannot tell
    // this apart from a naive Math.max(0, ...) clamp with no id reset: both
    // show column 0 the instant the active column vanishes. The two
    // diverge only once the vanished column REAPPEARS - only the id-level
    // reset stays on the fallback column instead of snapping back.
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    fireEvent.press(screen.getByTestId('board-column-chip-lane-doing'));
    expect(screen.getByTestId('board-column-chip-lane-doing').props.accessibilityState).toEqual({ selected: true });

    // Doing disappears from the board entirely (e.g. the desktop deletes
    // the column while the phone is viewing it).
    act(() => {
      useBoardStore.setState((state) => ({
        boardsByProjectId: {
          ...state.boardsByProjectId,
          'project-1': { ...state.boardsByProjectId['project-1'], columns: [column('lane-todo', 'To Do', 0)] },
        },
      }));
    });
    expect(screen.getByTestId('board-column-chip-lane-todo').props.accessibilityState).toEqual({ selected: true });

    // Doing reappears at the same position. A stale activeColumnId would
    // now resolve back to it (its index is real again); the reconciled id
    // ('lane-todo') stays put instead.
    act(() => {
      useBoardStore.setState((state) => ({
        boardsByProjectId: {
          ...state.boardsByProjectId,
          'project-1': {
            ...state.boardsByProjectId['project-1'],
            columns: [column('lane-todo', 'To Do', 0), column('lane-doing', 'Doing', 1)],
          },
        },
      }));
    });
    expect(screen.getByTestId('board-column-chip-lane-todo').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('board-column-chip-lane-doing').props.accessibilityState).toEqual({ selected: false });
  });

  it('the header title switches the active project via the project sheet', () => {
    useBoardStore.setState({
      projects: [
        { id: 'project-1', name: 'Alpha' },
        { id: 'project-2', name: 'Beta' },
      ],
      boardsByProjectId: {
        'project-1': {
          columns: [column('lane-todo', 'To Do', 0)],
          tasksById: {
            'task-1': baseTask('task-1', 'Fix the login bug', 'lane-todo', 0, 'sess-1'),
          },
          snapshotAt: 0,
          showTicketNumbers: true,
          view: 'full',
          taskCountsByColumnId: {},
        },
        'project-2': {
          columns: [column('lane-review', 'Review', 0)],
          tasksById: {
            'task-2': baseTask('task-2', 'Ship the beta banner', 'lane-review', 0, 'sess-2'),
          },
          snapshotAt: 0,
          showTicketNumbers: true,
          view: 'full',
          taskCountsByColumnId: {},
        },
      },
      pendingMoves: [],
    });

    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );

    expect(screen.getByText('Alpha')).toBeTruthy();
    expect(screen.queryByTestId('board-project-sheet')).toBeNull();

    fireEvent.press(screen.getByTestId('board-header-title'));
    expect(screen.getByTestId('board-project-sheet')).toBeTruthy();
    expect(screen.getByTestId('board-project-project-1')).toBeTruthy();
    expect(screen.getByTestId('board-project-project-2')).toBeTruthy();

    fireEvent.press(screen.getByTestId('board-project-project-2'));

    expect(screen.queryByTestId('board-project-sheet')).toBeNull();
    expect(screen.getByTestId('board-column-lane-review')).toBeTruthy();
    expect(screen.getByText('Ship the beta banner')).toBeTruthy();
    expect(screen.queryByText('Fix the login bug')).toBeNull();
  });

  it('shows the disconnected empty state when no boards are cached', () => {
    useBoardStore.setState({ projects: [], boardsByProjectId: {}, pendingMoves: [] });
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    expect(screen.getByText('Connect to your desktop to see the board.')).toBeTruthy();
  });
});
