import React from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ActivityEventPayload } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { SESSION_SWAP_QUIET_MS, SessionScreen } from '@/screens/task/SessionScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useTerminalUiStore } from '@/state/terminalUiStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { boardColumnFixture, boardTaskFixture, userEntryFixture } from '@/devsupport/desktopFixtures';
import { closeSessionScreen, loadArchivedTasks, openSessionScreen } from '@/connection/actions';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

let mockParams: { taskId: string; sessionId?: string; projectId?: string; mode?: string } = { taskId: 'task-1' };
const mockPush = jest.fn();
const mockReplace = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: mockReplace, back: jest.fn(), push: mockPush }),
  // The real one throws outside a navigator. Everything mounted here is
  // focused for its whole life, so a plain effect is the faithful stand-in.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
}));

jest.mock('@/connection/actions', () => ({
  openSessionScreen: jest.fn(),
  closeSessionScreen: jest.fn(),
  moveTaskOptimistic: jest.fn().mockResolvedValue(undefined),
  // Resolves without writing anything: these tests seed archivedByProjectId
  // directly, so the fetch is a no-op and the screen's routing is driven by
  // the store read, which is the coupling worth pinning.
  loadArchivedTasks: jest.fn().mockResolvedValue(undefined),
  // Only reached once the Changes pane goes ACTIVE, which no test did until
  // the View-changes escape hatch below.
  setDiffWatch: jest.fn(),
}));

// The panes and the input bar are heavy (FlashList transcript, xterm
// WebView, composer with dictation); this test is about SESSION BINDING and
// MODE state, so each becomes a light marker that records its props.
jest.mock('@/screens/task/ChatPane', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    ChatPane: (props: { sessionId: string | null }) =>
      ReactModule.createElement(View, { testID: 'stub-chat-pane', accessibilityLabel: props.sessionId ?? 'none' }),
  };
});

jest.mock('@/screens/task/TerminalTab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    // accessibilityState.selected carries cleanFeedEnabled: selectChatLens is
    // the ONE answer both this screen and ChatPane read, so this mock exposes
    // exactly what SessionScreen forwards rather than ignoring it.
    TerminalTab: (props: { sessionId: string | null; cleanFeedEnabled?: boolean }) =>
      ReactModule.createElement(View, {
        testID: 'stub-terminal-tab',
        accessibilityLabel: props.sessionId ?? 'none',
        accessibilityState: { selected: props.cleanFeedEnabled === true },
      }),
  };
});

jest.mock('@/screens/task/SessionInputBar', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { Pressable, View } = require('react-native');
  return {
    __esModule: true,
    // The Pressable children are additive: the outer View keeps the same
    // testID and accessibilityLabel every other test in this suite reads
    // (plus `accessibilityState.disabled` carrying `suspended`, the footer's
    // inert-while-held flag), and this is the only stub in the suite that
    // needs a way between modes - the overlay round-trip tests press these to
    // prove showSwitchingState / showEndedState / showQuietVeil are a pure
    // DERIVATION of mode, not a one-way latch.
    SessionInputBar: (props: {
      sessionId: string | null;
      mode: string;
      onModeChange: (mode: string) => void;
      suspended?: boolean;
    }) =>
      props.sessionId === null
        ? null
        : ReactModule.createElement(
            View,
            {
              testID: 'stub-session-input-bar',
              accessibilityLabel: props.mode,
              accessibilityState: { disabled: props.suspended === true },
            },
            ReactModule.createElement(Pressable, {
              testID: 'session-mode-terminal',
              onPress: () => props.onModeChange('terminal'),
            }),
            ReactModule.createElement(Pressable, {
              testID: 'session-mode-changes',
              onPress: () => props.onModeChange('changes'),
            }),
          ),
  };
});

const openSessionScreenMock = openSessionScreen as jest.Mock;
const closeSessionScreenMock = closeSessionScreen as jest.Mock;
const loadArchivedTasksMock = loadArchivedTasks as jest.Mock;

function seedTaskWithSession(sessionId: string | null): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture(), boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 })],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', session_id: sessionId }),
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

/**
 * The board a `view: 'sessions'` projection returns once the task's session
 * ended: the task is not reported with a null session_id, it is absent.
 */
function seedBoardWithoutTask(): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture()],
        tasksById: {},
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'sessions',
        taskCountsByColumnId: { 'lane-todo': 0 },
      },
    },
    pendingMoves: [],
  });
}

/** Pushes a `session-ended`, optionally carrying `spawnProgressLabel` (protocol 0.14.0+, kangentic board #639). */
function pushSessionEnded(sessionId: string, options: { spawnProgressLabel?: string } = {}): void {
  const payload: ActivityEventPayload = {
    type: 'session-ended',
    intentional: true,
    ...options,
  };
  useActivityStore.getState().applyActivityEvent({
    kind: 'activity',
    sessionId,
    taskId: 'task-1',
    payload,
  });
}

function renderSessionScreen(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <SessionScreen />
    </ThemeProvider>,
  );
}

/**
 * The quiet phase: the veil and NOTHING else. Both text overlays are asserted
 * absent by testID, and the veil itself carries no Text (pinned in
 * SessionSwapVeil.test.tsx), so this is "nothing to read" in full.
 */
function expectQuietVeilOnly(): void {
  expect(screen.getByTestId('session-swap-veil')).toBeTruthy();
  expect(screen.queryByTestId('session-switching-state')).toBeNull();
  expect(screen.queryByTestId('session-ended-state')).toBeNull();
}

/** Runs the clock past SESSION_SWAP_QUIET_MS under fake timers: the long-gap reveal. */
function passQuietDeadline(): void {
  act(() => {
    jest.advanceTimersByTime(SESSION_SWAP_QUIET_MS + 1);
  });
}

describe('SessionScreen session binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1' };
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useTranscriptStore.getState().reset();
    // The stubbed TerminalTab never clears a session's painted flag on
    // unmount the way the real pane does, so a flag from an earlier test
    // would settle the next test's successor the instant it bound.
    useTerminalUiStore.setState({ paintedSessionIds: {} });
    useSettingsStore.setState({ hasSeenSessionModeHint: true, hydrated: true });
  });

  it('binds to the param session before the board locates the task', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-param' };
    renderSessionScreen();
    expect(openSessionScreenMock).toHaveBeenCalledWith('sess-param');
    expect(screen.queryByTestId('session-ended-state')).toBeNull();
  });

  it('re-binds to the successor session when the board swaps the task session', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    expect(openSessionScreenMock).toHaveBeenCalledWith('sess-a');

    act(() => {
      seedTaskWithSession('sess-b');
    });

    expect(closeSessionScreenMock).toHaveBeenCalledWith('sess-a');
    expect(openSessionScreenMock).toHaveBeenCalledWith('sess-b');
    const closeOrder = closeSessionScreenMock.mock.invocationCallOrder[0];
    const reopenOrder = openSessionScreenMock.mock.invocationCallOrder[1];
    expect(closeOrder).toBeLessThan(reopenOrder);
    // A live successor means no ended state flashed.
    expect(screen.queryByTestId('session-ended-state')).toBeNull();
  });

  it('shows the ended state (and hides the input bar) when the located task loses its session', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    expect(screen.getByTestId('stub-session-input-bar')).toBeTruthy();

    act(() => {
      seedTaskWithSession(null);
    });

    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
    expect(closeSessionScreenMock).toHaveBeenCalledWith('sess-a');
    expect(screen.queryByTestId('stub-session-input-bar')).toBeNull();
  });

  it('recovers from the ended state when a successor session appears', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    act(() => {
      seedTaskWithSession(null);
    });
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();

    act(() => {
      seedTaskWithSession('sess-c');
    });

    expect(screen.queryByTestId('session-ended-state')).toBeNull();
    expect(openSessionScreenMock).toHaveBeenCalledWith('sess-c');
  });

  /**
   * Caught by the session-ended-state E2E flow, which went red the moment the
   * 0.9.0 board projection landed. Under `view: 'sessions'` the ended task is
   * filtered out of the board entirely, so `taskLocated` goes false and the
   * board-says-no-session signal above can never fire; reconcileSessionsFromBoards
   * then prunes the activity entry, taking `feedStatus: 'ended'` with it a few
   * hundred milliseconds later. Both signals the screen used to rely on are gone
   * within one round trip of the end, and the ended state appeared and vanished.
   */
  it('keeps the ended state after the sessions projection drops the task and the entry is pruned', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
    renderSessionScreen();
    expect(screen.getByTestId('stub-session-input-bar')).toBeTruthy();

    // The fixture's task sits in the To Do role column, which promises no
    // successor, so the end is handled without a quiet window and the ended
    // state shows at once.
    act(() => {
      pushSessionEnded('sess-a');
    });
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();

    // What lands next: the board refetch drops the task, and the reconciler
    // prunes the activity entry behind it. Off the board the role check goes
    // inert, so an end that was already handled must stay handled - a veil
    // opening here, OVER the ended state, is the regression this pins.
    act(() => {
      seedBoardWithoutTask();
      useActivityStore.getState().removeSession('sess-a');
    });

    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    expect(screen.queryByTestId('stub-session-input-bar')).toBeNull();
  });

  /**
   * The same collapse, entered from the board rather than a triage row, so
   * there is no sessionId param either. With the task gone nothing can name
   * the dead session but the binding the screen already made. The push and
   * the drop land in one act here, so the screen never sees the To Do role
   * at the end: the quiet window opens off lastBoundSessionId and the ended
   * state reveals at the deadline.
   */
  it('keeps the ended state with no sessionId param to fall back on', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1' };
      seedTaskWithSession('sess-a');
      useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
      renderSessionScreen();
      expect(screen.queryByTestId('session-ended-state')).toBeNull();

      act(() => {
        pushSessionEnded('sess-a');
        seedBoardWithoutTask();
        useActivityStore.getState().removeSession('sess-a');
      });
      expectQuietVeilOnly();

      passQuietDeadline();

      expect(screen.getByTestId('session-ended-state')).toBeTruthy();
      expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not show the ended state for a task that never had a session', () => {
    seedTaskWithSession(null);
    renderSessionScreen();
    expect(screen.queryByTestId('session-ended-state')).toBeNull();
    expect(openSessionScreenMock).not.toHaveBeenCalled();
  });

  it('declares the session dead when its feed stays rejected past the grace window', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
      renderSessionScreen();

      act(() => {
        useActivityStore.getState().markRejected('sess-a');
      });
      // Inside the grace window: no flash.
      expect(screen.queryByTestId('session-ended-state')).toBeNull();

      act(() => {
        jest.advanceTimersByTime(1600);
      });
      expect(screen.getByTestId('session-ended-state')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('defaults to terminal mode and honors the mode=chat entry param', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    const first = renderSessionScreen();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityLabel).toBe('terminal');
    first.unmount();

    mockParams = { taskId: 'task-1', sessionId: 'sess-a', mode: 'chat' };
    renderSessionScreen();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityLabel).toBe('chat');
  });

  it('changes is an inline pane, not a header chip or pushed route', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a', projectId: 'project-1' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    // No header chip anymore; the pane is mounted alongside the others (the
    // footer switcher, stubbed in this suite, switches to it in place). The
    // header's COLUMN chip is different in kind - a command, not a surface -
    // and only navigates on press, so nothing here has pushed.
    expect(screen.queryByTestId('task-header-changes')).toBeNull();
    // includeHiddenElements because an inactive pane is deliberately removed
    // from the accessibility tree (asserted below). The default query honours
    // that the way a screen reader would, so the structural check has to opt
    // in explicitly - it is asking "is it mounted", not "is it readable".
    expect(screen.getByTestId('session-pane-changes', { includeHiddenElements: true })).toBeTruthy();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('keeps every pane mounted but hides the inactive ones from accessibility', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a', projectId: 'project-1' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    // All three surfaces stay mounted so the xterm WebView never reloads and
    // the conversation keeps its scroll position. That makes hiding the
    // inactive two from the accessibility tree load-bearing: without it a
    // screen reader walks all three and reads the terminal while the user is
    // looking at Chat. Terminal is the default lens here.
    const paneVisibility = (testID: string) => {
      const pane = screen.getByTestId(testID, { includeHiddenElements: true });
      return {
        hidden: pane.props.accessibilityElementsHidden,
        android: pane.props.importantForAccessibility,
        pointerEvents: pane.props.pointerEvents,
      };
    };
    expect(paneVisibility('session-pane-terminal')).toEqual({
      hidden: false,
      android: 'auto',
      pointerEvents: 'auto',
    });
    for (const hiddenPane of ['session-pane-chat', 'session-pane-changes']) {
      expect(paneVisibility(hiddenPane)).toEqual({
        hidden: true,
        android: 'no-hide-descendants',
        pointerEvents: 'none',
      });
    }
  });

  /**
   * Move is a native form sheet ROUTE, so the screen only navigates. The
   * sheet's own behaviour (current column disabled, append position, failure
   * message) lives in tests/components/MoveTaskScreen.test.tsx. No projectId
   * param on purpose: the chip resolves the project from the board that
   * actually holds the task.
   */
  it('tapping the header column chip navigates to the move-task form sheet with the task and project', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();

    fireEvent.press(screen.getByTestId('task-header-column'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/move-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
    expect(screen.queryByTestId('move-task-sheet')).toBeNull();
  });

  /**
   * Without a located task there is no board to move within, and navigating
   * would open an empty dead sheet. The affordance is absent, not inert -
   * absence IS the guard.
   */
  it('renders no move affordance before the board has located the task', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    renderSessionScreen();

    expect(screen.queryByTestId('task-header-column')).toBeNull();
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('offers Move task in the ended state while the task is still on a full board', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    act(() => {
      seedTaskWithSession(null);
    });
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();

    fireEvent.press(screen.getByTestId('session-ended-move-task'));

    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/move-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });

  /**
   * The overlay covers the WHOLE pane area, so "View changes" switching the
   * mode underneath is not enough: an overlay that keeps rendering leaves the
   * user looking at the same panel they just tapped out of, and the escape
   * hatch reads as a dead button.
   *
   * No existing tier catches this. `session-ended-state.yaml` asserts that
   * `changes-scope` becomes visible, but all three panes are always mounted
   * and only their ACCESSIBILITY visibility flips with the mode - so that
   * assertion passes while the overlay still covers the pane. It is the exact
   * mirror of the zIndex bug the overlay's own docblock records: that one was
   * caught because a TAP was swallowed, not because a visibility assert failed.
   */
  it('gets out of the way when the user takes the View changes escape hatch', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    act(() => {
      seedTaskWithSession(null);
    });
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();

    fireEvent.press(screen.getByTestId('session-ended-view-changes'));

    expect(screen.queryByTestId('session-ended-state')).toBeNull();
    // ...and the Changes pane is the one now live behind where it was.
    expect(screen.getByTestId('session-pane-changes').props.accessibilityElementsHidden).toBe(false);
    // The footer stays bound to the session this screen last had (the panes
    // and the footer never unbind while the board reports nothing), so the
    // mode pill is the way back from Changes, exactly as in the switching
    // case below.
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityLabel).toBe('changes');
  });

  /**
   * The escape hatch above only proves the overlay CAN be dismissed - a
   * regression that latched "dismissed" into its own state (rather than
   * deriving showEndedState from `mode` alone, as `overlaysYieldToChanges`
   * does) would pass it just as well. Round-tripping the mode back to
   * terminal is what actually exercises the derivation.
   *
   * This uses the desktop-ended-push route (session_id stays 'sess-a')
   * rather than seedTaskWithSession(null): a session that goes fully null
   * renders no SessionInputBar at all (see the test above), so there is no
   * mode pill to press on the way back.
   */
  it('brings the ended overlay back once the mode returns to terminal', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    act(() => {
      pushSessionEnded('sess-a');
    });
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();

    fireEvent.press(screen.getByTestId('session-ended-view-changes'));
    expect(screen.queryByTestId('session-ended-state')).toBeNull();

    fireEvent.press(screen.getByTestId('session-mode-terminal'));

    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
  });

  /**
   * Under the sessions projection an ended task is dropped from the board, so
   * MoveTaskScreen could not locate it either: the Move button hides while
   * View changes stays (diffs outlive the session).
   */
  it('hides Move task when the sessions projection dropped the task', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
      renderSessionScreen();

      act(() => {
        pushSessionEnded('sess-a');
        seedBoardWithoutTask();
        useActivityStore.getState().removeSession('sess-a');
      });
      passQuietDeadline();

      expect(screen.getByTestId('session-ended-state')).toBeTruthy();
      expect(screen.queryByTestId('session-ended-move-task')).toBeNull();
      expect(screen.getByTestId('session-ended-view-changes')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The regression the paired `session-ended-state` flow caught and every
   * required check missed.
   *
   * When the pager became absolutely-positioned siblings, the panes gained
   * `zIndex: 1` while this overlay had none - so the visible pane stacked
   * ABOVE it. On device, "Session ended" bled through the gaps between
   * transcript cards and BOTH overlay buttons were dead, because React Native
   * hands a tap to the topmost view rather than letting it fall through to an
   * occluded sibling.
   *
   * No `fireEvent.press` test can see this. `fireEvent` invokes the handler
   * directly and never consults hit testing, which is exactly why the two
   * press tests above stayed green all the way through the bug. The closest a
   * JS tier can get is asserting the MECHANISM - that the overlay outranks the
   * visible pane - so that is what this does. The real proof stays the paired
   * Maestro flow.
   */
  it('stacks the ended-state overlay above the visible pane, so its buttons can be tapped', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    act(() => {
      seedTaskWithSession(null);
    });

    const overlayZIndex = StyleSheet.flatten(screen.getByTestId('session-ended-state').props.style)?.zIndex;
    // Terminal is the default mode, so that is the pane carrying paneVisible.
    //
    // `includeHiddenElements` because the assertion is about STACKING, and the
    // pane is deliberately hidden from the accessibility tree while an overlay
    // covers it (SessionScreen's overlayCoversPanes). It is still mounted and
    // still painting underneath, which is the whole reason the zIndex contest
    // it is in here matters.
    const visiblePaneZIndex = StyleSheet.flatten(
      screen.getByTestId('session-pane-terminal', { includeHiddenElements: true }).props.style,
    )?.zIndex;

    // Both must be real numbers: an undefined zIndex on either side is the bug
    // (an implicit auto lost the contest), not a passing comparison.
    expect(typeof overlayZIndex).toBe('number');
    expect(typeof visiblePaneZIndex).toBe('number');
    expect(overlayZIndex).toBeGreaterThan(visiblePaneZIndex);
  });

});

/**
 * A column move that restarts the agent is a session SWAP: the desktop
 * suspends the old session - which pushes `session-ended` - and spawns the
 * successor only after the worktree work, a measured median 2.3s later and up
 * to 24.4s at the tail. Declaring the task dead in that gap is wrong, and the
 * REJECTED_FEED_GRACE_MS window does not cover it (that one guards a refused
 * SUBSCRIBE, not a delivered ended push).
 *
 * The ordering these pin is the PHONE-INITIATED one, deliberately:
 * applyOptimisticMove writes the new swimlane the instant the user confirms,
 * so by the time the ended push lands the column change is old news. A design
 * that compares the column against "what it was last render" never sees it.
 * The desktop-initiated ordering (snapshot, then ended) passes either way and
 * would prove nothing about that.
 */
describe('SessionScreen across a column move', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1', sessionId: 'sess-a', projectId: 'project-1' };
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useTranscriptStore.getState().reset();
    // See the session-binding block: the stubbed pane never clears this.
    useTerminalUiStore.setState({ paintedSessionIds: {} });
    useSettingsStore.setState({ hasSeenSessionModeHint: true, hydrated: true });
  });

  /**
   * A board shaped like a real one: To Do and Done carry their system roles,
   * the working columns in between carry none. boardColumnFixture defaults to
   * role 'todo', so an id-only override would give every column the role that
   * means "no successor is coming" and quietly disable the whole window.
   */
  function seedRoledBoard(sessionId: string | null, swimlaneId = 'lane-todo'): void {
    useBoardStore.setState({
      projects: [{ id: 'project-1', name: 'Alpha' }],
      boardsByProjectId: {
        'project-1': {
          columns: [
            boardColumnFixture(),
            boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null, position: 1 }),
            boardColumnFixture({ id: 'lane-review', name: 'Review', role: null, position: 2 }),
            boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 3 }),
          ],
          tasksById: {
            'task-1': boardTaskFixture({ id: 'task-1', session_id: sessionId, swimlane_id: swimlaneId }),
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

  function moveTaskToColumn(targetSwimlaneId: string): void {
    useBoardStore.getState().applyOptimisticMove({
      projectId: 'project-1',
      taskId: 'task-1',
      toSwimlaneId: targetSwimlaneId,
      toPosition: 0,
    });
  }

  it('shows the switching state, not the ended state, once a move outlives the quiet window', () => {
    jest.useFakeTimers();
    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();

      // The user confirms the move: the card lands in the new column at once.
      act(() => {
        moveTaskToColumn('lane-doing');
      });
      // Seconds later the desktop's suspend reaches the phone. The successor
      // does not exist yet. For the quiet phase there is nothing to read, and
      // the footer stays exactly where it was.
      act(() => {
        pushSessionEnded('sess-a');
      });
      expectQuietVeilOnly();
      expect(screen.getByTestId('stub-session-input-bar').props.accessibilityLabel).toBe('terminal');

      passQuietDeadline();

      // The ended assertion runs FIRST, deliberately: it is the reported bug
      // (the overlay flashing mid-move), and a missing switching testID would
      // otherwise mask it as "the component is not there" rather than "the
      // screen declared the task dead".
      expect(screen.queryByTestId('session-ended-state')).toBeNull();
      expect(screen.getByTestId('session-switching-state')).toBeTruthy();
      expect(screen.queryByTestId('session-swap-veil')).toBeNull();
      // Nothing to type into once the screen admits it is between sessions.
      expect(screen.queryByTestId('stub-session-input-bar')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A swap can hold the screen for the whole grace window on a slow machine,
   * and the work so far is still readable in the diff - so the scrim carries
   * the same escape hatch as the ended state, and yields to it.
   */
  it('lets the user out to Changes while switching, and comes back with the mode pill', () => {
    jest.useFakeTimers();
    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();
      act(() => {
        moveTaskToColumn('lane-doing');
      });
      act(() => {
        pushSessionEnded('sess-a');
      });
      passQuietDeadline();
      expect(screen.getByTestId('session-switching-state')).toBeTruthy();

      fireEvent.press(screen.getByTestId('session-switching-view-changes'));

      expect(screen.queryByTestId('session-switching-state')).toBeNull();
      expect(screen.getByTestId('session-pane-changes').props.accessibilityElementsHidden).toBe(false);
      // Still bound to the outgoing session, so the pill is the way back - and
      // going back to terminal must bring the scrim with it.
      expect(screen.getByTestId('stub-session-input-bar').props.accessibilityLabel).toBe('changes');

      fireEvent.press(screen.getByTestId('session-mode-terminal'));

      expect(screen.getByTestId('session-switching-state')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  it('clears the switching state when the successor session binds', () => {
    jest.useFakeTimers();
    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();
      act(() => {
        moveTaskToColumn('lane-doing');
      });
      act(() => {
        pushSessionEnded('sess-a');
      });
      passQuietDeadline();
      expect(screen.getByTestId('session-switching-state')).toBeTruthy();

      // The desktop spawned the successor and the settled snapshot carries it.
      act(() => {
        seedRoledBoard('sess-b', 'lane-doing');
      });

      expect(screen.queryByTestId('session-switching-state')).toBeNull();
      expect(screen.queryByTestId('session-ended-state')).toBeNull();
      expect(openSessionScreenMock).toHaveBeenCalledWith('sess-b');
    } finally {
      jest.useRealTimers();
    }
  });

  it('falls back to the ended state when no successor arrives within the grace window', () => {
    jest.useFakeTimers();
    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();
      act(() => {
        moveTaskToColumn('lane-doing');
      });
      act(() => {
        pushSessionEnded('sess-a');
      });
      passQuietDeadline();
      expect(screen.getByTestId('session-switching-state')).toBeTruthy();

      // The latch timer started with the ended push, so the ended fallback is
      // 20s from THAT instant, not from the reveal.
      act(() => {
        jest.advanceTimersByTime(20_001 - (SESSION_SWAP_QUIET_MS + 1));
      });

      expect(screen.queryByTestId('session-switching-state')).toBeNull();
      expect(screen.getByTestId('session-ended-state')).toBeTruthy();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A move to To Do is a full reset - the session is killed and the worktree
   * removed - so there is no successor to wait for and the honest answer is
   * immediate. `boardColumnFixture` defaults to the todo role.
   */
  it('shows the ended state immediately for a move to the To Do column', () => {
    // Starts in Doing, so the move to To Do is a real column change.
    seedRoledBoard('sess-a', 'lane-doing');
    renderSessionScreen();

    act(() => {
      moveTaskToColumn('lane-todo');
    });
    act(() => {
      pushSessionEnded('sess-a');
    });

    expect(screen.queryByTestId('session-switching-state')).toBeNull();
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
  });

  /**
   * The mirror case: a move to a Done-role column also promises no successor
   * (the task is archived and its worktree deleted), so the swap window must
   * never open either. Unlike the two Done tests further down, this one
   * performs a REAL swimlane change (starts in Doing) and pushes
   * `session-ended`, which is exactly the combination that opens the window
   * when the `!isDoneRole(locatedColumnRole)` clause is missing.
   */
  it('shows the ended state immediately for a move to the Done column, never the switching state', () => {
    // Starts in Doing, so the move to Done is a real column change.
    seedRoledBoard('sess-a', 'lane-doing');
    renderSessionScreen();

    act(() => {
      moveTaskToColumn('lane-done');
    });
    act(() => {
      pushSessionEnded('sess-a');
    });

    expect(screen.queryByTestId('session-switching-state')).toBeNull();
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
  });

  /**
   * Done deletes the worktree and archives the task, so the session screen has
   * nowhere good to stand: the ended state offers "View changes" for a diff
   * read-diff would answer from the PROJECT checkout, and its Move button
   * disappears with the card. The completed view is the destination the board
   * already uses for an archived task.
   */
  it('replaces itself with the completed-task view once the task is archived', () => {
    seedRoledBoard('sess-a');
    renderSessionScreen();

    act(() => {
      pushSessionEnded('sess-a');
      // The desktop archived the task: it leaves the board snapshot entirely
      // (every board query filters archived_at IS NULL) and arrives in the
      // archive page the screen asked for.
      seedBoardWithoutTask();
      useBoardStore.setState({
        archivedByProjectId: {
          'project-1': {
            tasks: [
              boardTaskFixture({
                id: 'task-1',
                session_id: null,
                archived_at: '2026-09-11T00:00:00.000Z',
              }),
            ],
            totalCount: 1,
            summariesByTaskId: {},
            nextOffset: 1,
            loading: false,
          },
        },
      });
    });

    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/completed-task',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();
  });

  /**
   * The first look is legitimately too early. A move to Done writes the task
   * into the done column OPTIMISTICALLY, seconds before the desktop archives
   * anything, so that page comes back without it. A plain "fetched once" guard
   * would then never look again and the screen would sit under the ended state
   * for a task that completed.
   */
  it('asks for the archive again once the task actually leaves the board', () => {
    seedRoledBoard('sess-a');
    renderSessionScreen();
    expect(loadArchivedTasksMock).not.toHaveBeenCalled();

    // Optimistic: the card is in Done, the desktop has not archived yet.
    act(() => {
      moveTaskToColumn('lane-done');
    });
    expect(loadArchivedTasksMock).toHaveBeenCalledTimes(1);

    // Authoritative: the archive row exists, so the task is gone from the board.
    act(() => {
      seedBoardWithoutTask();
    });
    expect(loadArchivedTasksMock).toHaveBeenCalledTimes(2);
    expect(loadArchivedTasksMock).toHaveBeenLastCalledWith({ projectId: 'project-1' });
  });

  /**
   * The swallowed-in-flight-fetch bug this branch fixed: loadArchivedTasks
   * (src/connection/actions.ts) silently early-returns - resolves, never
   * throws - when a page for the project is ALREADY in flight (BoardScreen
   * fetches the same list). The `:located` key's page can still be in flight
   * when the task leaves the board and the key flips to `:gone`; the fix is
   * an `archiveFetchInFlight` selector that holds the `:gone` look off until
   * the in-flight page LANDS, so it gets its own real fetch instead of firing
   * into the guard and being swallowed.
   *
   * The mock below mirrors loadArchivedTasks' own early-return contract
   * (checking `archivedByProjectId[projectId]?.loading` itself) rather than
   * merely resolving, because a fake that does not reproduce the guard cannot
   * tell the fixed and unfixed effect apart - both fire the same NUMBER of
   * calls at the mock either way. What differs is whether the second call
   * lands while the first is still loading (swallowed, no resolver) or after
   * it clears (a real fetch, with a resolver) - so the assertions here are on
   * live resolvers and the eventual redirect, not the raw call count.
   */
  it('gives the :gone key its own look once the in-flight :located page lands, instead of losing it to the guard', async () => {
    interface PendingArchivePage {
      projectId: string;
      archivedTasks: ReturnType<typeof boardTaskFixture>[];
      archivedTotalCount: number;
      summariesByTaskId: Record<string, never>;
    }
    const archivedPageResolvers: ((page: PendingArchivePage) => void)[] = [];
    loadArchivedTasksMock.mockImplementation(({ projectId }: { projectId: string }) => {
      const alreadyHeld = useBoardStore.getState().archivedByProjectId[projectId];
      // The real contract: a page already in flight is a silent no-op.
      if (alreadyHeld?.loading) return Promise.resolve();
      useBoardStore.getState().setArchivedLoading(projectId, true);
      return new Promise<void>((resolve) => {
        archivedPageResolvers.push((page) => {
          useBoardStore.getState().applyArchivedPage(page, { append: false });
          resolve();
        });
      });
    });

    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();

      // The `:located` key's fetch: the card lands in Done optimistically.
      act(() => {
        moveTaskToColumn('lane-done');
      });
      expect(loadArchivedTasksMock).toHaveBeenCalledTimes(1);
      expect(archivedPageResolvers).toHaveLength(1);

      // The task leaves the board while that fetch is STILL in flight: the
      // key flips to `:gone`. The in-flight guard must hold this off - no
      // second live resolver yet, whether or not the mock's own contract
      // also counts a swallowed call.
      act(() => {
        seedBoardWithoutTask();
      });
      expect(archivedPageResolvers).toHaveLength(1);

      // The in-flight `:located` page lands, without the task (it was fetched
      // before the archive row existed).
      act(() => {
        archivedPageResolvers[0]({
          projectId: 'project-1',
          archivedTasks: [],
          archivedTotalCount: 0,
          summariesByTaskId: {},
        });
      });

      // The decisive second look: the `:gone` key gets its OWN real fetch now
      // that the guard has cleared, not a call swallowed by the contract.
      await waitFor(() => expect(archivedPageResolvers).toHaveLength(2));
      expect(mockReplace).not.toHaveBeenCalled();

      // That second fetch lands WITH the archived task.
      act(() => {
        archivedPageResolvers[1]({
          projectId: 'project-1',
          archivedTasks: [
            boardTaskFixture({ id: 'task-1', session_id: null, archived_at: '2026-09-11T00:00:00.000Z' }),
          ],
          archivedTotalCount: 1,
          summariesByTaskId: {},
        });
      });

      await waitFor(() =>
        expect(mockReplace).toHaveBeenCalledWith({
          pathname: '/completed-task',
          params: { taskId: 'task-1', projectId: 'project-1' },
        }),
      );
    } finally {
      loadArchivedTasksMock.mockReset();
      loadArchivedTasksMock.mockResolvedValue(undefined);
    }
  });

  /**
   * A failure sets `loading` back to false on its way out (the real
   * loadArchivedTasks does this too), and `archiveFetchInFlight` is a
   * dependency of the fetch effect - so `loading` clearing re-runs it. The
   * key must stay consumed for a FAILED look, not just a successful one: an
   * implementation that frees the ref inside the `.catch` (the natural thing
   * to try, and the shape the fix briefly took) re-fires into the SAME key
   * every time the mock's own async failure clears `loading`, which is a
   * tight retry loop for as long as the desktop stays unreachable.
   */
  it('does not spin: a failed fetch does not re-issue for the same key once loading clears', async () => {
    loadArchivedTasksMock.mockImplementation(({ projectId }: { projectId: string }) => {
      const alreadyHeld = useBoardStore.getState().archivedByProjectId[projectId];
      if (alreadyHeld?.loading) return Promise.resolve();
      useBoardStore.getState().setArchivedLoading(projectId, true);
      // A genuine async gap (not a same-tick set-true-then-false) so `loading`
      // clearing is an OBSERVABLE transition the effect's dependency list can
      // react to - exactly like the real verb round trip failing.
      return new Promise<void>((_resolve, reject) => {
        setTimeout(() => {
          useBoardStore.getState().setArchivedLoading(projectId, false);
          reject(new Error('offline (probe)'));
        }, 5);
      });
    });

    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();

      act(() => {
        moveTaskToColumn('lane-done');
      });
      expect(loadArchivedTasksMock).toHaveBeenCalledTimes(1);

      // Long enough for several 5ms failure/retry windows to have run if the
      // effect were re-firing into the same key.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 60));
      });

      expect(loadArchivedTasksMock).toHaveBeenCalledTimes(1);
    } finally {
      loadArchivedTasksMock.mockReset();
      loadArchivedTasksMock.mockResolvedValue(undefined);
    }
  });

  it('does not redirect a task that is still on the board', () => {
    // seedRoledBoard's default column is the To Do role, so the end is
    // handled without a quiet window and the ended state shows at once.
    seedRoledBoard('sess-a');
    renderSessionScreen();

    act(() => {
      pushSessionEnded('sess-a');
      // A stale archive page from an earlier visit, for a task that has since
      // been moved back out of Done and is live on the board again.
      useBoardStore.setState({
        archivedByProjectId: {
          'project-1': {
            tasks: [boardTaskFixture({ id: 'task-1', archived_at: '2026-09-01T00:00:00.000Z' })],
            totalCount: 1,
            summariesByTaskId: {},
            nextOffset: 1,
            loading: false,
          },
        },
      });
    });

    expect(mockReplace).not.toHaveBeenCalled();
    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
  });

  /**
   * The bug this task exists for: a SAME-COLUMN respawn (a model/agent/effort
   * change, an isolated-session-track switch) has no column move to key the
   * existing swap window off, so before this the screen fell straight through
   * to the ended state for the whole desktop-side respawn gap. The desktop's
   * `session-ended` push can now carry an in-flight spawnProgressLabel
   * (kangentic board #639) naming the phase, and this opens a second,
   * session-keyed swap window off that signal alone.
   *
   * All tasks below stay in 'lane-doing' (role null, from seedRoledBoard) and
   * never call moveTaskToColumn - the column path is pinned above and must
   * stay byte-for-byte unchanged by this addition.
   */
  describe('a same-column respawn (spawnProgressLabel, no column move)', () => {
    it('shows the switching state, not the ended state, once a label swap outlives the quiet window', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();

        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
        });
        expectQuietVeilOnly();

        passQuietDeadline();

        // The ended assertion runs FIRST, deliberately - same reasoning as the
        // column-move version of this test: the reported bug IS the ended
        // state appearing here, so a missing switching testID must not be
        // allowed to read as "not there" rather than "declared dead".
        expect(screen.queryByTestId('session-ended-state')).toBeNull();
        expect(screen.getByTestId('session-switching-state')).toBeTruthy();
        expect(screen.queryByTestId('stub-session-input-bar')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    it('renders the label text on the overlay, not just the generic caption', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();

        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
        });
        // Nothing to read during the quiet phase, the label included.
        expect(screen.queryByText('Switching model...')).toBeNull();

        passQuietDeadline();

        expect(screen.getByText('Switching model...')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * A desktop that predates spawnProgressLabel (or a genuine park with no
     * successor coming) sends no label. The label no longer decides whether
     * something QUIET shows - every end of the bound session gets the veil -
     * only what the long-gap reveal says: with no evidence of a successor
     * that is the ended state, and the switching one never shows.
     */
    it('goes quiet, then falls to the ended state (never the switching one) when the desktop sends no label', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();

        act(() => {
          pushSessionEnded('sess-a');
        });
        expectQuietVeilOnly();

        passQuietDeadline();

        expect(screen.queryByTestId('session-switching-state')).toBeNull();
        expect(screen.queryByTestId('session-swap-veil')).toBeNull();
        expect(screen.getByTestId('session-ended-state')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('falls back to the ended state when no successor arrives within the grace window', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();
        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching agent...' });
        });
        passQuietDeadline();
        expect(screen.getByTestId('session-switching-state')).toBeTruthy();

        act(() => {
          jest.advanceTimersByTime(20_001 - (SESSION_SWAP_QUIET_MS + 1));
        });

        expect(screen.queryByTestId('session-switching-state')).toBeNull();
        expect(screen.getByTestId('session-ended-state')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * The spent marker is mandatory, not defensive: nothing ever changes the
     * label read after it expires, so without a spent marker the window
     * re-arms on the very next render and the screen never reaches the ended
     * state at all.
     */
    it('does not re-arm the switching state on a render well after the grace window expires', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();
        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Applying new settings...' });
        });
        act(() => {
          jest.advanceTimersByTime(20_001);
        });
        expect(screen.getByTestId('session-ended-state')).toBeTruthy();

        // Advance well past expiry again and force a render (a board
        // re-snapshot at the same shape) - the label is still sitting in the
        // store (session-ended-state's entry survives until removeSession),
        // so a missing spent marker would re-open the window right here.
        act(() => {
          jest.advanceTimersByTime(20_000);
          seedRoledBoard('sess-a', 'lane-doing');
        });

        expect(screen.queryByTestId('session-switching-state')).toBeNull();
        // The quiet window has its own spent marker for the same reason.
        expect(screen.queryByTestId('session-swap-veil')).toBeNull();
        expect(screen.getByTestId('session-ended-state')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('clears the switching state when the successor session binds', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();
        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Starting new session...' });
        });
        passQuietDeadline();
        expect(screen.getByTestId('session-switching-state')).toBeTruthy();

        // The desktop spawned the successor and the settled snapshot carries
        // it, still in the same column - no move involved.
        act(() => {
          seedRoledBoard('sess-b', 'lane-doing');
        });

        expect(screen.queryByTestId('session-switching-state')).toBeNull();
        expect(screen.queryByTestId('session-ended-state')).toBeNull();
        expect(openSessionScreenMock).toHaveBeenCalledWith('sess-b');
      } finally {
        jest.useRealTimers();
      }
    });

    it('replaces itself with the completed-task view rather than showing the switching scrim, for an archived task', () => {
      seedRoledBoard('sess-a', 'lane-doing');
      renderSessionScreen();

      act(() => {
        pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
        seedBoardWithoutTask();
        useBoardStore.setState({
          archivedByProjectId: {
            'project-1': {
              tasks: [
                boardTaskFixture({
                  id: 'task-1',
                  session_id: null,
                  archived_at: '2026-09-11T00:00:00.000Z',
                }),
              ],
              totalCount: 1,
              summariesByTaskId: {},
              nextOffset: 1,
              loading: false,
            },
          },
        });
      });

      expect(screen.queryByTestId('session-switching-state')).toBeNull();
      expect(screen.queryByTestId('session-swap-veil')).toBeNull();
      expect(mockReplace).toHaveBeenCalledWith({
        pathname: '/completed-task',
        params: { taskId: 'task-1', projectId: 'project-1' },
      });
    });

    /**
     * Entered from the board rather than a triage row (no sessionId param),
     * so the label has to be resolved off lastBoundSessionId - the same
     * fallback the ended-state signal itself relies on once the task is off
     * the board.
     */
    it('opens the switching state off lastBoundSessionId with no sessionId param', () => {
      jest.useFakeTimers();
      try {
        mockParams = { taskId: 'task-1', projectId: 'project-1' };
        seedRoledBoard('sess-a', 'lane-doing');
        useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
        renderSessionScreen();
        expect(screen.queryByTestId('session-ended-state')).toBeNull();

        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
        });
        expectQuietVeilOnly();
        passQuietDeadline();

        expect(screen.queryByTestId('session-ended-state')).toBeNull();
        expect(screen.getByTestId('session-switching-state')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * The composed path, not just either half in isolation. activityStore
     * records ANY non-empty string spawnProgressLabel with no shape check
     * (see activityStore.test.ts); SessionScreen opens the switching window
     * off presence alone (`boundSpawnProgressLabel !== null`); and only the
     * shared `renderableSpawnLabel` (src/lib/spawnLabel.ts) rejects a malformed
     * one, with SessionSwitchingState substituting its own generic caption
     * when it does (see SessionSwitchingState.test.tsx,
     * which drives that fallback via a directly-passed prop). Nothing before
     * this test exercises the three wired together: a real desktop-shaped
     * over-cap label flowing through the store into the mounted screen. What
     * matters most here is the failure this closes - a malformed label must
     * still open the SWITCHING overlay, never fall through to the ended one.
     */
    it('opens the switching state (with the generic caption, not the raw text) for an over-cap label from the desktop', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();

        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'A'.repeat(46) });
        });
        passQuietDeadline();

        expect(screen.queryByTestId('session-ended-state')).toBeNull();
        expect(screen.getByTestId('session-switching-state')).toBeTruthy();
        expect(screen.getByText('The desktop is starting a new session.')).toBeTruthy();
        expect(screen.queryByText('A'.repeat(46))).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  /**
   * The two openers are independent latches on the SAME `swapWindowOpen`
   * boolean, and the render-phase ladder only evaluates one branch per
   * render: once the column branch (3) has already opened
   * `swapWindowSwimlaneId`, its own guard `swapWindowSwimlaneId === null`
   * goes false, so the NEXT render falls through to the label branch (4) and
   * opens `spawnLabelWindowSessionId` too - both latches end up open at
   * once, each carrying its OWN independent SESSION_SWAP_GRACE_MS timer.
   * Neither existing describe block exercises this: the column-move block
   * above never pushes a label, and the same-column-respawn block never
   * calls moveTaskToColumn.
   */
  describe('the two swap-window openers interacting', () => {
    /**
     * Both latches open at effectively the SAME simulated instant under fake
     * timers (the column move and the labelled ended push are two separate
     * `act()` calls with no time advance between them), so both 20s timers
     * are armed at the same tick and fire together.
     *
     * EMPIRICAL RESULT (verified by running this test with the assertions
     * flipped before settling on these): the combined window closes at
     * ~20s, not ~40s. The two openers do not compose additively - they are
     * two independent latches racing to the SAME expiry point, not a
     * chained wait.
     */
    it('closes at ~20s (not ~40s) when a column move and a labelled session-ended land for the same session', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a');
        renderSessionScreen();

        act(() => {
          moveTaskToColumn('lane-doing');
        });
        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
        });
        passQuietDeadline();
        expect(screen.getByTestId('session-switching-state')).toBeTruthy();

        // Still open just under 20s from the (effectively simultaneous)
        // opening instant.
        act(() => {
          jest.advanceTimersByTime(19_999 - (SESSION_SWAP_QUIET_MS + 1));
        });
        expect(screen.getByTestId('session-switching-state')).toBeTruthy();

        // Both timers were armed at the same tick, so both expire together
        // here - NOT at 40s, which is what a naive "two windows stack"
        // reading would predict.
        act(() => {
          jest.advanceTimersByTime(2);
        });
        expect(screen.queryByTestId('session-switching-state')).toBeNull();
        expect(screen.getByTestId('session-ended-state')).toBeTruthy();
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * A label arriving only AFTER the column window has already expired and
     * been marked spent. `spentSwapSwimlaneId` and `spentSpawnLabelSessionId`
     * are separate variables, so the column branch staying spent does not
     * block the label branch: `spawnLabelWindowSessionId` has never been
     * opened before, so branch 4's own guard (`spawnLabelWindowSessionId ===
     * null`) is still true and it opens a FRESH window off the label alone.
     *
     * EMPIRICAL RESULT: the label opens its own window even though the
     * column window already expired - the switching overlay appears again,
     * it is not treated as "this session already used its one swap window".
     */
    it('opens a fresh spawn-label window when the label arrives after the column window already expired', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a');
        renderSessionScreen();

        // Column move only: opens the column-keyed window, but nothing is
        // shown yet because sessionEnded is still false (no ended push).
        act(() => {
          moveTaskToColumn('lane-doing');
        });
        expect(screen.queryByTestId('session-switching-state')).toBeNull();

        // Let the column window run out unused.
        act(() => {
          jest.advanceTimersByTime(20_001);
        });
        expect(screen.queryByTestId('session-switching-state')).toBeNull();
        expect(screen.queryByTestId('session-ended-state')).toBeNull();

        // Only NOW does the labelled ended push arrive: the quiet window
        // opens fresh (nothing had spent it), and the label latch reveals at
        // its deadline.
        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
        });
        expectQuietVeilOnly();
        passQuietDeadline();

        expect(screen.getByTestId('session-switching-state')).toBeTruthy();
        expect(screen.queryByTestId('session-ended-state')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  /**
   * THE QUIET WINDOW. Every swap kind - a column move, a same-column respawn
   * with a label, an unlabelled end - opens ONE silent surface over the last
   * frame, holds it across the successor's bind, and lets go only once the
   * successor has painted. The text surfaces the two blocks above pin are
   * now the long-gap reveal, past SESSION_SWAP_QUIET_MS.
   */
  describe('the quiet swap window (the veil)', () => {
    /** The unlabelled column-move swap the desktop actually produces (kangentic #682's third row). */
    it('shows the veil and nothing else for an unlabelled end, with the footer held in place and inert', () => {
      seedRoledBoard('sess-a', 'lane-doing');
      renderSessionScreen();

      act(() => {
        pushSessionEnded('sess-a');
      });

      expectQuietVeilOnly();
      const inputBar = screen.getByTestId('stub-session-input-bar');
      expect(inputBar.props.accessibilityLabel).toBe('terminal');
      expect(inputBar.props.accessibilityState).toEqual({ disabled: true });
    });

    /**
     * The bind is a board fact that lands a round trip before the successor's
     * first frame exists. Letting go at the bind is what showed the old frame,
     * an empty grid and the new frame in sequence; the window must outlive
     * it and close on the paint report alone.
     */
    it('survives the successor binding and releases only once the successor has painted', () => {
      seedRoledBoard('sess-a', 'lane-doing');
      renderSessionScreen();
      act(() => {
        pushSessionEnded('sess-a');
      });
      expectQuietVeilOnly();

      act(() => {
        seedRoledBoard('sess-b', 'lane-doing');
      });
      expectQuietVeilOnly();
      // The panes and footer are on the successor now, and the footer is live
      // again: keys reach a session that exists. (includeHiddenElements: the
      // veil hides the pane subtree from assistive technology, deliberately.)
      expect(
        screen.getByTestId('stub-terminal-tab', { includeHiddenElements: true }).props.accessibilityLabel,
      ).toBe('sess-b');
      expect(screen.getByTestId('stub-session-input-bar').props.accessibilityState).toEqual({ disabled: false });

      act(() => {
        useTerminalUiStore.getState().markTerminalPainted('sess-b');
      });

      expect(screen.queryByTestId('session-swap-veil')).toBeNull();
      expect(screen.queryByTestId('session-switching-state')).toBeNull();
      expect(screen.queryByTestId('session-ended-state')).toBeNull();

      // A later render of the same shape must not re-open it.
      act(() => {
        seedRoledBoard('sess-b', 'lane-doing');
      });
      expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    });

    it('closes silently at the deadline when a successor is bound but has not painted', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();
        act(() => {
          pushSessionEnded('sess-a');
        });
        act(() => {
          seedRoledBoard('sess-b', 'lane-doing');
        });
        expectQuietVeilOnly();

        passQuietDeadline();

        // No veil, and no text either: sessionEnded is false for the
        // successor, so nothing can claim the session is over.
        expect(screen.queryByTestId('session-swap-veil')).toBeNull();
        expect(screen.queryByTestId('session-switching-state')).toBeNull();
        expect(screen.queryByTestId('session-ended-state')).toBeNull();
        const inputBar = screen.getByTestId('stub-session-input-bar');
        expect(inputBar.props.accessibilityLabel).toBe('terminal');
        expect(inputBar.props.accessibilityState).toEqual({ disabled: false });
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * A -> B -> C: the successor dies before it paints. The window re-keys to
     * B and its deadline restarts, so the reveal (the label latch B opened)
     * comes SESSION_SWAP_QUIET_MS after B's end, not after A's.
     */
    it("re-keys to a successor that ends while awaiting paint, restarting the deadline from that end", () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();
        act(() => {
          pushSessionEnded('sess-a');
        });
        act(() => {
          jest.advanceTimersByTime(3_000);
          seedRoledBoard('sess-b', 'lane-doing');
        });
        act(() => {
          jest.advanceTimersByTime(1_000);
          pushSessionEnded('sess-b', { spawnProgressLabel: 'Switching model...' });
        });
        expectQuietVeilOnly();

        // Past A's original deadline: still quiet, because the window is B's now.
        act(() => {
          jest.advanceTimersByTime(SESSION_SWAP_QUIET_MS + 1 - 4_000);
        });
        expectQuietVeilOnly();

        // Past B's deadline: the reveal, and it describes B (its label latch).
        act(() => {
          jest.advanceTimersByTime(4_000);
        });
        expect(screen.queryByTestId('session-swap-veil')).toBeNull();
        expect(screen.getByTestId('session-switching-state')).toBeTruthy();
        expect(screen.queryByTestId('session-ended-state')).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    /** Diffs outlive the session: the veil yields to Changes the way the two text overlays do, and comes back. */
    it('yields to Changes and returns with the mode, keeping the window open underneath', () => {
      seedRoledBoard('sess-a', 'lane-doing');
      renderSessionScreen();
      act(() => {
        pushSessionEnded('sess-a');
      });
      expectQuietVeilOnly();

      fireEvent.press(screen.getByTestId('session-mode-changes'));

      expect(screen.queryByTestId('session-swap-veil')).toBeNull();
      expect(screen.getByTestId('session-pane-changes').props.accessibilityElementsHidden).toBe(false);

      fireEvent.press(screen.getByTestId('session-mode-terminal'));

      expectQuietVeilOnly();
    });

    /**
     * In chat mode no paint can ever arrive: the terminal pane skips seeds
     * while it is not the visible page. "Settled" there is the successor's
     * transcript window landing.
     */
    it('settles in chat mode on the successor transcript window, not on a terminal paint', () => {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a', projectId: 'project-1', mode: 'chat' };
      seedRoledBoard('sess-a', 'lane-doing');
      renderSessionScreen();
      act(() => {
        pushSessionEnded('sess-a');
      });
      act(() => {
        seedRoledBoard('sess-b', 'lane-doing');
      });
      expectQuietVeilOnly();

      act(() => {
        useTranscriptStore.getState().retainSession('sess-b');
        useTranscriptStore
          .getState()
          .applyWindow('sess-b', { revision: 1, totalEntries: 0, startIndex: 0, entries: [] });
      });

      expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    });

    /**
     * The veil carries no text, so the announcement IS its accessibility
     * story: once per window, on the window opening - a Changes round-trip
     * remounts the veil and must not announce again. And while it is up the
     * panes leave the accessibility tree, as under the two text overlays.
     */
    it('announces once per window and hides the panes from assistive technology while up', () => {
      const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();
        expect(screen.getByTestId('session-panes').props.accessibilityElementsHidden).toBe(false);

        act(() => {
          pushSessionEnded('sess-a');
        });
        expect(announceSpy).toHaveBeenCalledTimes(1);
        expect(announceSpy).toHaveBeenCalledWith('Switching session, please wait');
        const panes = screen.getByTestId('session-panes', { includeHiddenElements: true });
        expect(panes.props.accessibilityElementsHidden).toBe(true);
        expect(panes.props.importantForAccessibility).toBe('no-hide-descendants');

        fireEvent.press(screen.getByTestId('session-mode-changes'));
        fireEvent.press(screen.getByTestId('session-mode-terminal'));
        expectQuietVeilOnly();
        expect(announceSpy).toHaveBeenCalledTimes(1);
      } finally {
        announceSpy.mockRestore();
      }
    });

    /**
     * Under the sessions projection the task leaves the board for the whole
     * gap. The title used to fall back to the literal "Task" and the number
     * vanished: more text appearing and disappearing mid-swap.
     */
    it('holds the header title and number while the sessions projection has dropped the task', () => {
      seedRoledBoard('sess-a', 'lane-doing');
      useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
      renderSessionScreen();
      expect(screen.getByText('Fix the login bug')).toBeTruthy();
      expect(screen.getByTestId('task-header-display-id')).toBeTruthy();

      act(() => {
        pushSessionEnded('sess-a');
        seedBoardWithoutTask();
        useActivityStore.getState().removeSession('sess-a');
      });

      expectQuietVeilOnly();
      expect(screen.getByText('Fix the login bug')).toBeTruthy();
      expect(screen.queryByText('Task')).toBeNull();
      expect(screen.getByTestId('task-header-display-id')).toBeTruthy();
    });

    /**
     * Under the Board tab's full projection the located task reports
     * session_id null for the gap. Resolving that to a null sessionId used to
     * swap the terminal pane for a placeholder (destroying the WebView) and
     * ChatPane for its empty state; the panes stay on the last bound session.
     */
    it('keeps the panes on the last bound session when the full projection reports the task sessionless', () => {
      seedRoledBoard('sess-a', 'lane-doing');
      renderSessionScreen();

      act(() => {
        seedRoledBoard(null, 'lane-doing');
      });

      expectQuietVeilOnly();
      // includeHiddenElements: the veil hides the pane subtree from assistive
      // technology, deliberately; the question here is what is MOUNTED.
      expect(
        screen.getByTestId('stub-terminal-tab', { includeHiddenElements: true }).props.accessibilityLabel,
      ).toBe('sess-a');
      expect(screen.getByTestId('stub-chat-pane', { includeHiddenElements: true }).props.accessibilityLabel).toBe(
        'sess-a',
      );
      expect(screen.getByTestId('stub-session-input-bar').props.accessibilityState).toEqual({ disabled: true });
    });

    /**
     * Under the sessions projection with a nav param the dead id stays
     * RESOLVED (the param bridges the gap), so "suspended" cannot be derived
     * from a null sessionId: it is the footer pointing at the session whose
     * end opened the window.
     */
    it('suspends the footer while it points at the dead session, even when the param keeps that id resolved', () => {
      seedRoledBoard('sess-a', 'lane-doing');
      useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
      renderSessionScreen();
      expect(screen.getByTestId('stub-session-input-bar').props.accessibilityState).toEqual({ disabled: false });

      act(() => {
        pushSessionEnded('sess-a');
        seedBoardWithoutTask();
      });

      expectQuietVeilOnly();
      const inputBar = screen.getByTestId('stub-session-input-bar');
      expect(inputBar.props.accessibilityLabel).toBe('terminal');
      expect(inputBar.props.accessibilityState).toEqual({ disabled: true });
    });
  });

  /**
   * The label branch's own `!isTodoRole` / `!isDoneRole` exclusions,
   * mirroring the column branch's equivalent tests above
   * ('shows the ended state immediately for a move to the To Do/Done
   * column'). Neither test below calls moveTaskToColumn: the task is seeded
   * directly into the excluded column so only the label branch is in play.
   */
  describe('the spawn-label window respects the To Do / Done exclusions', () => {
    it('does not open the spawn-label window for a task sitting in a To Do role column', () => {
      // Default swimlaneId is 'lane-todo' (role 'todo').
      seedRoledBoard('sess-a');
      renderSessionScreen();

      act(() => {
        pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
      });

      expect(screen.queryByTestId('session-switching-state')).toBeNull();
      expect(screen.queryByTestId('session-swap-veil')).toBeNull();
      expect(screen.getByTestId('session-ended-state')).toBeTruthy();
    });

    /**
     * Done deletes the worktree and archives the task, so the mirror case
     * has nowhere good to stand either - but with no archived page seeded
     * here, the archive fetch resolves without finding the task (the mocked
     * loadArchivedTasks writes nothing), so this settles on the ended
     * overlay rather than redirecting. Asserting what the code actually
     * does, per the task brief, not what "should" happen.
     */
    it('does not open the spawn-label window for a task sitting in a Done role column', () => {
      seedRoledBoard('sess-a', 'lane-done');
      renderSessionScreen();

      act(() => {
        pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
      });

      expect(screen.queryByTestId('session-switching-state')).toBeNull();
      expect(screen.queryByTestId('session-swap-veil')).toBeNull();
      expect(screen.getByTestId('session-ended-state')).toBeTruthy();
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });
});

/**
 * selectChatLens (src/state/transcriptStore.ts) exists because this screen and
 * ChatPane used to compute the chat lens with two different inline rules and
 * diverged: the terminal was told to start its clean-feed parser while the
 * pane still showed "Loading conversation...", which re-keys TerminalPane's
 * init and re-initialises the WebView for nothing. tests/unit/transcriptStore
 * .test.ts pins the pure selector; these pin that SessionScreen actually
 * forwards its answer to TerminalTab as `cleanFeedEnabled`, so a reintroduced
 * second inline predicate here fails a test instead of nothing.
 */
describe('SessionScreen terminal clean-feed forwarding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useTranscriptStore.getState().reset();
    useSettingsStore.setState({ hasSeenSessionModeHint: true, hydrated: true });
  });

  it('does not enable the clean feed before a transcript window has landed', () => {
    seedTaskWithSession('sess-a');
    renderSessionScreen();

    expect(screen.getByTestId('stub-terminal-tab').props.accessibilityState).toEqual({ selected: false });
  });

  it('enables the clean feed once the window lands empty (the reading-view lens)', () => {
    seedTaskWithSession('sess-a');
    useTranscriptStore.getState().retainSession('sess-a');
    useTranscriptStore.getState().applyWindow('sess-a', { revision: 1, totalEntries: 0, startIndex: 0, entries: [] });
    renderSessionScreen();

    expect(screen.getByTestId('stub-terminal-tab').props.accessibilityState).toEqual({ selected: true });
  });

  it('disables the clean feed once the window carries real entries (a structured transcript)', () => {
    seedTaskWithSession('sess-a');
    useTranscriptStore.getState().retainSession('sess-a');
    useTranscriptStore.getState().applyWindow('sess-a', {
      revision: 1,
      totalEntries: 1,
      startIndex: 0,
      entries: [userEntryFixture()],
    });
    renderSessionScreen();

    expect(screen.getByTestId('stub-terminal-tab').props.accessibilityState).toEqual({ selected: false });
  });
});
