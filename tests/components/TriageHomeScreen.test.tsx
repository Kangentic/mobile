import React from 'react';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { NOW_TICK_MS, ThemeProvider, darkTerminalTheme } from '@/components';
import { SNIPPET_WARM_CONCURRENCY, TriageHomeScreen } from '@/screens/TriageHomeScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import { boardColumnFixture, boardSnapshotFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { peekLastAssistantMessage, peekLastTerminalLine } from '@/connection/actions';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

// The AppHeader reads the status-bar inset.
jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-safe-area-context/jest/mock').default,
);

const mockFlashListScrollToOffset = jest.fn();
// Wraps the REAL FlashList (every other test in this file keeps exercising
// its actual virtualization and layout behavior) and only intercepts
// scrollToOffset on the ref, so the top-anchor test below can assert on it
// without reaching into native scroll-command dispatch.
jest.mock('@shopify/flash-list', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  const ActualFlashListModule = jest.requireActual('@shopify/flash-list');
  const RealFlashList = ActualFlashListModule.FlashList;
  const SpyingFlashList = ReactModule.forwardRef(function SpyingFlashList(
    props: object,
    forwardedRef: React.Ref<{ scrollToOffset: (params: { offset: number; animated?: boolean }) => void }>,
  ) {
    const innerRef = ReactModule.useRef(null);
    ReactModule.useImperativeHandle(forwardedRef, () => ({
      scrollToOffset: (params: { offset: number; animated?: boolean }) => {
        mockFlashListScrollToOffset(params);
        innerRef.current?.scrollToOffset(params);
      },
    }));
    return ReactModule.createElement(RealFlashList, { ...props, ref: innerRef });
  });
  return { ...ActualFlashListModule, FlashList: SpyingFlashList };
});

const mockPeekAwaitedPrompt = jest.fn();
// Only what this screen still calls. The task-mutation actions (archive,
// delete, move, edit) left with the long-press sheets: the feed navigates to
// the actions-hub ROUTE now and performs none of them itself.
jest.mock('@/connection/actions', () => ({
  refreshSnapshots: jest.fn().mockResolvedValue(undefined),
  peekAwaitedPrompt: (sessionId: string, promptId: string) => mockPeekAwaitedPrompt(sessionId, promptId),
  peekLastAssistantMessage: jest.fn().mockResolvedValue(null),
  peekLastTerminalLine: jest.fn().mockResolvedValue(null),
  answerPermissionPrompt: jest.fn().mockResolvedValue(undefined),
}));

// Captures what the screen subscribes, so a test can fire OS memory pressure
// without an AppState round trip. Named `mock*` because a jest.mock factory is
// hoisted above the imports and may not close over anything else.
const mockMemoryPressureListeners = new Set<() => void>();
jest.mock('@/observability/memoryPressure', () => ({
  subscribeToMemoryPressure: (listener: () => void) => {
    mockMemoryPressureListeners.add(listener);
    return () => mockMemoryPressureListeners.delete(listener);
  },
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
            pr_merge_readiness: null,
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
    // Reset here, not just at the end of the tests that override it: a test
    // that throws before its own cleanup line would otherwise leak a stale
    // resolved value into whichever test runs next.
    jest.mocked(peekLastAssistantMessage).mockReset();
    jest.mocked(peekLastAssistantMessage).mockResolvedValue(null);
    jest.mocked(peekLastTerminalLine).mockReset();
    jest.mocked(peekLastTerminalLine).mockResolvedValue(null);
    mockFlashListScrollToOffset.mockClear();
    seedStores();
  });

  /**
   * Every row fires a snippet peek on mount, and its `.then` lands a setState
   * AFTER the synchronous test body has finished - outside act(), which React
   * reports as a console.error per row per test. The assertions are unaffected
   * (the peek is mocked to null and nothing waits on it), but the noise runs to
   * ~190KB a run and buries the output of a test that genuinely fails.
   *
   * Flushing the microtask queue inside act() here lets the LATER updates land
   * where React expects them, but not all of them. Measured over four tests:
   * 11 warnings without this flush, 4 with it. The one left per test is the
   * first peek to settle, which needs only a few microtask turns and lands in
   * the gap between the test body returning and this hook starting, so no
   * afterEach can reach it. Removing it would take renderHome awaiting the
   * flush itself, which makes the ~50 sync call sites async AND resolves every
   * snippet before the first assertion, changing what the pre-resolution tests
   * observe. Left as is deliberately.
   */
  afterEach(async () => {
    await act(async () => {
      await Promise.resolve();
    });
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
    expect(screen.getByTestId('section-header-idle').props.accessibilityState).toEqual({ expanded: true });
    expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
    expect(within(screen.getByTestId('section-header-idle')).getByText('1')).toBeTruthy();

    fireEvent.press(screen.getByTestId('section-header-idle'));

    expect(screen.getByTestId('section-header-idle').props.accessibilityState).toEqual({ expanded: false });
    expect(screen.queryByTestId('activity-row-sess-1')).toBeNull();
    // The count stays visible while collapsed - collapsing hides the rows, not the fact that there are some.
    expect(within(screen.getByTestId('section-header-idle')).getByText('1')).toBeTruthy();

    fireEvent.press(screen.getByTestId('section-header-idle'));

    expect(screen.getByTestId('section-header-idle').props.accessibilityState).toEqual({ expanded: true });
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
   * FEED_REVEAL_DEADLINE_MS is only a FLOOR under a project whose board is
   * slow or never answers - allBoardsAnswered is the normal completion
   * signal. If the deadline fallback regressed (feedReady tied to
   * allBoardsAnswered alone), a board that never answers would strand the
   * feed on "Connecting" forever instead of revealing what it does have.
   */
  it('reveals the feed past the deadline even when a declared board never answers', () => {
    jest.useFakeTimers();
    try {
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

      // project-1 answers; project-2 never does - allBoardsAnswered stays
      // false for the rest of the test.
      act(() => {
        useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-1', columns: [], tasks: [] }));
      });
      expect(screen.getByTestId('connecting-empty-state')).toBeTruthy();

      // FEED_REVEAL_DEADLINE_MS (2500ms): the only other path to feedReady.
      act(() => {
        jest.advanceTimersByTime(2500);
      });

      expect(screen.getByTestId('all-quiet-empty-state')).toBeTruthy();
      expect(screen.queryByTestId('connecting-empty-state')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * SNIPPET_SETTLE_MS (350ms): a burst of unreadCount bumps (an actively
   * working session's engine events land back-to-back) must settle to ONE
   * refetch of the LAST state, not one paint per bump - each bump restarts
   * the settle timer. If the debounce regressed to fetching on every bump,
   * the mid-burst assertion below (no fetch yet) is what catches it; a test
   * that only checked "a fetch eventually happens" would not.
   */
  it('debounces a burst of unreadCount bumps into one refetch after the burst settles', async () => {
    jest.useFakeTimers();
    try {
      jest.mocked(peekLastAssistantMessage).mockClear();
      jest.mocked(peekLastAssistantMessage).mockResolvedValue('Latest.');
      // seedStores leaves sess-1 awaiting a prompt (the prompt-peek path);
      // resolve it so the row peeks the message path this test is pinning.
      act(() => {
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId: 'sess-1',
          taskId: 'task-1',
          payload: { type: 'permission', promptId: 'sess-1:tool-1', pending: false },
        });
      });

      renderHome();
      // The first peek (this row's pre-warm plus its own mount) has no
      // burst to settle and fires immediately - capture that count as the
      // baseline rather than assuming it is exactly one call.
      await act(async () => {});
      const callsAfterMount = jest.mocked(peekLastAssistantMessage).mock.calls.length;
      expect(callsAfterMount).toBeGreaterThan(0);

      for (let bumpIndex = 0; bumpIndex < 4; bumpIndex += 1) {
        await act(async () => {
          useActivityStore.getState().applyActivityEvent({
            kind: 'activity',
            sessionId: 'sess-1',
            taskId: 'task-1',
            payload: { type: 'event', event: { ts: bumpIndex, type: 'tool_start', tool: 'Bash' } },
          });
          jest.advanceTimersByTime(200);
        });
      }
      // Still inside the 350ms settle window of the last bump: nothing has
      // refetched yet, which is the debounce itself, not just its outcome.
      expect(jest.mocked(peekLastAssistantMessage).mock.calls.length).toBe(callsAfterMount);

      await act(async () => {
        jest.advanceTimersByTime(350);
      });

      // The burst settled to exactly ONE additional fetch, not one per bump.
      expect(jest.mocked(peekLastAssistantMessage).mock.calls.length).toBe(callsAfterMount + 1);
    } finally {
      jest.useRealTimers();
      jest.mocked(peekLastAssistantMessage).mockResolvedValue(null);
    }
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

  /**
   * The warm-on-register effect (TriageHomeScreen's own pre-warm, separate
   * from each row's own peek effect) must not re-fetch, over the wire, the
   * exact line a 0.8.0+ desktop already pushed on the activity feed. A
   * session with no preview still needs warming, or its card would arrive
   * blank until its row mounts and peeks for itself.
   */
  it('skips the warm-on-register peek for an idle session with a pushed preview, but still warms one with none', async () => {
    jest.mocked(peekLastAssistantMessage).mockClear();
    useActivityStore.getState().registerSession('sess-idle-no-preview', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-idle-no-preview',
      taskId: 'task-1',
      payload: { type: 'activity', state: 'idle', reason: { kind: 'idle' } },
    });
    useActivityStore.getState().registerSession('sess-idle-with-preview', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-idle-with-preview',
      taskId: 'task-1',
      payload: { type: 'activity', state: 'idle', reason: { kind: 'idle' } },
    });
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-idle-with-preview',
      taskId: 'task-1',
      payload: { type: 'message-preview', text: 'Already pushed by the desktop.' },
    });

    renderHome();
    await act(async () => {});

    expect(peekLastAssistantMessage).toHaveBeenCalledWith('sess-idle-no-preview', 0);
    expect(peekLastAssistantMessage).not.toHaveBeenCalledWith('sess-idle-with-preview', 0);
  });

  /**
   * Body preference: the desktop's pushed preview outranks this row's own
   * transcript peek (cheapest first - the preview already rode in on a feed
   * the app receives). Constructed so BOTH exist and differ: the row peeks
   * its own snippet before any preview exists, the desktop preview then
   * arrives, and the earlier peeked snippet is still held (never cleared on
   * a refetch) - so only the PREFERENCE, not merely which one is present,
   * decides which text renders.
   */
  it('prefers the desktop-pushed preview over an already-resolved fetched snippet', async () => {
    jest.mocked(peekLastAssistantMessage).mockClear();
    jest.mocked(peekLastAssistantMessage).mockResolvedValue('Older fetched snippet.');
    // seedStores leaves sess-1 awaiting a prompt (the prompt-peek path);
    // move it to idle with no preview yet so it peeks its own message first.
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'activity', state: 'idle', reason: { kind: 'idle' } },
    });

    renderHome();
    expect(await screen.findByText('Older fetched snippet.')).toBeTruthy();

    act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'message-preview', text: 'Newer pushed preview.' },
      });
    });

    expect(screen.getByText('Newer pushed preview.')).toBeTruthy();
    expect(screen.queryByText('Older fetched snippet.')).toBeNull();
    jest.mocked(peekLastAssistantMessage).mockResolvedValue(null);
  });

  it('shows the pairing CTA when unpaired', () => {
    useChannelStore.setState({ pairedState: 'unpaired' });
    renderHome();
    expect(screen.getByTestId('triage-pair-cta')).toBeTruthy();
  });

  /**
   * With 8+ agents, FlashList v2's maintainVisibleContentPosition held
   * whatever row it first anchored while higher-priority rows inserted
   * ABOVE it, so the feed opened parked at the bottom - showing the working
   * sessions and hiding the ones waiting on you. The fix re-anchors to the
   * top on every insertion while the user is resting there, and the anchor
   * is derived from the live scroll offset on each onScroll (not a one-way
   * latch that, once tripped, could never resume pinning).
   */
  it('re-anchors the feed to the top on every insertion while resting there, and resumes after scrolling back (not a one-way latch)', async () => {
    renderHome();
    const list = screen.getByTestId('triage-home-list');

    function scrollTo(offsetFromTop: number): void {
      fireEvent.scroll(list, { nativeEvent: { contentOffset: { x: 0, y: offsetFromTop } } });
    }

    // Fresh mount: resting at the top, so a row insertion re-anchors.
    fireEvent(list, 'contentSizeChange', 400, 800);
    expect(mockFlashListScrollToOffset).toHaveBeenCalledTimes(1);
    expect(mockFlashListScrollToOffset).toHaveBeenLastCalledWith({ offset: 0, animated: false });

    // Still within the 8px tolerance: another insertion re-anchors again -
    // this is NOT a one-shot "anchor once on mount" behavior.
    scrollTo(8);
    fireEvent(list, 'contentSizeChange', 400, 900);
    expect(mockFlashListScrollToOffset).toHaveBeenCalledTimes(2);

    // Scrolled past the tolerance: a later insertion must not yank the list
    // back out from under the user.
    scrollTo(400);
    fireEvent(list, 'contentSizeChange', 400, 1000);
    expect(mockFlashListScrollToOffset).toHaveBeenCalledTimes(2);

    // Scrolling back to the top resumes anchoring - proves this reads the
    // live offset each time rather than latching "the user scrolled away"
    // permanently.
    scrollTo(0);
    fireEvent(list, 'contentSizeChange', 400, 1100);
    expect(mockFlashListScrollToOffset).toHaveBeenCalledTimes(3);

    // The lone row is prompt-pending, which kicks off an async snippet peek;
    // let it settle so it does not bleed into the next test.
    await act(async () => {});
  });

  /**
   * The Sentry MOBILE-8 regression: the feed used to pre-warm one snippet per
   * KNOWN session with a bare unawaited `for` loop, so a user with many live
   * agents issued a transcript-window fetch per session simultaneously. Those
   * entries carry full tool inputs and results and are bounded only by the
   * protocol's PER-FRAME decoded cap - no aggregate bound exists - and nothing
   * on this screen retains the result, so it never looked like a leak. It was
   * peak simultaneous TRANSIENT allocation scaling with fleet size, which is
   * what a foreground out-of-memory kill actually looks like.
   *
   * Isolation matters here: the Thinking section is collapsed so no rows
   * render, which removes the per-row peek and leaves the pre-warm as the only
   * caller. Without that, a row's own fetch would be indistinguishable from a
   * pre-warm in the call count.
   */
  describe('snippet pre-warm is bounded', () => {
    const workingSessionIds = Array.from({ length: 12 }, (_, index) => `warm-sess-${index}`);

    function seedManyWorkingSessions(): void {
      useSettingsStore.setState({ collapsedTriageSection: 'Thinking' });
      useActivityStore.getState().reset();
      for (const sessionId of workingSessionIds) {
        useActivityStore.getState().registerSession(sessionId, `task-${sessionId}`, 'project-1');
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId,
          taskId: `task-${sessionId}`,
          payload: { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } },
        });
      }
    }

    it('runs at most a fixed number of warms at once, not one per session', async () => {
      seedManyWorkingSessions();
      // Never settles, so every started warm stays in flight and the call
      // count IS the concurrency.
      jest.mocked(peekLastAssistantMessage).mockReturnValue(new Promise<string | null>(() => undefined));

      renderHome();
      await act(async () => {});

      // Exactly the queue depth, not merely "fewer than twelve": all twelve
      // sessions are registered before the render, so the effect runs once and
      // nothing ever resolves to free a slot. Asserting the exact value is
      // what makes a later drift from 3 to 10 fail here.
      expect(jest.mocked(peekLastAssistantMessage)).toHaveBeenCalledTimes(SNIPPET_WARM_CONCURRENCY);
      expect(SNIPPET_WARM_CONCURRENCY).toBeLessThan(workingSessionIds.length);
    });

    it('does not escalate a warm to a full PTY scrollback', async () => {
      seedManyWorkingSessions();
      // No assistant text in the window: the old pre-warm took the terminal
      // fallback here, which subscribes with `terminal: true` for a FULL
      // scrollback and then makes a second round trip to undo it - per
      // session, concurrently, at cold start.
      jest.mocked(peekLastAssistantMessage).mockResolvedValue(null);

      renderHome();
      await act(async () => {});

      expect(jest.mocked(peekLastTerminalLine)).not.toHaveBeenCalled();
    });

    /**
     * The other half of the test above, and the one that keeps the bound from
     * quietly costing a feature. Dropping the fallback from the PRE-WARM defers
     * a transcript-less agent's snippet; it must not lose it. Since the pre-warm
     * cannot reach `peekLastTerminalLine` at all now (previous test), any call
     * here is the mounted row's own peek - so this asserts the mechanism rather
     * than the rendered text, which would be identical either way once it
     * arrives.
     */
    it('still takes the fallback for a mounted row, so a transcript-less agent keeps its snippet', async () => {
      // The seeded session is prompt-pending, which peeks the prompt instead.
      // A working session is the one that reaches the message/terminal path.
      useActivityStore.getState().reset();
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } },
      });
      jest.mocked(peekLastAssistantMessage).mockResolvedValue(null);

      renderHome();
      await act(async () => {});

      expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
      expect(jest.mocked(peekLastTerminalLine)).toHaveBeenCalledWith('sess-1', expect.any(Number));
    });

    /**
     * The screen drops its queued warms when the OS reports memory pressure.
     * Nothing renders differently either way, so this asserts the mechanism:
     * let the in-flight warms finish AFTER the pressure signal and check the
     * queue did not refill from its backlog. Without the subscription the three
     * finishing warms pull three more in, so the count moves - which is what
     * makes deleting that one line fail here rather than silently.
     */
    it('drops queued warms when the OS reports memory pressure', async () => {
      seedManyWorkingSessions();
      const pendingWarmResolvers: ((value: string | null) => void)[] = [];
      jest.mocked(peekLastAssistantMessage).mockImplementation(
        () =>
          new Promise<string | null>((resolve) => {
            pendingWarmResolvers.push(resolve);
          }),
      );

      renderHome();
      await act(async () => {});
      expect(jest.mocked(peekLastAssistantMessage)).toHaveBeenCalledTimes(SNIPPET_WARM_CONCURRENCY);
      expect(mockMemoryPressureListeners.size).toBeGreaterThan(0);

      act(() => {
        for (const listener of [...mockMemoryPressureListeners]) listener();
      });
      await act(async () => {
        for (const resolve of pendingWarmResolvers) resolve(null);
      });

      // Still the original three: the backlog was discarded, not merely paused.
      expect(jest.mocked(peekLastAssistantMessage)).toHaveBeenCalledTimes(SNIPPET_WARM_CONCURRENCY);
    });
  });

  describe('long-press action hub', () => {
    beforeEach(() => {
      seedTwoProjectBoards();
    });

    /**
     * The hub is a native form sheet ROUTE now, so all this screen does is
     * navigate. What still matters HERE - and is the whole reason this feed
     * differs from the board - is that it hands over the ROW'S OWN project:
     * the feed spans every paired project at once, so a screen-level default
     * would open the hub against the wrong board (wrong columns to move into,
     * wrong answer for whether archive is even possible).
     *
     * The hub's own behaviour (replace-not-push, the archive gate, the
     * two-step delete, failure messages) is in
     * tests/components/TaskActionsScreen.test.tsx.
     */
    it("long-press navigates to the actions hub with the row's own project", () => {
      renderHome();

      // task-2/sess-2 lives in project-2, not project-1.
      fireEvent(screen.getByTestId('activity-row-sess-2'), 'longPress');

      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/task-actions',
        params: { taskId: 'task-2', projectId: 'project-2' },
      });
      expect(screen.queryByTestId('task-actions-sheet')).toBeNull();
    });
  });

  /**
   * The elapsed-wait label, asserted through the WHOLE composition rather than
   * on WaitLabel alone.
   *
   * This is the assembly WaitLabel.test.tsx cannot reach: the clock lives in a
   * provider wrapping the list, the row between it and the label is
   * `React.memo` with props that do not change on a tick, and FlashList
   * recycles the row instances. The label updating here is what proves the
   * context reaches a memoized, recycled row at all - a prop-drilled
   * implementation would render once and then freeze, and every WaitLabel test
   * would still pass.
   */
  describe('elapsed wait time', () => {
    const MINUTE = 60_000;

    function seedWaitingSession(waitedMs: number): void {
      seedStores();
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({
          activity: { state: 'idle', reason: { kind: 'idle', since: Date.now() - waitedMs } },
        }));
    }

    afterEach(() => {
      jest.useRealTimers();
    });

    it('shows the wait on the row and advances it on the shared clock', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-13T12:00:00Z'));
      seedWaitingSession(12 * MINUTE);
      renderHome();

      expect(screen.getByTestId('activity-row-sess-1-wait')).toHaveTextContent('12m');

      act(() => {
        jest.advanceTimersByTime(NOW_TICK_MS * 2);
      });

      expect(screen.getByTestId('activity-row-sess-1-wait')).toHaveTextContent('13m');
    });

    it('shows nothing on a working row', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-13T12:00:00Z'));
      seedStores();
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({
          activity: { state: 'thinking', reason: { kind: 'turn-active' } },
        }));
      renderHome();

      expect(screen.queryByTestId('activity-row-sess-1-wait')).toBeNull();
    });

    /**
     * `<NowTickProvider enabled={anySessionWaiting}>` is the one line that
     * decides whether the whole feed pays for a 30s timer. The test above
     * ('shows nothing on a working row') cannot catch a hardcoded
     * `enabled={true}`: a working row passes `waitingSinceMs={null}`, so
     * `WaitLabel` never mounts and never asks the provider for anything -
     * the provider could be running a timer nobody reads and that test would
     * still pass. This asserts the provider itself, through `setInterval`,
     * which fires regardless of whether any row happens to render a label.
     *
     * The `setInterval` spy must be installed AFTER `jest.useFakeTimers()`
     * (fake timers replace the global), and the positive arm right below is
     * not decoration - it is what proves the spy is actually wired to catch a
     * real NOW_TICK_MS interval, rather than merely never seeing one because
     * it never would.
     */
    it('starts no 30s clock when every session is working (enabled={anySessionWaiting} pinned false)', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-13T12:00:00Z'));
      seedStores();
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({
          activity: { state: 'thinking', reason: { kind: 'turn-active' } },
        }));
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      renderHome();

      // Confirms the list (and so the NowTickProvider wrapping it) actually
      // rendered, rather than this passing because an empty/connecting state
      // short-circuited before the provider ever mounted.
      expect(screen.getByTestId('triage-home-list')).toBeTruthy();
      const nowTickIntervalCalls = setIntervalSpy.mock.calls.filter(
        (callArguments) => callArguments[1] === NOW_TICK_MS,
      );
      expect(nowTickIntervalCalls).toHaveLength(0);
      setIntervalSpy.mockRestore();
    });

    it('starts the 30s clock when at least one session is idle (enabled={anySessionWaiting} pinned true)', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-09-13T12:00:00Z'));
      seedWaitingSession(12 * MINUTE);
      const setIntervalSpy = jest.spyOn(global, 'setInterval');

      renderHome();

      expect(screen.getByTestId('activity-row-sess-1-wait')).toBeTruthy();
      const nowTickIntervalCalls = setIntervalSpy.mock.calls.filter(
        (callArguments) => callArguments[1] === NOW_TICK_MS,
      );
      expect(nowTickIntervalCalls.length).toBeGreaterThan(0);
      setIntervalSpy.mockRestore();
    });
  });

  /**
   * The section-landing pulse, asserted on whether the overlay is MOUNTED rather
   * than on its opacity.
   *
   * The overlay used to be mounted on every row for good, cleared only by
   * Reanimated writes, and on 2026-10-05 an iOS card kept its first write (alpha
   * 0.16, measured from the screenshot) until the app was force-killed. Jest's
   * Reanimated mock never advances a tween either, so these tests run in exactly
   * that state: only the JS-timer unmount can take the tint down. The mechanism
   * (no mapper outside the window, the timer's own cleanup) is asserted on the
   * isolated component in SectionLandingPulse.test.tsx, since every card's
   * PressScale also calls useAnimatedStyle and a spy here could not tell them
   * apart.
   */
  describe('section-landing pulse', () => {
    const pulseTestId = 'activity-row-sess-1-pulse';
    const { windowMs: SECTION_PULSE_WINDOW_MS, durationMs, unmountMarginMs } = darkTerminalTheme.motion.sectionPulse;
    const SECTION_PULSE_MOUNT_MS = durationMs + unmountMarginMs;

    const pushThinking = (): void => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'activity', state: 'thinking', reason: { kind: 'tool', pendingCount: 1, currentTool: 'Bash' } },
      });
    };

    beforeEach(() => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-10-05T10:29:00Z'));
      // Re-seeded under the fake clock: the outer beforeEach ran on the real
      // one, and the seed's permission event IS a section change, so it is
      // what stamps sectionChangedAt.
      seedStores();
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('mounts no overlay on a row whose section change is older than the window', () => {
      expect(useActivityStore.getState().bySessionId['sess-1'].sectionChangedAt).toBe(Date.now());
      jest.advanceTimersByTime(SECTION_PULSE_WINDOW_MS);
      renderHome();

      expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
      expect(screen.queryByTestId(pulseTestId)).toBeNull();
    });

    it('mounts no overlay on a row that has never changed section', () => {
      useActivityStore.getState().reset();
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      expect(useActivityStore.getState().bySessionId['sess-1'].sectionChangedAt).toBeNull();
      renderHome();

      expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
      expect(screen.queryByTestId(pulseTestId)).toBeNull();
    });

    it('unmounts the pulse on a JS timer, with no fade frame ever arriving', () => {
      renderHome();
      expect(screen.getByTestId(pulseTestId)).toBeTruthy();

      act(() => {
        jest.advanceTimersByTime(SECTION_PULSE_MOUNT_MS - 1);
      });
      expect(screen.getByTestId(pulseTestId)).toBeTruthy();

      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(screen.queryByTestId(pulseTestId)).toBeNull();
      expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
    });

    it('pulses again when the row changes section after the last pulse ended', () => {
      renderHome();
      act(() => {
        jest.advanceTimersByTime(SECTION_PULSE_MOUNT_MS);
      });
      expect(screen.queryByTestId(pulseTestId)).toBeNull();

      act(() => {
        pushThinking();
      });
      expect(screen.getByTestId(pulseTestId)).toBeTruthy();
    });

    /**
     * A second change mid-pulse must restart the bound, not inherit the first
     * one's deadline: the overlay is keyed by the change instant, so the new
     * change mounts a fresh gate with its own timer.
     */
    it('restarts the bound when a second change lands mid-pulse', () => {
      renderHome();
      const firstChangeDelayMs = Math.floor(SECTION_PULSE_MOUNT_MS / 2);
      act(() => {
        jest.advanceTimersByTime(firstChangeDelayMs);
      });
      act(() => {
        pushThinking();
      });

      // Past the FIRST pulse's deadline, inside the second one's.
      act(() => {
        jest.advanceTimersByTime(SECTION_PULSE_MOUNT_MS - 1);
      });
      expect(screen.getByTestId(pulseTestId)).toBeTruthy();

      act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(screen.queryByTestId(pulseTestId)).toBeNull();
    });

    /**
     * An event that leaves the section alone must not bring a finished pulse
     * back. The mount is shorter than the window, so for the stretch between the
     * two the row can still be "recent" by the clock, and a working row gets an
     * engine event every few hundred ms (each one replaces the entry object and
     * bumps lastEventAt and unreadCount). A key that tracked any of that would
     * remount the overlay at full strength on every event, the fresh gate would
     * read the clock inside the window, and the card would flash for the whole
     * window. The key is the session and the change instant and nothing else.
     */
    it('stays down when a same-section event lands after the pulse ended but inside the window', () => {
      // The premise: a gap between the end of the mount and the end of the window.
      expect(SECTION_PULSE_MOUNT_MS).toBeLessThan(SECTION_PULSE_WINDOW_MS);
      renderHome();
      act(() => {
        jest.advanceTimersByTime(SECTION_PULSE_MOUNT_MS);
      });
      expect(screen.queryByTestId(pulseTestId)).toBeNull();
      const entryBeforeEvent = useActivityStore.getState().bySessionId['sess-1'];

      act(() => {
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId: 'sess-1',
          taskId: 'task-1',
          payload: { type: 'event', event: { ts: 1, type: 'tool_start', tool: 'Bash' } },
        });
      });

      // Preconditions: it was a real, same-section event, still inside the window.
      const entryAfterEvent = useActivityStore.getState().bySessionId['sess-1'];
      expect(entryAfterEvent).not.toBe(entryBeforeEvent);
      expect(entryAfterEvent.unreadCount).toBe(entryBeforeEvent.unreadCount + 1);
      expect(entryAfterEvent.lastEventAt).toBeGreaterThan(entryBeforeEvent.lastEventAt);
      expect(entryAfterEvent.sectionChangedAt).toBe(entryBeforeEvent.sectionChangedAt);
      expect(Date.now() - (entryAfterEvent.sectionChangedAt ?? 0)).toBeLessThan(SECTION_PULSE_WINDOW_MS);

      expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
      expect(screen.queryByTestId(pulseTestId)).toBeNull();
    });

    /**
     * The SESSION half of the overlay key. FlashList hands a cell whose item
     * changed (same index, same item type) to the next item, so the row's
     * ActivityRow instance survives the rebind and only its props change. A key
     * of the stamp alone would then be unchanged when two sessions share a
     * stamp (one event burst stamps several in the same millisecond), the gate
     * would keep its state, and sess-2 would inherit sess-1's live tint.
     *
     * The swap is ONE store write so the list never empties (an empty list
     * unmounts the FlashList and remounts every row, which would pass against
     * the stamp-only key too), and it lands after the stamp is stale: the
     * rebind's fresh gate reads the clock past the window, while the survivor
     * is still inside its own mount.
     */
    it('remounts the pulse when a recycled cell rebinds to another session with the same stamp', () => {
      const sharedStampMs = Date.now();
      const firstSessionEntry = useActivityStore.getState().bySessionId['sess-1'];
      expect(firstSessionEntry.sectionChangedAt).toBe(sharedStampMs);

      // First render 100 ms inside the window, rebind 100 ms past it. The
      // survivor's timer (armed at the first render) must still be running at
      // the rebind, or "no overlay" below would prove the timer, not the key.
      const firstRenderAgeMs = SECTION_PULSE_WINDOW_MS - 100;
      const rebindAgeMs = SECTION_PULSE_WINDOW_MS + 100;
      expect(rebindAgeMs).toBeLessThan(firstRenderAgeMs + SECTION_PULSE_MOUNT_MS);

      act(() => {
        jest.advanceTimersByTime(firstRenderAgeMs);
      });
      renderHome();
      expect(screen.getByTestId(pulseTestId)).toBeTruthy();

      act(() => {
        jest.advanceTimersByTime(rebindAgeMs - firstRenderAgeMs);
      });
      expect(screen.getByTestId(pulseTestId)).toBeTruthy();

      act(() => {
        useActivityStore.setState({
          bySessionId: { 'sess-2': { ...firstSessionEntry, sessionId: 'sess-2', taskId: 'task-2' } },
        });
      });

      // The swap landed: the same slot now shows sess-2, and sess-1 is gone.
      expect(screen.getByTestId('activity-row-sess-2')).toBeTruthy();
      expect(screen.queryByTestId('activity-row-sess-1')).toBeNull();
      expect(screen.queryByTestId('activity-row-sess-2-pulse')).toBeNull();
    });
  });

  /**
   * The two transitional states, on the surface that used to hide both.
   *
   * A respawn made the row DISAPPEAR for several seconds; a queued session
   * rendered as an ordinary finished-work idle row. Both are task-keyed facts,
   * and neither is expressible through `sectionForEntry`, which reads only
   * `entry.state`.
   */
  describe('transitional states (respawning and queued)', () => {
    /**
     * The desktop's end push for the seeded task-1/sess-1 pair: labelled (a
     * model switch), or not (the column-move swap, or a park).
     */
    const pushRespawnEnded = (label: string | null = 'Switching model...'): void => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload:
          label === null
            ? { type: 'session-ended', intentional: true }
            : { type: 'session-ended', intentional: true, spawnProgressLabel: label },
      });
    };

    /**
     * NOTHING NEW TO READ during a swap: the row keeps the body it had and only
     * the glyph changes, whatever the desktop sent. The label once replaced
     * the body here ("Switching model...", or "Starting a new session" for a
     * rejected one), which was text appearing and vanishing inside a
     * two-second gap. The body is seeded as a pushed preview so "unchanged" is
     * an exact string, and the row is idle so that preview is what it shows.
     *
     * Whether the row SURVIVES the gap is decided by
     * reconcileSessionsFromBoards, which no board snapshot drives here - the
     * surviving row is not evidence of retention. That half lives in
     * tests/unit/storeFeedRespawnRetention.test.ts. For the unlabelled arm the
     * glyph assertion is the load-bearing one: the text assertions pass
     * against the old label-only store too, since it recorded nothing.
     */
    it.each([
      ['a labelled end', 'Switching model...'],
      ['an over-cap labelled end', 'x'.repeat(200)],
      ['an unlabelled end', null],
    ])('keeps the body it had and adds nothing to read on %s', async (_kind, label) => {
      useActivityStore
        .getState()
        .applySnapshot(
          'sess-1',
          'task-1',
          'project-1',
          streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'running' }),
        );
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'message-preview', text: 'Summary written to the task notes.' },
      });
      renderHome();
      await act(async () => {});
      expect(screen.getByText('Summary written to the task notes.')).toBeTruthy();

      act(() => {
        pushRespawnEnded(label);
      });

      expect(screen.getByText('Summary written to the task notes.')).toBeTruthy();
      if (label !== null) expect(screen.queryByText(label)).toBeNull();
      expect(screen.queryByText('Starting a new session')).toBeNull();
      expect(screen.queryByText('Waiting for a free slot')).toBeNull();
      expect(screen.getByTestId('activity-row-sess-1-status').props.color).toBe(darkTerminalTheme.colors.statusIdle);
    });

    /**
     * A retained ghost's session is gone desktop-side - the read-stream
     * subscription was torn down before the `session-ended` push - so a peek
     * for it can only fail, and on failure the row arms a retry. Left
     * unskipped, every respawn would spend the gap retry-looping against a
     * dead session id for a snippet the caption has already replaced.
     *
     * Asserted as "no call at all" rather than through rendered output,
     * because a failed peek renders exactly like a skipped one: the body shows
     * the caption either way, so only the call count separates them.
     *
     * Two details make this non-vacuous, and both were found by watching an
     * earlier version PASS against the unguarded effect:
     *
     * 1. BOTH peeks are asserted. `peekSnippet` branches on `isPermission`,
     *    and this file's seed leaves sess-1 prompt-pending - a `session-ended`
     *    does not clear `state` - so the row takes the PROMPT branch and never
     *    reaches `peekLastAssistantMessage` at all.
     * 2. The respawn is pushed BEFORE the render. Re-running the effect on an
     *    already-mounted row takes the settle-timer path (the row has resolved
     *    a peek once, so a burst is debounced), which no microtask flush ever
     *    fires - so a post-mount push cannot tell a skipped peek from a
     *    merely-deferred one. At mount the first peek fires synchronously.
     */
    it.each([
      ['a labelled end', 'Switching model...'],
      ['an unlabelled end', null],
    ])('fetches no snippet for a row between sessions (%s), whose session is already gone', async (_kind, label) => {
      pushRespawnEnded(label);
      jest.mocked(peekLastAssistantMessage).mockClear();
      mockPeekAwaitedPrompt.mockClear();

      renderHome();
      await act(async () => {});

      expect(mockPeekAwaitedPrompt).not.toHaveBeenCalled();
      expect(jest.mocked(peekLastAssistantMessage)).not.toHaveBeenCalled();
    });

    /**
     * The queued row. Its entry is idle and live - nothing about its STATE
     * distinguishes it from an agent that finished its work, which is exactly
     * why it was invisible. The caption is the only thing that separates them,
     * and it is driven by `sessionStatus` alone.
     */
    it('captions a queued session instead of letting it read as finished work', async () => {
      useActivityStore
        .getState()
        .applySnapshot(
          'sess-1',
          'task-1',
          'project-1',
          streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'queued' }),
        );

      renderHome();
      await act(async () => {});

      expect(screen.getByTestId('activity-row-sess-1')).toBeTruthy();
      expect(screen.getByText('Waiting for a free slot')).toBeTruthy();
    });

    /**
     * The control that keeps the test above honest: the SAME idle entry
     * without the queued status must show its ordinary snippet, so the caption
     * cannot be coming from the idle state itself.
     */
    it('leaves an ordinary idle row captioned by its snippet, not by the queue line', async () => {
      jest.mocked(peekLastAssistantMessage).mockResolvedValue('Summary written to the task notes.');
      useActivityStore
        .getState()
        .applySnapshot(
          'sess-1',
          'task-1',
          'project-1',
          streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'running' }),
        );

      renderHome();
      await act(async () => {});

      expect(screen.getByText('Summary written to the task notes.')).toBeTruthy();
      expect(screen.queryByText('Waiting for a free slot')).toBeNull();
    });

    /**
     * The queued caption is derived as "starting for a reason that is not a
     * swap", not by re-reading `sessionStatus` at the call site. A queued
     * session cancelled out of the queue keeps its stale 'queued' status (the
     * store's retirement excludes session-ended on purpose), so a call site
     * reading the status directly would keep captioning a session that is
     * over. What makes this non-vacuous: the glyph still says starting.
     */
    it('drops the queue caption once a queued session ends, while the glyph still says starting', async () => {
      useActivityStore
        .getState()
        .applySnapshot(
          'sess-1',
          'task-1',
          'project-1',
          streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'queued' }),
        );
      renderHome();
      await act(async () => {});
      expect(screen.getByText('Waiting for a free slot')).toBeTruthy();

      act(() => {
        pushRespawnEnded(null);
      });

      expect(screen.queryByText('Waiting for a free slot')).toBeNull();
      expect(screen.getByTestId('activity-row-sess-1-status').props.color).toBe(darkTerminalTheme.colors.statusIdle);
    });
  });
});
