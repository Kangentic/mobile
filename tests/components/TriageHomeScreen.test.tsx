import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TriageHomeScreen } from '@/screens/TriageHomeScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

jest.mock('@/connection/actions', () => ({
  refreshSnapshots: jest.fn().mockResolvedValue(undefined),
}));

function seedStores(): void {
  useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true });
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [],
        tasksById: {
          'task-1': {
            id: 'task-1',
            display_id: 1,
            title: 'Fix the login bug',
            description: '',
            swimlane_id: 'lane-1',
            position: 0,
            agent: 'claude',
            session_id: 'sess-1',
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
          },
        },
        backlog: [],
        snapshotAt: 0,
      },
    },
    pendingMoves: [],
  });
  useActivityStore.getState().reset();
  useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
  useActivityStore.getState().applyActivityEvent({
    kind: 'activity',
    sessionId: 'sess-1',
    taskId: 'task-1',
    payload: { type: 'permission', promptId: 'sess-1:tool-1', pending: true },
  });
}

describe('TriageHomeScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
    seedStores();
  });

  it('renders the three triage sections', () => {
    render(
      <ThemeProvider>
        <TriageHomeScreen />
      </ThemeProvider>,
    );
    expect(screen.getByText('Needs you')).toBeTruthy();
    expect(screen.getByText('Working')).toBeTruthy();
    expect(screen.getByText('Idle')).toBeTruthy();
  });

  it('renders a needs-you card from live store state and navigates on tap', () => {
    render(
      <ThemeProvider>
        <TriageHomeScreen />
      </ThemeProvider>,
    );
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    expect(screen.getByText('Waiting for your approval')).toBeTruthy();

    fireEvent.press(screen.getByTestId('activity-row-sess-1'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/task/[taskId]',
      params: { taskId: 'task-1', sessionId: 'sess-1', projectId: 'project-1' },
    });
  });

  it('reacts to store changes (a session moving sections re-renders)', () => {
    render(
      <ThemeProvider>
        <TriageHomeScreen />
      </ThemeProvider>,
    );
    expect(screen.getByText('Waiting for your approval')).toBeTruthy();

    act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'activity', state: 'thinking', reason: { kind: 'tool', pendingCount: 1, currentTool: 'Bash' } },
      });
    });
    expect(screen.getByText('Running Bash')).toBeTruthy();
  });

  it('shows the pairing CTA when unpaired', () => {
    useChannelStore.setState({ pairedState: 'unpaired' });
    render(
      <ThemeProvider>
        <TriageHomeScreen />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('triage-pair-cta')).toBeTruthy();
  });
});
