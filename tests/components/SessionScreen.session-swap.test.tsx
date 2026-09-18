import React from 'react';
import { AccessibilityInfo, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import type { ActivityEventPayload } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { SESSION_SWAP_QUIET_MS, SessionScreen } from '@/screens/task/SessionScreen';
import {
  SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL,
  SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL,
} from '@/screens/task/SessionSwapVeil';
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
const mockBack = jest.fn();
// A default one test overrides with mockReturnValueOnce: the screen falls
// back to Home when there is nothing behind it.
const mockCanGoBack = jest.fn(() => true);
// ONE object, as expo-router's own `router` is. The leave effect keys its
// callback on the router, and a fresh object per render would re-run it (and
// re-pop) on every render, which no real app does.
const mockRouter = { replace: mockReplace, back: mockBack, push: mockPush, canGoBack: mockCanGoBack };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
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
    // inert-while-held flag, and `accessibilityValue.text` carrying
    // `switcherOnly`, the past-the-end shape), and this is the only stub in
    // the suite that needs a way between modes - the overlay round-trip tests
    // press these to prove showWaitingState / showQuietVeil are a pure
    // DERIVATION of mode, not a one-way latch.
    SessionInputBar: (props: {
      sessionId: string | null;
      mode: string;
      onModeChange: (mode: string) => void;
      suspended?: boolean;
      switcherOnly?: boolean;
    }) =>
      props.sessionId === null
        ? null
        : ReactModule.createElement(
            View,
            {
              testID: 'stub-session-input-bar',
              accessibilityLabel: props.mode,
              accessibilityState: { disabled: props.suspended === true },
              accessibilityValue: { text: props.switcherOnly === true ? 'switcher-only' : 'full' },
            },
            ReactModule.createElement(Pressable, {
              testID: 'session-mode-terminal',
              onPress: () => props.onModeChange('terminal'),
            }),
            ReactModule.createElement(Pressable, {
              testID: 'session-mode-chat',
              onPress: () => props.onModeChange('chat'),
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

/**
 * A full-projection board with the task in a WORKING column (role null) by
 * default. boardColumnFixture defaults to the To Do role, and a To Do task
 * with a bound session leaves this screen at once (a move there is a reset),
 * so the old default would have popped every test here before it began. The
 * one test about a To Do task passes 'lane-todo' explicitly.
 */
function seedTaskWithSession(sessionId: string | null, swimlaneId = 'lane-doing'): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture(), boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null, position: 1 })],
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
 * The quiet phase: the veil over the last frame and NOTHING else. The veil
 * carries no Text (pinned in SessionSwapVeil.test.tsx) and has not cleared
 * the pane yet, so this is "nothing to read, nothing changed" in full.
 */
function expectQuietVeilOnly(): void {
  const veil = screen.getByTestId('session-swap-veil');
  expect(veil.props.accessibilityLabel).toBe(SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL);
  expect(screen.queryByTestId('session-swap-veil-empty')).toBeNull();
  expect(screen.queryByTestId('session-swap-veil-cursor')).toBeNull();
}

/**
 * The waiting phase: the same veil, now carrying the waiting label with the
 * empty terminal painted under its scrim, and the footer still mounted
 * beneath it as the switcher alone (the stub records `switcherOnly`). No
 * text, no buttons: the old ended state hid the footer outright, and the
 * card that briefly replaced it put a title and two buttons here.
 */
function expectWaitingVeil(): void {
  const veil = screen.getByTestId('session-swap-veil');
  expect(veil.props.accessibilityLabel).toBe(SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL);
  expect(screen.getByTestId('session-swap-veil-empty')).toBeTruthy();
  expect(screen.getByTestId('session-swap-veil-cursor')).toBeTruthy();
  expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'switcher-only' });
  expect(screen.queryByText('Waiting for the desktop')).toBeNull();
}

/** No swap surface: the screen is live, or on its way out. */
function expectNoSwapSurface(): void {
  expect(screen.queryByTestId('session-swap-veil')).toBeNull();
}

/** Runs the clock past SESSION_SWAP_QUIET_MS under fake timers: the long-gap reveal. */
function passQuietDeadline(): void {
  act(() => {
    jest.advanceTimersByTime(SESSION_SWAP_QUIET_MS + 1);
  });
}

/**
 * `clearAllMocks` leaves a queued `mockReturnValueOnce` in place, so a
 * failing Home-fallback test would hand its one-shot `false` to whichever
 * test next asks whether it can go back, and that test would misreport a
 * pop as a replace. Reset the queue and restore the default every time.
 */
function resetRouterMocks(): void {
  jest.clearAllMocks();
  mockCanGoBack.mockReset();
  mockCanGoBack.mockReturnValue(true);
  // The stub's Chat pill goes through onModeChange, which REMEMBERS the
  // task's lens in the settings store; without this a test that visited Chat
  // hands the next test a screen that mounts on Chat, where the waiting veil
  // deliberately does not show.
  useSettingsStore.setState({ preferredSessionLensByTaskId: {} });
}

describe('SessionScreen session binding', () => {
  beforeEach(() => {
    resetRouterMocks();
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
    expectNoSwapSurface();
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
    // A live successor means nothing transitional flashed.
    expectNoSwapSurface();
  });

  /**
   * The full-projection end: the located task reports no session after this
   * screen had one. Quiet first (the veil over the last frame, the footer
   * held and inert), then past the deadline the waiting phase: the same veil
   * over the empty terminal, with the footer still there as the switcher
   * alone. The old ended state hid the footer outright, which left Changes a
   * one-way trip out.
   */
  it('veils, then clears to the empty terminal with the switcher beneath, when the located task loses its session', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      renderSessionScreen();
      expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'full' });

      act(() => {
        seedTaskWithSession(null);
      });
      expectQuietVeilOnly();
      expect(closeSessionScreenMock).toHaveBeenCalledWith('sess-a');
      expect(screen.getByTestId('stub-session-input-bar').props.accessibilityState).toEqual({ disabled: true });

      passQuietDeadline();
      expectWaitingVeil();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A successor that arrives out of the waiting phase paints UNDER the
   * cleared pane: the veil stays up across its bind (with the footer live for
   * it) and lets go on its first paint, so the dead session's frame never
   * flashes between the two.
   */
  it('recovers from the waiting phase when a successor session appears and paints', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      renderSessionScreen();
      act(() => {
        seedTaskWithSession(null);
      });
      passQuietDeadline();
      expectWaitingVeil();

      act(() => {
        seedTaskWithSession('sess-c');
      });

      expect(screen.getByTestId('session-swap-veil')).toBeTruthy();
      expect(screen.getByTestId('session-swap-veil-empty')).toBeTruthy();
      expect(openSessionScreenMock).toHaveBeenCalledWith('sess-c');
      const inputBar = screen.getByTestId('stub-session-input-bar');
      expect(inputBar.props.accessibilityValue).toEqual({ text: 'full' });
      expect(inputBar.props.accessibilityState).toEqual({ disabled: false });

      act(() => {
        useTerminalUiStore.getState().markTerminalPainted('sess-c');
      });

      expectNoSwapSurface();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * Caught by the session-ended-state E2E flow, which went red the moment the
   * 0.9.0 board projection landed. Under `view: 'sessions'` the ended task is
   * filtered out of the board entirely, so `taskLocated` goes false and the
   * board-says-no-session signal above can never fire; reconcileSessionsFromBoards
   * then prunes the activity entry, taking `feedStatus: 'ended'` with it a few
   * hundred milliseconds later. Both signals the screen used to rely on are gone
   * within one round trip of the end, and the ended state appeared and vanished.
   * The end must stay handled through the drop and the prune: quiet until the
   * deadline, then the waiting phase, holding on a later render.
   */
  it('keeps the waiting phase after the sessions projection drops the task and the entry is pruned', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
      renderSessionScreen();
      expect(screen.getByTestId('stub-session-input-bar')).toBeTruthy();

      act(() => {
        pushSessionEnded('sess-a');
      });
      expectQuietVeilOnly();

      // What lands next: the board refetch drops the task, and the reconciler
      // prunes the activity entry behind it.
      act(() => {
        seedBoardWithoutTask();
        useActivityStore.getState().removeSession('sess-a');
      });
      expectQuietVeilOnly();

      passQuietDeadline();
      expectWaitingVeil();

      // A later render of the same shape: still waiting, nothing re-opened.
      act(() => {
        seedBoardWithoutTask();
      });
      expectWaitingVeil();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The same collapse, entered from the board rather than a triage row, so
   * there is no sessionId param either. With the task gone nothing can name
   * the dead session but the binding the screen already made: the quiet
   * window opens off lastBoundSessionId and waits past the deadline.
   */
  it('keeps waiting with no sessionId param to fall back on', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1' };
      seedTaskWithSession('sess-a');
      useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
      renderSessionScreen();
      expectNoSwapSurface();

      act(() => {
        pushSessionEnded('sess-a');
        seedBoardWithoutTask();
        useActivityStore.getState().removeSession('sess-a');
      });
      expectQuietVeilOnly();

      passQuietDeadline();
      expectWaitingVeil();
    } finally {
      jest.useRealTimers();
    }
  });

  it('shows no swap surface for a task that never had a session', () => {
    seedTaskWithSession(null);
    renderSessionScreen();
    expectNoSwapSurface();
    expect(openSessionScreenMock).not.toHaveBeenCalled();
  });

  /**
   * The leave-on-role rule is gated on a BOUND session. The board routes a
   * sessionless task to the edit form, but a stale row can still open this
   * screen on one sitting in To Do, and that must not bounce straight back.
   */
  it('does not leave the screen for a To Do task that never had a session', () => {
    seedTaskWithSession(null, 'lane-todo');
    renderSessionScreen();
    expectNoSwapSurface();
    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('declares the session over when its feed stays rejected past the grace window: the veil, then the wait', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
      renderSessionScreen();

      act(() => {
        useActivityStore.getState().markRejected('sess-a');
      });
      // Inside the grace window: nothing.
      expectNoSwapSurface();

      act(() => {
        jest.advanceTimersByTime(1600);
      });
      expectQuietVeilOnly();

      passQuietDeadline();
      expectWaitingVeil();
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

  /**
   * What the retired card's Move button did is the header's column chip,
   * which never left: it is outside the pane box the veil covers.
   */
  it('keeps the header column chip as the move affordance through the waiting phase', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      renderSessionScreen();
      act(() => {
        seedTaskWithSession(null);
      });
      passQuietDeadline();
      expectWaitingVeil();

      fireEvent.press(screen.getByTestId('task-header-column'));

      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/move-task',
        params: { taskId: 'task-1', projectId: 'project-1' },
      });
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The veil covers the WHOLE pane area, so switching the mode underneath is
   * not enough: an overlay that keeps rendering leaves the user looking at
   * the same panel they just tapped out of. Through the quiet phase the veil
   * yields to Changes only; once the pane has cleared it yields to Chat as
   * well, since the transcript outlives the session and the switcher is how
   * the user gets to it. The footer stays as the switcher alone there (no
   * composer for a dead session).
   *
   * No existing tier catches the covering itself. All three panes are always
   * mounted and only their ACCESSIBILITY visibility flips with the mode, so a
   * "chat is visible" assertion passes while the veil still covers it. It is
   * the exact mirror of the stacking bug the veil's own docblock records:
   * that one was caught because a TAP was swallowed, not because a visibility
   * assert failed.
   */
  it('yields to Chat in the waiting phase, with the switcher alone, and not before', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      renderSessionScreen();
      act(() => {
        seedTaskWithSession(null);
      });
      expectQuietVeilOnly();

      // Through the quiet phase Chat stays covered: the successor lands there.
      fireEvent.press(screen.getByTestId('session-mode-chat'));
      expectQuietVeilOnly();
      fireEvent.press(screen.getByTestId('session-mode-terminal'));

      passQuietDeadline();
      expectWaitingVeil();

      fireEvent.press(screen.getByTestId('session-mode-chat'));

      expectNoSwapSurface();
      // ...and the Chat pane is the one now live behind where it was.
      expect(screen.getByTestId('session-pane-chat').props.accessibilityElementsHidden).toBe(false);
      // The footer stays bound to the session this screen last had (the panes
      // and the footer never unbind while the board reports nothing), as the
      // switcher alone: the way back, and nothing to type into.
      const inputBar = screen.getByTestId('stub-session-input-bar');
      expect(inputBar.props.accessibilityLabel).toBe('chat');
      expect(inputBar.props.accessibilityValue).toEqual({ text: 'switcher-only' });
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The escape above only proves the veil CAN be left - a regression that
   * latched "left" into its own state (rather than deriving showQuietVeil
   * from `mode` alone) would pass it just as well. Round-tripping the mode
   * back to terminal is what actually exercises the derivation. Via the
   * desktop-ended push (session_id stays 'sess-a'), the route a real park
   * takes.
   */
  it('brings the waiting veil back once the mode returns to terminal', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      renderSessionScreen();
      act(() => {
        pushSessionEnded('sess-a');
      });
      passQuietDeadline();
      expectWaitingVeil();

      fireEvent.press(screen.getByTestId('session-mode-chat'));
      expectNoSwapSurface();

      fireEvent.press(screen.getByTestId('session-mode-terminal'));

      expectWaitingVeil();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * Under the sessions projection an ended task is dropped from the board, so
   * MoveTaskScreen could not locate it either: the header chip hides while
   * Chat stays reachable (the transcript outlives the session).
   */
  it('has no move affordance once the sessions projection dropped the task, and still reaches Chat', () => {
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

      expectWaitingVeil();
      expect(screen.queryByTestId('task-header-column')).toBeNull();

      fireEvent.press(screen.getByTestId('session-mode-chat'));
      expectNoSwapSurface();
      expect(screen.getByTestId('session-pane-chat').props.accessibilityElementsHidden).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The regression the paired `session-ended-state` flow caught and every
   * required check missed.
   *
   * When the pager became absolutely-positioned siblings, the panes gained
   * `zIndex: 1` while the overlay had none - so the visible pane stacked
   * ABOVE it. On device, the title bled through the gaps between transcript
   * cards and BOTH overlay buttons were dead, because React Native hands a
   * tap to the topmost view rather than letting it fall through to an
   * occluded sibling.
   *
   * No `fireEvent.press` test can see this. `fireEvent` invokes the handler
   * directly and never consults hit testing, which is exactly why the press
   * tests above stayed green all the way through the bug. The closest a JS
   * tier can get is asserting the MECHANISM - that the overlay outranks the
   * visible pane - so that is what this does. The real proof stays the paired
   * Maestro flow.
   */
  it('stacks the waiting veil above the visible pane, so nothing under it can be tapped', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      renderSessionScreen();
      act(() => {
        seedTaskWithSession(null);
      });
      passQuietDeadline();
      expectWaitingVeil();

      const overlayZIndex = StyleSheet.flatten(screen.getByTestId('session-swap-veil').props.style)?.zIndex;
      // Terminal is the default mode, so that is the pane carrying paneVisible.
      //
      // `includeHiddenElements` because the assertion is about STACKING, and
      // the pane is deliberately hidden from the accessibility tree while an
      // overlay covers it (SessionScreen's overlayCoversPanes). It is still
      // mounted and still painting underneath, which is the whole reason the
      // zIndex contest it is in here matters.
      const visiblePaneZIndex = StyleSheet.flatten(
        screen.getByTestId('session-pane-terminal', { includeHiddenElements: true }).props.style,
      )?.zIndex;

      // Both must be real numbers: an undefined zIndex on either side is the
      // bug (an implicit auto lost the contest), not a passing comparison.
      expect(typeof overlayZIndex).toBe('number');
      expect(typeof visiblePaneZIndex).toBe('number');
      expect(overlayZIndex).toBeGreaterThan(visiblePaneZIndex);
    } finally {
      jest.useRealTimers();
    }
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
    resetRouterMocks();
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
   * means "no successor is coming" and quietly disable the whole window. The
   * task starts in a WORKING column: a To Do task with a bound session leaves
   * the screen at once (a move there is a reset), so the old To Do default
   * would have popped every test here before it began.
   */
  function seedRoledBoard(sessionId: string | null, swimlaneId = 'lane-doing'): void {
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

  it('enters the waiting phase, not a verdict, once a move outlives the quiet window', () => {
    jest.useFakeTimers();
    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();

      // The user confirms the move: the card lands in the new column at once.
      act(() => {
        moveTaskToColumn('lane-review');
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

      expectWaitingVeil();
      // The switcher is still there beneath the veil, on the same lens; only
      // the keys are gone.
      expect(screen.getByTestId('stub-session-input-bar').props.accessibilityLabel).toBe('terminal');
      // And the pane under the cleared veil is HIDDEN, not just covered: a
      // dead session's page keeps the WebView painting at the full frame
      // rate for as long as the pane is drawn (measured, see SessionScreen).
      expect(
        StyleSheet.flatten(screen.getByTestId('session-pane-terminal', { includeHiddenElements: true }).props.style)
          .opacity,
      ).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A swap can hold the screen for a long time on a slow machine, and the
   * work so far is still readable in the diff - so the switcher beneath the
   * veil is the way to Changes, the veil yields to it, and the mode pill
   * brings it back.
   */
  it('lets the user out to Changes from under the waiting veil, and brings it back with the mode pill', () => {
    jest.useFakeTimers();
    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();
      act(() => {
        moveTaskToColumn('lane-review');
      });
      act(() => {
        pushSessionEnded('sess-a');
      });
      passQuietDeadline();
      expectWaitingVeil();

      fireEvent.press(screen.getByTestId('session-mode-changes'));

      expectNoSwapSurface();
      expect(screen.getByTestId('session-pane-changes').props.accessibilityElementsHidden).toBe(false);
      // Still bound to the outgoing session, so the pill is the way back - and
      // going back to terminal must bring the veil with it.
      expect(screen.getByTestId('stub-session-input-bar').props.accessibilityLabel).toBe('changes');

      fireEvent.press(screen.getByTestId('session-mode-terminal'));

      expectWaitingVeil();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A successor that binds out of the waiting phase paints under the CLEARED
   * pane: the veil and its empty layer stay up across the bind (the footer
   * comes alive for the successor), and let go on the first paint. Letting
   * go at the bind is what would flash the dead session's frame.
   */
  it('keeps the cleared pane under the veil across a late bind, and lets go on the paint', () => {
    jest.useFakeTimers();
    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();
      act(() => {
        moveTaskToColumn('lane-review');
      });
      act(() => {
        pushSessionEnded('sess-a');
      });
      passQuietDeadline();
      expectWaitingVeil();

      // The desktop spawned the successor and the settled snapshot carries it.
      act(() => {
        seedRoledBoard('sess-b', 'lane-review');
      });

      expect(screen.getByTestId('session-swap-veil')).toBeTruthy();
      expect(screen.getByTestId('session-swap-veil-empty')).toBeTruthy();
      expect(openSessionScreenMock).toHaveBeenCalledWith('sess-b');
      const inputBar = screen.getByTestId('stub-session-input-bar');
      expect(inputBar.props.accessibilityValue).toEqual({ text: 'full' });
      expect(inputBar.props.accessibilityState).toEqual({ disabled: false });
      // The pane comes back at the bind, under the still-cleared veil, so the
      // successor's seed can paint and lift it.
      expect(
        StyleSheet.flatten(screen.getByTestId('session-pane-terminal', { includeHiddenElements: true }).props.style)
          .opacity,
      ).toBe(1);

      act(() => {
        useTerminalUiStore.getState().markTerminalPainted('sess-b');
      });

      expectNoSwapSurface();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * The bound-but-unpainted bound, restarted from the bind: a successor that
   * binds out of the waiting phase and then paints nothing (an agent that has
   * printed nothing) is uncovered SESSION_SWAP_QUIET_MS after its bind, as
   * one that bound inside the quiet phase would be. Never forever.
   */
  it('uncovers a late successor that never paints, one quiet window after its bind', () => {
    jest.useFakeTimers();
    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();
      act(() => {
        pushSessionEnded('sess-a');
      });
      passQuietDeadline();
      expectWaitingVeil();

      act(() => {
        jest.advanceTimersByTime(30_000);
        seedRoledBoard('sess-b', 'lane-doing');
      });
      expect(screen.getByTestId('session-swap-veil')).toBeTruthy();

      act(() => {
        jest.advanceTimersByTime(SESSION_SWAP_QUIET_MS - 1);
      });
      expect(screen.getByTestId('session-swap-veil')).toBeTruthy();

      act(() => {
        jest.advanceTimersByTime(2);
      });
      expectNoSwapSurface();
      expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'full' });
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * There used to be a 20 s fallback here, from "Switching session" to
   * "Session ended": the phone changing its verdict on a clock, for a
   * question it cannot answer from here. The wait now has no clock at all:
   * nothing changes at 20 s, or ever, until the desktop reports a session.
   */
  it('keeps waiting past the old 20 s fallback, never changing its verdict on a clock', () => {
    jest.useFakeTimers();
    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();
      act(() => {
        moveTaskToColumn('lane-review');
      });
      act(() => {
        pushSessionEnded('sess-a');
      });
      passQuietDeadline();
      expectWaitingVeil();

      act(() => {
        jest.advanceTimersByTime(20_001 - (SESSION_SWAP_QUIET_MS + 1));
      });
      expectWaitingVeil();

      act(() => {
        jest.advanceTimersByTime(60_000);
      });
      expectWaitingVeil();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * A move to To Do is a full reset - the session is killed and the worktree
   * removed - so there is no successor to wait for and no card would be
   * honest. The screen goes back to where the task was opened from, the
   * instant the move is confirmed (the optimistic write), before any push.
   * `boardColumnFixture` defaults to the todo role.
   */
  it('leaves the screen for a move to the To Do column', () => {
    seedRoledBoard('sess-a');
    renderSessionScreen();
    expect(mockBack).not.toHaveBeenCalled();

    act(() => {
      moveTaskToColumn('lane-todo');
    });

    expect(mockBack).toHaveBeenCalledTimes(1);
    expectNoSwapSurface();

    // The end that follows changes nothing: no veil over the exit, no card.
    act(() => {
      pushSessionEnded('sess-a');
    });
    expectNoSwapSurface();
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  /**
   * The mirror case: a move to a Done-role column also promises no successor
   * (the task is archived and its worktree deleted). Never the completed-task
   * view: a move the user just confirmed is not a reason to push a screen at
   * them. A desktop-made move lands the same way (the archive tests below).
   */
  it('leaves the screen for a move to the Done column, never to the completed-task view', () => {
    seedRoledBoard('sess-a');
    renderSessionScreen();

    act(() => {
      moveTaskToColumn('lane-done');
    });
    act(() => {
      pushSessionEnded('sess-a');
    });

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    expectNoSwapSurface();
  });

  /**
   * A move that was already veiled (the move opener, on the live session)
   * followed by a move to Done before the end came: the veil must not stay
   * over a screen on its way out. The window is still open internally (it
   * closes unspent at its own deadline); the leave hides it.
   */
  it('drops the veil when a veiled move is followed by a move to Done', () => {
    seedRoledBoard('sess-a');
    renderSessionScreen();
    act(() => {
      moveTaskToColumn('lane-review');
    });
    expectQuietVeilOnly();

    act(() => {
      moveTaskToColumn('lane-done');
    });

    expectNoSwapSurface();
    expect(mockBack).toHaveBeenCalledTimes(1);
  });

  /** A cold start straight onto this route (a notification tap) has nothing behind it. */
  it('falls back to Home when there is nothing to go back to', () => {
    mockCanGoBack.mockReturnValueOnce(false);
    seedRoledBoard('sess-a');
    renderSessionScreen();

    act(() => {
      moveTaskToColumn('lane-done');
    });

    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).toHaveBeenCalledWith('/');
  });

  /**
   * Done deletes the worktree and archives the task, so the session screen has
   * nowhere good to stand: a waiting card would wait for nothing, and Changes
   * would show a diff read-diff answers from the PROJECT checkout. A move
   * made on the DESKTOP under the sessions projection shows up here only as
   * the task leaving the snapshot and landing in the archive, so the archive
   * is what sends the screen back - to where the task was opened from, never
   * to the completed-task view.
   */
  it('leaves the screen once the archive claims the task', () => {
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

    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
    expectNoSwapSurface();
  });

  /**
   * The first look is legitimately too early. The end reaches the phone while
   * the task is still on the board, seconds before the desktop archives
   * anything (if it is going to at all), so that page comes back without it.
   * A plain "fetched once" guard would then never look again and the screen
   * would sit under the waiting card for a task that completed.
   */
  it('asks for the archive again once the task actually leaves the board', () => {
    seedRoledBoard('sess-a');
    renderSessionScreen();
    expect(loadArchivedTasksMock).not.toHaveBeenCalled();

    // The end lands while the task is still located: the first look.
    act(() => {
      pushSessionEnded('sess-a');
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
   * live resolvers and the eventual leave, not the raw call count.
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

      // The `:located` key's fetch: the end lands while the task is still on
      // the board.
      act(() => {
        pushSessionEnded('sess-a');
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
      expect(mockBack).not.toHaveBeenCalled();

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

      await waitFor(() => expect(mockBack).toHaveBeenCalledTimes(1));
      expect(mockReplace).not.toHaveBeenCalled();
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
        pushSessionEnded('sess-a');
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

  it('does not leave a task that is still on the board because of a stale archive page', () => {
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

    expect(mockBack).not.toHaveBeenCalled();
    expect(mockReplace).not.toHaveBeenCalled();
    // The end is handled as any swap is: quietly, on the board.
    expectQuietVeilOnly();
  });

  /**
   * A SAME-COLUMN respawn (a model/agent/effort change, an isolated-session-
   * track switch) has no column move to key anything off: the desktop's
   * `session-ended` push carries an in-flight spawnProgressLabel (kangentic
   * board #639) naming the phase, and nothing else changes. The label used to
   * open a second, session-keyed latch that chose "Switching session" over
   * "Session ended" at the reveal. With one wait for every case the label
   * opens nothing and is rendered nowhere; what these pin is that a labelled
   * end behaves exactly like an unlabelled one on this screen.
   *
   * All tasks below stay in 'lane-doing' (role null, from seedRoledBoard) and
   * never call moveTaskToColumn.
   */
  describe('a same-column respawn (spawnProgressLabel, no column move)', () => {
    it('enters the waiting phase once a labelled swap outlives the quiet window', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();

        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
        });
        expectQuietVeilOnly();

        passQuietDeadline();

        expectWaitingVeil();
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * The label is untrusted display text that no surface renders any more,
     * well-formed or not. Before the deadline the veil carries no text at
     * all; after it there is still nothing to read, whatever the label was.
     */
    it.each([
      ['a well-formed label', 'Switching model...'],
      ['an over-cap label', 'A'.repeat(46)],
    ])('never renders %s, before or after the deadline', (_shape, label) => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();

        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: label });
        });
        expect(screen.queryByText(label)).toBeNull();

        passQuietDeadline();

        expectWaitingVeil();
        expect(screen.queryByText(label)).toBeNull();
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * A desktop that predates spawnProgressLabel (or a genuine park with no
     * successor coming) sends no label, and the screen cannot tell the two
     * apart from here: the same veil, then the same wait.
     */
    it('goes quiet, then waits the same way, when the desktop sends no label', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();

        act(() => {
          pushSessionEnded('sess-a');
        });
        expectQuietVeilOnly();

        passQuietDeadline();

        expectWaitingVeil();
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps waiting past the old 20 s fallback for a labelled end', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();
        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching agent...' });
        });
        passQuietDeadline();
        expectWaitingVeil();

        act(() => {
          jest.advanceTimersByTime(20_001 - (SESSION_SWAP_QUIET_MS + 1));
        });

        expectWaitingVeil();
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * The waiting phase is a fact about the window, not something re-derived
     * per render: a board re-snapshot at the same shape well after the
     * deadline must neither drop it back to the quiet phase (the dead frame
     * returning under the scrim) nor announce it a second time.
     */
    it('holds the waiting phase across a render well after the deadline, announcing it once', () => {
      const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
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
        expectWaitingVeil();
        expect(announceSpy.mock.calls.map((call) => call[0])).toEqual([
          SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL,
          SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL,
        ]);

        // Advance well past the deadline again and force a render (a board
        // re-snapshot at the same shape).
        act(() => {
          jest.advanceTimersByTime(20_000);
          seedRoledBoard('sess-a', 'lane-doing');
        });

        expectWaitingVeil();
        expect(announceSpy).toHaveBeenCalledTimes(2);
      } finally {
        jest.useRealTimers();
        announceSpy.mockRestore();
      }
    });

    it('keeps the cleared pane under the veil across a late bind, and lets go on the paint', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();
        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Starting new session...' });
        });
        passQuietDeadline();
        expectWaitingVeil();

        // The desktop spawned the successor and the settled snapshot carries
        // it, still in the same column - no move involved.
        act(() => {
          seedRoledBoard('sess-b', 'lane-doing');
        });

        expect(screen.getByTestId('session-swap-veil')).toBeTruthy();
        expect(screen.getByTestId('session-swap-veil-empty')).toBeTruthy();
        expect(openSessionScreenMock).toHaveBeenCalledWith('sess-b');

        act(() => {
          useTerminalUiStore.getState().markTerminalPainted('sess-b');
        });

        expectNoSwapSurface();
      } finally {
        jest.useRealTimers();
      }
    });

    it('leaves the screen rather than veiling, for an archived task', () => {
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

      expectNoSwapSurface();
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(mockReplace).not.toHaveBeenCalled();
    });

    /**
     * Entered from the board rather than a triage row (no sessionId param),
     * so the end has to be resolved off lastBoundSessionId - the same
     * fallback the ended signal itself relies on once the task is off the
     * board.
     */
    it('enters the waiting phase off lastBoundSessionId with no sessionId param', () => {
      jest.useFakeTimers();
      try {
        mockParams = { taskId: 'task-1', projectId: 'project-1' };
        seedRoledBoard('sess-a', 'lane-doing');
        useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
        renderSessionScreen();
        expectNoSwapSurface();

        act(() => {
          pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
        });
        expectQuietVeilOnly();
        passQuietDeadline();

        expectWaitingVeil();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  /**
   * A labelled end landing only AFTER the column latch has run out and been
   * marked spent. The label used to open a latch of its own here; now the
   * end alone opens the quiet window (nothing had spent it), and the wait
   * goes on past its deadline. The column latch's expiry is invisible.
   */
  it('veils and then waits for a labelled end that arrives after the column latch already expired', () => {
    jest.useFakeTimers();
    try {
      seedRoledBoard('sess-a');
      renderSessionScreen();

      // The move: the column latch arms and the veil opens on the live
      // session, then drops at its own deadline with the session still up.
      act(() => {
        moveTaskToColumn('lane-review');
      });
      expectQuietVeilOnly();
      act(() => {
        jest.advanceTimersByTime(20_001);
      });
      expectNoSwapSurface();

      // Only NOW does the labelled ended push arrive.
      act(() => {
        pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
      });
      expectQuietVeilOnly();
      passQuietDeadline();

      expectWaitingVeil();
    } finally {
      jest.useRealTimers();
    }
  });

  /**
   * THE QUIET WINDOW. Every swap kind - a column move, a same-column respawn
   * with a label, an unlabelled end - opens ONE silent surface over the last
   * frame, holds it across the successor's bind, and lets go only once the
   * successor has painted. The card the blocks above pin is the long-gap
   * reveal, past SESSION_SWAP_QUIET_MS.
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

      expectNoSwapSurface();

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

        // No veil, and no card either: sessionEnded is false for the
        // successor, so nothing can claim the session is over.
        expectNoSwapSurface();
        const inputBar = screen.getByTestId('stub-session-input-bar');
        expect(inputBar.props.accessibilityLabel).toBe('terminal');
        expect(inputBar.props.accessibilityState).toEqual({ disabled: false });
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * A -> B -> C: the successor dies before it paints. The window re-keys to
     * B and its deadline restarts, so the reveal comes SESSION_SWAP_QUIET_MS
     * after B's end, not after A's.
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

        // Past B's deadline: the wait.
        act(() => {
          jest.advanceTimersByTime(4_000);
        });
        expectWaitingVeil();
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
     * THE MOVE OPENER. The board reports a column move seconds before the
     * session ends (the desktop interrupts the agent and waits for a running
     * tool first; measured at eight seconds once). The veil opens on the move
     * itself, on the live session, and the end keeps the same window open.
     * The deadline counts from the END: a move that took seven seconds to end
     * still gets its full quiet window after the end.
     */
    it('opens the veil on the column move itself and counts the deadline from the end that follows', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();
        expect(screen.queryByTestId('session-swap-veil')).toBeNull();

        act(() => {
          moveTaskToColumn('lane-review');
        });
        // Live session, veiled already, footer held and inert.
        expectQuietVeilOnly();
        expect(screen.getByTestId('stub-session-input-bar').props.accessibilityState).toEqual({ disabled: true });

        act(() => {
          jest.advanceTimersByTime(SESSION_SWAP_QUIET_MS - 1000);
        });
        act(() => {
          pushSessionEnded('sess-a');
        });
        expectQuietVeilOnly();

        // Seven seconds after the move but only one after the end: still quiet.
        act(() => {
          jest.advanceTimersByTime(SESSION_SWAP_QUIET_MS - 1000);
        });
        expectQuietVeilOnly();

        act(() => {
          jest.advanceTimersByTime(1001);
        });
        expectWaitingVeil();
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * A move whose end never comes inside the window is still a live session
     * worth reading: the veil drops without the window being spent, the
     * footer comes back, and the end that eventually arrives opens a full
     * window of its own rather than finding its session already used up.
     */
    it('drops the veil when a move outlives the window with the session still alive, and re-veils on the end', () => {
      jest.useFakeTimers();
      try {
        seedRoledBoard('sess-a', 'lane-doing');
        renderSessionScreen();
        act(() => {
          moveTaskToColumn('lane-review');
        });
        expectQuietVeilOnly();

        passQuietDeadline();
        expectNoSwapSurface();
        expect(screen.getByTestId('stub-session-input-bar').props.accessibilityState).toEqual({ disabled: false });

        act(() => {
          pushSessionEnded('sess-a');
        });
        expectQuietVeilOnly();

        passQuietDeadline();
        expectWaitingVeil();
      } finally {
        jest.useRealTimers();
      }
    });

    /**
     * The other half of the veil's accessibility story: a screen reader user
     * who heard the wait begin also hears it end on a settle, and hears the
     * wait change shape at the deadline (the pane cleared, still nothing to
     * read), which is the one thing the deadline says out loud.
     */
    it('announces the wait over when the successor settles, and the waiting phase at the deadline', () => {
      const announceSpy = jest.spyOn(AccessibilityInfo, 'announceForAccessibility');
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
        act(() => {
          useTerminalUiStore.getState().markTerminalPainted('sess-b');
        });
        expect(announceSpy.mock.calls.map((call) => call[0])).toEqual(['Switching session, please wait', 'Session ready']);

        // A second swap that stalls: the deadline clears the pane and says so.
        act(() => {
          pushSessionEnded('sess-b');
        });
        passQuietDeadline();
        expectWaitingVeil();
        expect(announceSpy.mock.calls.map((call) => call[0])).toEqual([
          'Switching session, please wait',
          'Session ready',
          'Switching session, please wait',
          SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL,
        ]);
      } finally {
        jest.useRealTimers();
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
     * Under the sessions projection with a nav param, "suspended" is the
     * footer pointing at the session whose end opened the window - never
     * derived from the resolved sessionId, which the param used to keep on the
     * dead id for the gap and which now resolves to null there (the next test).
     */
    it('suspends the footer while it points at the dead session, whatever the param resolves to', () => {
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

    /**
     * The route param is a snapshot of the world when the user tapped, and it
     * bridges only the gap before the FIRST board snapshot. The sessions
     * projection drops the task for the whole of every later swap, and
     * re-trusting the param there rebinds the session the screen was opened
     * with - by the second swap a dead one. Seen on the release build
     * (2026-09-18): a Planning-to-Executing move re-subscribed the very first
     * session's stream and re-keyed the quiet window to it, a second `ended`
     * trace line 29 ms after the real one. Once located, the drop resolves to
     * null like the full projection's sessionless task; the panes keep the
     * last bound session either way.
     */
    it('never rebinds the param session once the board has located the task and the sessions projection drops it', () => {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a', projectId: 'project-1' };
      seedRoledBoard('sess-a', 'lane-doing');
      useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
      renderSessionScreen();
      expect(openSessionScreenMock).toHaveBeenCalledTimes(1);
      expect(openSessionScreenMock).toHaveBeenCalledWith('sess-a');

      // First swap: sess-a dies, sess-b binds and paints.
      act(() => {
        pushSessionEnded('sess-a');
        seedRoledBoard('sess-b', 'lane-doing');
        useActivityStore.getState().registerSession('sess-b', 'task-1', 'project-1');
      });
      act(() => {
        useTerminalUiStore.getState().markTerminalPainted('sess-b');
      });
      expect(screen.queryByTestId('session-swap-veil')).toBeNull();
      expect(openSessionScreenMock).toHaveBeenCalledTimes(2);

      // Second swap under the sessions projection: sess-b dies and the task
      // leaves the snapshot. The param still names sess-a.
      act(() => {
        pushSessionEnded('sess-b');
        seedBoardWithoutTask();
      });

      expectQuietVeilOnly();
      // The dead binding closes like the full projection's; the corpse in the
      // param is never reopened.
      expect(closeSessionScreenMock).toHaveBeenCalledWith('sess-b');
      expect(openSessionScreenMock).toHaveBeenCalledTimes(2);
      expect(
        screen.getByTestId('stub-terminal-tab', { includeHiddenElements: true }).props.accessibilityLabel,
      ).toBe('sess-b');
    });
  });

  /**
   * An end landing with the task ALREADY in Done or To Do (the column
   * branch's exclusions, now a leave): no veil over the exit, no card, and a
   * label on the push changes nothing. The task is seeded in a working column
   * and moved, so the leave fires the way it does on the phone.
   */
  describe('an end that lands with the task already in Done or To Do', () => {
    it.each([
      ['To Do', 'lane-todo'],
      ['Done', 'lane-done'],
    ])('leaves rather than veils when a labelled end lands with the task in %s', (_column, swimlaneId) => {
      seedRoledBoard('sess-a');
      renderSessionScreen();

      act(() => {
        moveTaskToColumn(swimlaneId);
      });
      act(() => {
        pushSessionEnded('sess-a', { spawnProgressLabel: 'Switching model...' });
      });

      expectNoSwapSurface();
      expect(screen.queryByText('Switching model...')).toBeNull();
      expect(mockBack).toHaveBeenCalledTimes(1);
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
    resetRouterMocks();
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
