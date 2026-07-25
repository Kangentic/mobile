import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TriageHomeScreen } from '@/screens/TriageHomeScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import { CapabilityError } from '@/channel/verbClient';
import { boardColumnFixture, boardSnapshotFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';
import { peekLastAssistantMessage } from '@/connection/actions';

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
const mockArchiveTask = jest.fn();
const mockDeleteTaskFromBoard = jest.fn();
const mockMoveTaskOptimistic = jest.fn();
const mockUpdateTaskFields = jest.fn();
jest.mock('@/connection/actions', () => ({
  refreshSnapshots: jest.fn().mockResolvedValue(undefined),
  peekAwaitedPrompt: (sessionId: string, promptId: string) => mockPeekAwaitedPrompt(sessionId, promptId),
  peekLastAssistantMessage: jest.fn().mockResolvedValue(null),
  peekLastTerminalLine: jest.fn().mockResolvedValue(null),
  answerPermissionPrompt: jest.fn().mockResolvedValue(undefined),
  archiveTask: (input: unknown) => mockArchiveTask(input),
  deleteTaskFromBoard: (input: unknown) => mockDeleteTaskFromBoard(input),
  moveTaskOptimistic: (input: unknown) => mockMoveTaskOptimistic(input),
  updateTaskFields: (input: unknown) => mockUpdateTaskFields(input),
}));

function seedStores(): void {
  useSettingsStore.setState({ collapsedTriageSection: null });
  useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true });
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    hasHydratedSnapshot: true,
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
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
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

/**
 * Two paired projects, each with its own board - unlike BoardScreen (one
 * screen-level projectId), the Triage feed spans every paired project at
 * once, so every long-press target carries its OWN projectId. Sess-2/task-2
 * lives in project-2, never project-1, so any test that long-presses it and
 * then asserts the action call's `projectId` catches a crossed-project bug
 * (e.g. a screen-level default sneaking back in).
 */
function seedTwoProjectBoards(): void {
  useSettingsStore.setState({ collapsedTriageSection: null });
  useChannelStore.setState({ pairedState: 'paired', transportState: 'connected', established: true });
  useBoardStore.setState({
    projects: [
      { id: 'project-1', name: 'Alpha' },
      { id: 'project-2', name: 'Beta' },
    ],
    hasHydratedSnapshot: true,
    boardsByProjectId: {
      'project-1': {
        columns: [
          boardColumnFixture({ id: 'p1-todo', name: 'To Do', role: 'todo', position: 0 }),
          boardColumnFixture({ id: 'p1-done', name: 'Done', role: 'done', position: 1 }),
        ],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', title: 'Fix the login bug', swimlane_id: 'p1-todo', session_id: 'sess-1' }),
        },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
      'project-2': {
        columns: [
          boardColumnFixture({ id: 'p2-todo', name: 'Backlog', role: 'todo', position: 0 }),
          // Two tasks already parked here so the "append to bottom" position
          // this suite pins is non-zero - a target column count of 0 cannot
          // distinguish a correct `.length` computation from a regressed
          // hardcoded 0.
          boardColumnFixture({ id: 'p2-doing', name: 'In Progress', role: null, position: 1 }),
          boardColumnFixture({ id: 'p2-done', name: 'Shipped', role: 'done', position: 2 }),
        ],
        tasksById: {
          'task-2': boardTaskFixture({ id: 'task-2', title: 'Ship the beta banner', swimlane_id: 'p2-todo', session_id: 'sess-2' }),
          'task-2b': boardTaskFixture({ id: 'task-2b', title: 'Existing card A', swimlane_id: 'p2-doing', position: 0, session_id: null }),
          'task-2c': boardTaskFixture({ id: 'task-2c', title: 'Existing card B', swimlane_id: 'p2-doing', position: 1, session_id: null }),
        },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
    },
    pendingMoves: [],
  });
  useActivityStore.getState().reset();
  useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
  useActivityStore.getState().registerSession('sess-2', 'task-2', 'project-2');
}

describe('TriageHomeScreen', () => {
  beforeEach(() => {
    mockPush.mockClear();
    mockPeekAwaitedPrompt.mockReset();
    mockPeekAwaitedPrompt.mockResolvedValue(null);
    seedStores();
  });

  it('files prompt-pending rows under Idle (the user\'s move) and hides empty sections', () => {
    renderHome();
    // The lone session is prompt-pending: desktop semantics count it in the
    // idle bucket, so its row sits under one Idle header - styled exactly
    // like every other idle row - and the empty Thinking section renders
    // nothing.
    expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
    expect(screen.getAllByText('Idle')).toHaveLength(1);
    expect(screen.queryByText('Thinking')).toBeNull();
    expect(screen.queryByText('Needs you')).toBeNull();
  });

  it('prompt-pending rows carry no inline controls or status filler and route to chat on tap', () => {
    renderHome();
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    // No filler status lines and no inline answering: the section + icon
    // say the state, the snippet teases the decision, and answering lives
    // in the session's own prompt card.
    expect(screen.queryByText('Waiting for your approval')).toBeNull();
    expect(screen.queryByTestId('permission-approve')).toBeNull();
    expect(screen.queryByText('Review and approve')).toBeNull();

    fireEvent.press(screen.getByTestId('activity-row-sess-1'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/task/[taskId]',
      params: { taskId: 'task-1', sessionId: 'sess-1', projectId: 'project-1', mode: 'chat' },
    });
  });

  it('renders board-card parity (project name, no ticket number) and the context-usage bar', () => {
    renderHome();
    // The project name shares the title row as quiet muted text.
    expect(screen.getByTestId('activity-row-sess-1-project')).toBeTruthy();
    expect(screen.getByText('Alpha')).toBeTruthy();
    // No ticket number here: a triage feed cares about status/title/last
    // message/recency, not the ticket ID - the board is that view.
    expect(screen.queryByTestId('activity-row-sess-1-display-id')).toBeNull();
    // No usage yet: the bar stays hidden rather than showing an untrusted 0%.
    expect(screen.queryByTestId('activity-row-sess-1-usage')).toBeNull();

    act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: {
          type: 'usage',
          usage: {
            contextWindow: { usedPercentage: 47, usedTokens: 94000, cacheTokens: 0, totalInputTokens: 94000, totalOutputTokens: 4000, contextWindowSize: 200000 },
            cost: { totalCostUsd: 2.5, totalDurationMs: 120000 },
            model: { id: 'claude-sonnet-5', displayName: 'Sonnet 5' },
          },
        },
      });
    });
    expect(screen.getByTestId('activity-row-sess-1-usage')).toBeTruthy();
    expect(screen.getByText('Sonnet 5')).toBeTruthy();
    expect(screen.getByText('47%')).toBeTruthy();
  });

  it('falls back to a minimal card when a session outlives its board task entry', () => {
    useBoardStore.setState((state) => ({
      boardsByProjectId: { ...state.boardsByProjectId, 'project-1': { ...state.boardsByProjectId['project-1'], tasksById: {} } },
    }));
    renderHome();
    expect(screen.getByText('Untitled task')).toBeTruthy();
    expect(screen.queryByTestId('activity-row-sess-1-display-id')).toBeNull();
  });

  it('reacts to store changes (a session moving sections re-renders)', () => {
    renderHome();
    expect(screen.getAllByText('Idle')).toHaveLength(1);

    act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'activity', state: 'thinking', reason: { kind: 'tool', pendingCount: 1, currentTool: 'Bash' } },
      });
    });
    expect(screen.getAllByText('Thinking')).toHaveLength(1);
    expect(screen.queryByText('Idle')).toBeNull();
  });

  it('tapping the section header collapses its rows (but keeps the header and its count visible), and tapping again re-expands', () => {
    renderHome();
    // needs-you and idle share the "Idle" title; our lone permission-pending
    // session lands in needs-you, so that is the section kind whose header
    // actually gets emitted.
    expect(screen.getByTestId('section-header-needs-you').props.accessibilityState).toEqual({ expanded: true });
    expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
    expect(within(screen.getByTestId('section-header-needs-you')).getByText('1')).toBeTruthy();

    fireEvent.press(screen.getByTestId('section-header-needs-you'));

    expect(screen.getByTestId('section-header-needs-you').props.accessibilityState).toEqual({ expanded: false });
    expect(screen.queryByTestId('activity-row-sess-1')).toBeNull();
    // The count stays visible while collapsed - collapsing hides the rows, not the fact that there are some.
    expect(within(screen.getByTestId('section-header-needs-you')).getByText('1')).toBeTruthy();

    fireEvent.press(screen.getByTestId('section-header-needs-you'));

    expect(screen.getByTestId('section-header-needs-you').props.accessibilityState).toEqual({ expanded: true });
    expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
  });

  it('shows the all-quiet state when connected with no sessions', () => {
    useActivityStore.getState().reset();
    renderHome();
    expect(screen.getByTestId('all-quiet-empty-state')).toBeTruthy();
  });

  it('shows the connecting state (Overseer, not a void) while paired but not established', () => {
    useActivityStore.getState().reset();
    useChannelStore.setState({ established: false, transportState: 'connecting' });
    renderHome();
    expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('all-quiet-empty-state')).toBeNull();
  });

  it('stays on Connecting (not a flash of All quiet) once established but before the first board snapshot lands', () => {
    // The exact bootstrap-ordering window: channel-established flips true
    // before any board snapshot has arrived, so hasHydratedSnapshot is
    // still false even though established is already true.
    useActivityStore.getState().reset();
    useBoardStore.setState({ hasHydratedSnapshot: false });
    renderHome();
    expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('all-quiet-empty-state')).toBeNull();

    act(() => {
      useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-1', columns: [], tasks: [] }));
    });
    expect(screen.getByTestId('all-quiet-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('connecting-empty-state')).toBeNull();
  });

  /**
   * The bootstrap declares EVERY project's board desired and each answers in
   * its own round-trip, so the feed used to paint after the first snapshot
   * and then grow once per remaining project - agents flickering in, the
   * list re-sorting and re-anchoring under the thumb. It now reveals once,
   * when the declared set is complete.
   */
  it('waits for every declared board before revealing the feed', () => {
    useActivityStore.getState().reset();
    useBoardStore.setState({
      projects: [
        { id: 'project-1', name: 'Alpha' },
        { id: 'project-2', name: 'Beta' },
      ],
      boardsByProjectId: {},
      hasHydratedSnapshot: false,
    });
    renderHome();
    expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();

    // First of two boards answers: still incomplete, so nothing is revealed
    // (and in particular no premature "All quiet").
    act(() => {
      useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-1', columns: [], tasks: [] }));
    });
    expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('all-quiet-empty-state')).toBeNull();

    act(() => {
      useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-2', columns: [], tasks: [] }));
    });
    expect(screen.getByTestId('all-quiet-empty-state')).toBeTruthy();
    expect(screen.queryByTestId('connecting-empty-state')).toBeNull();
  });

  /**
   * The agent snippet is a per-session transcript fetch that can take seconds
   * on a long-running session, so the card falls back to the task description
   * that already rode in on the board snapshot. Before this, the feed revealed
   * with every description slot empty and filled them a beat later, which read
   * as a second load.
   */
  it('shows the task description until the agent snippet resolves', async () => {
    useBoardStore.setState((state) => ({
      boardsByProjectId: {
        ...state.boardsByProjectId,
        'project-1': {
          ...state.boardsByProjectId['project-1'],
          tasksById: {
            ...state.boardsByProjectId['project-1'].tasksById,
            'task-1': {
              ...state.boardsByProjectId['project-1'].tasksById['task-1'],
              description: '## Heading\n\nRepro the auth redirect loop.',
            },
          },
        },
      },
    }));

    renderHome();

    // Markdown decoration is collapsed the same way a live snippet is.
    expect(screen.getByText('Heading Repro the auth redirect loop.')).toBeTruthy();
  });

  it('replaces the description with the agent snippet once it lands', async () => {
    // Not `Once`: the screen pre-warms every known session's snippet before
    // the rows mount, so a single-use mock is consumed before render.
    jest.mocked(peekLastAssistantMessage).mockResolvedValue('Fixed the redirect, running tests.');
    // seedStores leaves sess-1 awaiting a prompt, which takes the prompt-peek
    // path instead; clear it so the row peeks the agent's last message.
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'permission', promptId: 'sess-1:tool-1', pending: false },
    });
    useBoardStore.setState((state) => ({
      boardsByProjectId: {
        ...state.boardsByProjectId,
        'project-1': {
          ...state.boardsByProjectId['project-1'],
          tasksById: {
            ...state.boardsByProjectId['project-1'].tasksById,
            'task-1': {
              ...state.boardsByProjectId['project-1'].tasksById['task-1'],
              description: 'Repro the auth redirect loop.',
            },
          },
        },
      },
    }));

    renderHome();

    expect((await screen.findAllByText('Fixed the redirect, running tests.')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Repro the auth redirect loop.')).toBeNull();
    jest.mocked(peekLastAssistantMessage).mockResolvedValue(null);
  });

  /**
   * A 0.8.0+ desktop pushes the preview on the activity feed the app already
   * receives. The row must then render it AND stop fetching its own, which is
   * where the per-session transcript requests (2.3-34.6 KB each) go away.
   */
  it('renders the desktop-pushed preview and fetches no snippet of its own', async () => {
    jest.mocked(peekLastAssistantMessage).mockClear();
    // seedStores leaves sess-1 in the permission state, whose body is the
    // pending decision rather than the preview; move it back to idle.
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'activity', state: 'idle', reason: { kind: 'idle' } },
    });
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'message-preview', text: 'Pushed straight from the desktop.' },
    });

    renderHome();

    expect(screen.getByText('Pushed straight from the desktop.')).toBeTruthy();
    await act(async () => {});
    expect(peekLastAssistantMessage).not.toHaveBeenCalled();
  });

  /**
   * A prompt-pending row's body is the pending DECISION, which the preview
   * does not describe, so that row keeps peeking even when a preview exists.
   */
  it('still peeks for a prompt-pending row despite a pushed preview', async () => {
    jest.mocked(peekLastAssistantMessage).mockClear();
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'message-preview', text: 'Not what this row should show.' },
    });

    renderHome();
    await act(async () => {});

    expect(mockPeekAwaitedPrompt).toHaveBeenCalled();
    expect(screen.queryByText('Not what this row should show.')).toBeNull();
  });

  it('shows the pairing CTA when unpaired', () => {
    useChannelStore.setState({ pairedState: 'unpaired' });
    renderHome();
    expect(screen.getByTestId('triage-pair-cta')).toBeTruthy();
  });

  describe('long-press action hub', () => {
    beforeEach(() => {
      mockArchiveTask.mockReset().mockResolvedValue(undefined);
      mockDeleteTaskFromBoard.mockReset().mockResolvedValue(undefined);
      mockMoveTaskOptimistic.mockReset().mockResolvedValue(undefined);
      mockUpdateTaskFields.mockReset().mockResolvedValue(undefined);
      seedTwoProjectBoards();
    });

    it('opens TaskActionsSheet for the long-pressed row, scoped to that row\'s own project', () => {
      renderHome();
      expect(screen.queryByTestId('task-actions-sheet')).toBeNull();

      // task-2/sess-2 lives in project-2, not project-1.
      fireEvent(screen.getByTestId('activity-row-sess-2'), 'longPress');

      const sheet = screen.getByTestId('task-actions-sheet');
      expect(sheet).toBeTruthy();
      expect(within(sheet).getByText('Ship the beta banner')).toBeTruthy();
      // project-2 has a done-role column, so archive is enabled - proves the
      // sheet used project-2's board, not project-1's (whose done column has
      // a different id and would still resolve true, but a screen-level
      // default of "no project" or "the wrong project" is what this and the
      // action-call assertions below are really pinning).
      expect(screen.getByTestId('task-action-archive').props.accessibilityState.disabled).toBe(false);
    });

    it('Move: routes to the target project\'s own columns and appends to the bottom of the selected column', async () => {
      renderHome();
      fireEvent(screen.getByTestId('activity-row-sess-2'), 'longPress');
      fireEvent.press(screen.getByTestId('task-action-move'));

      expect(screen.getByTestId('move-task-sheet')).toBeTruthy();
      // project-2's columns render; project-1's do not.
      expect(screen.getByTestId('move-target-p2-doing')).toBeTruthy();
      expect(screen.queryByTestId('move-target-p1-todo')).toBeNull();
      expect(screen.queryByTestId('move-target-p1-done')).toBeNull();

      fireEvent.press(screen.getByTestId('move-target-p2-doing'));
      await act(async () => {
        fireEvent.press(screen.getByTestId('move-confirm'));
      });

      // p2-doing already holds task-2b and task-2c: targetPosition must be
      // their count (2), not 0 - the tell for a regressed "always top" bug.
      expect(mockMoveTaskOptimistic).toHaveBeenCalledWith({
        projectId: 'project-2',
        taskId: 'task-2',
        targetSwimlaneId: 'p2-doing',
        targetPosition: 2,
      });
    });

    it('Edit: saves the changed field with the target\'s own project id', async () => {
      renderHome();
      fireEvent(screen.getByTestId('activity-row-sess-2'), 'longPress');
      fireEvent.press(screen.getByTestId('task-action-edit'));

      expect(screen.getByTestId('edit-task-sheet')).toBeTruthy();
      expect(screen.getByTestId('edit-task-title').props.value).toBe('Ship the beta banner');

      fireEvent.changeText(screen.getByTestId('edit-task-title'), 'Ship the beta banner v2');
      await act(async () => {
        fireEvent.press(screen.getByTestId('edit-task-save'));
      });

      expect(mockUpdateTaskFields).toHaveBeenCalledWith({
        projectId: 'project-2',
        taskId: 'task-2',
        title: 'Ship the beta banner v2',
      });
    });

    it('Archive: calls archiveTask with the target\'s own project id and task id', async () => {
      renderHome();
      fireEvent(screen.getByTestId('activity-row-sess-2'), 'longPress');
      await act(async () => {
        fireEvent.press(screen.getByTestId('task-action-archive'));
      });

      expect(mockArchiveTask).toHaveBeenCalledWith({ projectId: 'project-2', taskId: 'task-2' });
    });

    it('Delete: requires the two-step confirm, then calls deleteTaskFromBoard with the target\'s own project id and task id', async () => {
      renderHome();
      fireEvent(screen.getByTestId('activity-row-sess-2'), 'longPress');
      fireEvent.press(screen.getByTestId('task-action-delete'));
      expect(mockDeleteTaskFromBoard).not.toHaveBeenCalled();

      await act(async () => {
        fireEvent.press(screen.getByTestId('task-action-delete-confirm'));
      });

      expect(mockDeleteTaskFromBoard).toHaveBeenCalledWith({ projectId: 'project-2', taskId: 'task-2' });
    });

    it('Move: a CapabilityError surfaces its own message on the move sheet', async () => {
      mockMoveTaskOptimistic.mockRejectedValueOnce(new CapabilityError('move-task', 'The desktop rejected the move'));
      renderHome();
      fireEvent(screen.getByTestId('activity-row-sess-2'), 'longPress');
      fireEvent.press(screen.getByTestId('task-action-move'));
      fireEvent.press(screen.getByTestId('move-target-p2-doing'));

      await act(async () => {
        fireEvent.press(screen.getByTestId('move-confirm'));
      });

      expect(screen.getByText('The desktop rejected the move')).toBeTruthy();
    });

    it('Move: a plain Error falls back to the generic message (narrower than the edit/archive/delete error handling)', async () => {
      mockMoveTaskOptimistic.mockRejectedValueOnce(new Error('some transport blip'));
      renderHome();
      fireEvent(screen.getByTestId('activity-row-sess-2'), 'longPress');
      fireEvent.press(screen.getByTestId('task-action-move'));
      fireEvent.press(screen.getByTestId('move-target-p2-doing'));

      await act(async () => {
        fireEvent.press(screen.getByTestId('move-confirm'));
      });

      expect(screen.getByText('Move failed - check the connection')).toBeTruthy();
      expect(screen.queryByText('some transport blip')).toBeNull();
    });

    it('Archive: a plain Error\'s own message surfaces (unlike Move, the archive/edit/delete path is not narrowed to CapabilityError)', async () => {
      mockArchiveTask.mockRejectedValueOnce(new Error('archive transport blip'));
      renderHome();
      fireEvent(screen.getByTestId('activity-row-sess-2'), 'longPress');

      await act(async () => {
        fireEvent.press(screen.getByTestId('task-action-archive'));
      });

      expect(screen.getByText('archive transport blip')).toBeTruthy();
    });
  });
});
