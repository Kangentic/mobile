import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { BoardScreen } from '@/screens/BoardScreen';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

const mockMoveTaskOptimistic = jest.fn().mockResolvedValue(undefined);
const mockCreateTask = jest.fn().mockResolvedValue(undefined);
const mockUpdateTaskFields = jest.fn().mockResolvedValue(undefined);
const mockDeleteTaskFromBoard = jest.fn().mockResolvedValue(undefined);
const mockArchiveTask = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/actions', () => ({
  moveTaskOptimistic: (input: unknown) => mockMoveTaskOptimistic(input),
  createTask: (input: unknown) => mockCreateTask(input),
  updateTaskFields: (input: unknown) => mockUpdateTaskFields(input),
  deleteTaskFromBoard: (input: unknown) => mockDeleteTaskFromBoard(input),
  archiveTask: (input: unknown) => mockArchiveTask(input),
  refreshSnapshots: jest.fn().mockResolvedValue(undefined),
}));

// The create/edit description fields carry the dictation mic.
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn().mockReturnValue(false),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: false }),
    start: jest.fn(),
    stop: jest.fn(),
  },
  useSpeechRecognitionEvent: jest.fn(),
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
        backlog: [],
        snapshotAt: 0,
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

  it('long-press opens the actions sheet; Move routes to the move sheet and calls the optimistic move', async () => {
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    fireEvent(screen.getByTestId('board-card-task-1'), 'longPress');
    expect(screen.getByTestId('task-actions-sheet')).toBeTruthy();

    fireEvent.press(screen.getByTestId('task-action-move'));
    expect(screen.getByTestId('move-task-sheet')).toBeTruthy();

    fireEvent.press(screen.getByTestId('move-target-lane-doing'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('move-confirm'));
    });

    expect(mockMoveTaskOptimistic).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskId: 'task-1',
      targetSwimlaneId: 'lane-doing',
      targetPosition: 0,
    });
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

  it('the FAB opens the create sheet and confirming calls createTask with the column name', async () => {
    render(
      <ThemeProvider>
        <BoardScreen />
      </ThemeProvider>,
    );
    fireEvent.press(screen.getByTestId('board-create-task'));
    expect(screen.getByTestId('create-task-sheet')).toBeTruthy();

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
