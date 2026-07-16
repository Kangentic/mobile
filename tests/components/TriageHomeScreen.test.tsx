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

// The AppHeader reads the status-bar inset.
jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-safe-area-context/jest/mock').default,
);

const mockPeekAwaitedPrompt = jest.fn();
jest.mock('@/connection/actions', () => ({
  refreshSnapshots: jest.fn().mockResolvedValue(undefined),
  peekAwaitedPrompt: (sessionId: string, promptId: string) => mockPeekAwaitedPrompt(sessionId, promptId),
  answerPermissionPrompt: jest.fn().mockResolvedValue(undefined),
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

function renderHome(): void {
  render(
    <ThemeProvider>
      <TriageHomeScreen />
    </ThemeProvider>,
  );
}

describe('TriageHomeScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockPeekAwaitedPrompt.mockReset();
    mockPeekAwaitedPrompt.mockResolvedValue(null);
    seedStores();
  });

  it('renders prompt cards headerless on top and no empty section headers', () => {
    renderHome();
    // The lone session is prompt-pending: its card renders with NO section
    // header (the amber card treatment is the header), and the empty
    // Thinking/Idle sections render nothing.
    expect(screen.getByTestId('needs-you-card-sess-1')).toBeTruthy();
    expect(screen.queryByText('Thinking')).toBeNull();
    expect(screen.queryByText('Needs you')).toBeNull();
    expect(screen.queryByText('Idle')).toBeNull();
  });

  it('renders a needs-you summary card (no inline controls) and routes to chat on tap', async () => {
    renderHome();
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    expect(await screen.findByText('Waiting for your approval')).toBeTruthy();
    // The card TEASES the decision; answering lives in the session's own
    // prompt card, so Home never shows approve/deny.
    expect(screen.queryByTestId('permission-approve')).toBeNull();
    expect(screen.getByText('Review and approve')).toBeTruthy();

    fireEvent.press(screen.getByTestId('needs-you-card-sess-1'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/task/[taskId]',
      params: { taskId: 'task-1', sessionId: 'sess-1', projectId: 'project-1', mode: 'chat' },
    });
  });

  it('reacts to store changes (a session moving sections re-renders)', () => {
    renderHome();
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
    expect(screen.getAllByText('Thinking')).toHaveLength(1);
  });

  it('shows the all-quiet state when connected with no sessions', () => {
    useActivityStore.getState().reset();
    renderHome();
    expect(screen.getByTestId('all-quiet-empty-state')).toBeTruthy();
  });

  it('shows the pairing CTA when unpaired', () => {
    useChannelStore.setState({ pairedState: 'unpaired' });
    renderHome();
    expect(screen.getByTestId('triage-pair-cta')).toBeTruthy();
  });
});
