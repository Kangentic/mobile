import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { BoardTaskWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { SessionScreen } from '@/screens/task/SessionScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useResumeStore } from '@/state/resumeStore';
import { useSettingsStore } from '@/state/settingsStore';
import { boardColumnFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { closeSessionScreen, openSessionScreen, resumeTaskSession } from '@/connection/actions';
import {
  getOpenNotificationSurfaces,
  subscribeToOpenedNotificationSurfaces,
  type NotificationSurface,
} from '@/notifications/notificationSignals';
import { workflowWireFixture } from '../helpers/workflows';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockRouter = { replace: jest.fn(), back: jest.fn(), push: jest.fn(), canGoBack: jest.fn(() => true) };
// Whether the screen is the focused route. Focused by default (the beforeEach
// blocks reset it), so a test that never touches it sees the screen as it always
// was: focused for its whole life. `mockSetFocused` is the test's stand-in for a
// route being pushed over the session (false) and popped off again (true).
let mockIsFocused = true;
const mockFocusListeners = new Set<() => void>();
function mockSetFocused(nextFocused: boolean): void {
  mockIsFocused = nextFocused;
  mockFocusListeners.forEach((listener) => listener());
}
jest.mock('expo-router', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  return {
    useLocalSearchParams: () => ({ taskId: 'task-1', sessionId: 'sess-1', projectId: 'project-1', mode: 'terminal' }),
    useRouter: () => mockRouter,
    // The real one throws outside a navigator. It runs the effect while the
    // route is focused, runs its cleanup on blur, and runs it again when focus
    // returns, which is all the screen's focus effects depend on.
    useFocusEffect: (effect: () => void | (() => void)) => {
      const [focused, setFocused] = ReactModule.useState(mockIsFocused);
      ReactModule.useEffect(() => {
        const onFocusChange = (): void => setFocused(mockIsFocused);
        mockFocusListeners.add(onFocusChange);
        return () => {
          mockFocusListeners.delete(onFocusChange);
        };
      }, []);
      ReactModule.useEffect(() => {
        if (!focused) return undefined;
        return effect();
      }, [effect, focused]);
    },
  };
});

jest.mock('@/connection/actions', () => ({
  openSessionScreen: jest.fn(),
  closeSessionScreen: jest.fn(),
  moveTaskOptimistic: jest.fn().mockResolvedValue(undefined),
  loadArchivedTasks: jest.fn().mockResolvedValue(undefined),
  setDiffWatch: jest.fn(),
  resumeTaskSession: jest.fn().mockResolvedValue({ phase: 'resuming', startedAt: 0 }),
}));

// The panes are heavy and beside the point: this suite is about what the
// terminal lens and the footer show for a paused session.
jest.mock('@/screens/task/ChatPane', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return { __esModule: true, ChatPane: () => <View testID="stub-chat-pane" /> };
});
jest.mock('@/screens/task/ChangesTab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return { __esModule: true, ChangesTab: () => <View testID="stub-changes-tab" /> };
});
jest.mock('@/screens/task/TerminalTab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    // Records `fitLayoutIsReference` (always passed as a boolean by the screen) so the
    // terminal lens's half of the paused layout is visible here.
    TerminalTab: (props: { fitLayoutIsReference?: boolean }) => (
      <View testID="stub-terminal-tab" accessibilityValue={{ text: `fit-layout-is-reference-${String(props.fitLayoutIsReference)}` }} />
    ),
  };
});
// Records whether the quick keys show, so the footer's half of the paused layout is visible here:
// hidden by `quickKeysHidden` (the Resume panel) or by `switcherOnly` (a wait with no live PTY).
// Also records the footer's `notice` (as the hint), and carries a Chat button standing in for the
// switcher, since the route pins the terminal lens.
jest.mock('@/screens/task/SessionInputBar', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { Pressable, View } = require('react-native');
  return {
    __esModule: true,
    SessionInputBar: (props: {
      quickKeysHidden?: boolean;
      switcherOnly?: boolean;
      notice?: string | null;
      onModeChange: (mode: 'terminal' | 'chat' | 'changes') => void;
    }) => (
      <View
        testID="stub-session-input-bar"
        accessibilityValue={{ text: props.quickKeysHidden === true || props.switcherOnly === true ? 'keys-hidden' : 'keys-shown' }}
        accessibilityHint={props.notice ?? undefined}
      >
        <Pressable testID="stub-mode-chat" onPress={() => props.onModeChange('chat')} />
      </View>
    ),
  };
});

const resumeTaskSessionMock = resumeTaskSession as jest.Mock;
const openSessionScreenMock = openSessionScreen as jest.Mock;
const closeSessionScreenMock = closeSessionScreen as jest.Mock;

/**
 * `sessionId: null` is the board's report once the desktop has paused the
 * task: it clears the task's `session_id`. `resumable` is the board row's
 * Resume gate (protocol 0.16.0), `spawnProgress` its preparing label, and
 * `workflow` the workflow the task belongs to (protocol 0.21.0).
 */
function seedBoard({
  sessionId = 'sess-1',
  resumable = false,
  spawnProgress = null,
  workflow = null,
}: { sessionId?: string | null; resumable?: boolean; spawnProgress?: string | null; workflow?: BoardTaskWire['workflow'] } = {}): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture(), boardColumnFixture({ id: 'lane-review', name: 'Code Review', role: null, position: 1 })],
        tasksById: {
          'task-1': boardTaskFixture({
            id: 'task-1',
            session_id: sessionId,
            swimlane_id: 'lane-review',
            resumable,
            spawn_progress: spawnProgress,
            workflow,
          }),
        },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
        commandTerminals: [],
        commandTerminalsOffered: false,
      },
    },
    pendingMoves: [],
  });
}

/**
 * A paused session the screen holds a stream on, as a 0.16.0 desktop reports
 * it: the board row still names it and carries the authoritative `resumable`
 * (the idle-timeout suspend's shape), and the subscribe snapshot carries the
 * stream's copy.
 */
function seedPausedSession({ resumable, workflow = null }: { resumable: boolean; workflow?: BoardTaskWire['workflow'] }): void {
  seedBoard({ resumable, workflow });
  useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
  useActivityStore
    .getState()
    .applySnapshot(
      'sess-1',
      'task-1',
      'project-1',
      streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'suspended', resumable }),
    );
}

async function renderSessionScreen(): Promise<void> {
  await render(
    <ThemeProvider>
      <SessionScreen />
    </ThemeProvider>,
  );
}

describe('SessionScreen Resume (a paused session)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFocused = true;
    mockFocusListeners.clear();
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useResumeStore.setState({ byTaskId: {} });
    // A lens switch is remembered per task; without this, one test's switch
    // would mount every later test on that lens.
    useSettingsStore.setState({ preferredSessionLensByTaskId: {} });
    seedBoard();
  });

  it('shows the desktop\'s Resume session button in place of the terminal, and drops the quick keys', async () => {
    seedPausedSession({ resumable: true });
    await renderSessionScreen();

    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();
    expect(screen.getByText('Resume session')).toBeTruthy();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'keys-hidden' });

    await act(async () => {
      await fireEvent.press(screen.getByTestId('session-resume-button'));
    });
    expect(resumeTaskSessionMock).toHaveBeenCalledWith('task-1', 'project-1');
  });

  /**
   * The gate. A desktop that does not mark the session resumable answers
   * `start-session` by re-running the column's automations, so there the
   * phone offers no Resume at all, on any surface, rather than a different one.
   */
  it('offers no Resume for a paused session the desktop does not mark resumable', async () => {
    seedPausedSession({ resumable: false });
    await renderSessionScreen();

    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(screen.queryByTestId('task-header-resume')).toBeNull();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'keys-shown' });
  });

  /**
   * Protocol 0.21.0. The desktop refuses to resume ONE task of a paused
   * workflow, so the panel the screen draws for such a task holds View workflow
   * in place of Resume (design screen 5). The hook and the panel are pinned on
   * their own (useResumeOffer, ResumePanel); this is the screen's wiring of the
   * two: that the panel is shown at all when the hook offers no Resume, and that
   * the hook's `pausedWorkflow` reaches it. The workflow's home project is
   * deliberately not the screen's, so a push that carried the route's own
   * project would not pass.
   *
   * Mutations seen failing: `resumePanelShown = resumeOffer.offered &&
   * projectId !== null` (the gate without `|| resumeOffer.pausedWorkflow !==
   * null`): the panel itself vanished ("Unable to find an element with testID:
   * session-resume-panel", keys-shown in the dump). And `<ResumePanel>` without
   * its `pausedWorkflow` prop: the Resume button drew in the panel ("expect(
   * received).toBeNull()" on `session-resume-button`).
   */
  it('shows View workflow in the panel, not Resume, for a task of a paused workflow, and opens it on its home project', async () => {
    seedPausedSession({
      resumable: true,
      workflow: workflowWireFixture({ id: 'workflow-9', project_id: 'project-home', state: 'paused' }),
    });
    await renderSessionScreen();

    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();
    expect(screen.queryByTestId('session-resume-button')).toBeNull();
    expect(screen.getByTestId('session-view-workflow')).toBeTruthy();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'keys-hidden' });

    await fireEvent.press(screen.getByTestId('session-view-workflow'));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/workflow',
      params: { workflowId: 'workflow-9', projectId: 'project-home' },
    });
    expect(resumeTaskSessionMock).not.toHaveBeenCalled();
  });

  it('reads "Resuming agent..." with a spinner, and takes no second tap, while the resume runs', async () => {
    seedPausedSession({ resumable: true });
    useResumeStore.getState().markResuming('task-1', Date.now());
    await renderSessionScreen();

    expect(screen.getByText('Resuming agent...')).toBeTruthy();
    expect(screen.getByTestId('session-resume-spinner')).toBeTruthy();
    expect(screen.getByTestId('session-resume-button').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
  });

  it.each([
    ['the desktop\'s failure line when no reason came back', null, 'Session could not be resumed.'],
    ['the desktop\'s own refusal text when it sent one', 'Cannot resume a task in To Do', 'Cannot resume a task in To Do'],
  ])('shows %s under a live button after a failed resume', async (_case, message, expected) => {
    seedPausedSession({ resumable: true });
    useResumeStore.getState().markFailed('task-1', message);
    await renderSessionScreen();

    expect(screen.getByTestId('session-resume-error').props.children).toBe(expected);
    expect(screen.getByText('Resume session')).toBeTruthy();
    expect(screen.getByTestId('session-resume-button').props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
  });

  /**
   * A desktop resume never revives the paused session: it ends it, with the
   * desktop's resume label, and binds a successor. The label reads as
   * preparing, never as paused, so the panel gives way - but the attempt runs
   * ON through the label. The desktop reports a failed spawn only by clearing
   * that label with nothing bound, and an attempt dropped at the label could
   * not be failed then: it handed back a fresh Resume button and no error.
   */
  it('gives way, and keeps the attempt running, when the paused session ends into its resume', async () => {
    seedPausedSession({ resumable: true });
    useResumeStore.getState().markResuming('task-1', Date.now());
    await renderSessionScreen();
    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();

    await act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 'Resuming session...' },
      });
    });

    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(useResumeStore.getState().byTaskId['task-1']?.phase).toBe('resuming');
  });

  /** Once a session holds the task the attempt is over, whichever lens is showing. */
  it('ends a running attempt once the task reads as running', async () => {
    seedPausedSession({ resumable: true });
    useResumeStore.getState().markResuming('task-1', Date.now());
    await renderSessionScreen();

    await act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'status', status: 'running', resuming: true, resumable: false },
      });
    });

    expect(useResumeStore.getState().byTaskId['task-1']).toBeUndefined();
  });

  /**
   * The terminal lens shows a failed Resume's line in its panel; the other
   * lenses carry it in the footer. A Resume pressed from the header while on
   * Chat used to fail with nothing on screen but the play button coming back.
   */
  it('carries a failed Resume\'s line in the footer off the terminal lens, and only there', async () => {
    seedPausedSession({ resumable: true });
    useResumeStore.getState().markFailed('task-1', null);
    await renderSessionScreen();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityHint).toBeUndefined();

    await fireEvent.press(screen.getByTestId('stub-mode-chat'));

    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityHint).toBe('Session could not be resumed.');
  });

  /**
   * A FAILED attempt clears the same way as a resuming one, so its error line
   * cannot resurface under a fresh Resume button the next time the task
   * pauses (resumed from the desktop meanwhile, say). The attempt is read back
   * from the store: the panel is gone either way, so only the store shows
   * whether it was cleared or merely hidden.
   */
  it.each([
    [
      'the paused session ends into its resume',
      (): void => {
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId: 'sess-1',
          taskId: 'task-1',
          payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 'Resuming session...' },
        });
      },
    ],
    [
      'the session reports running again',
      (): void => {
        useActivityStore
          .getState()
          .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'running' }));
      },
    ],
  ])('clears a FAILED attempt once %s, so its error cannot resurface under a later pause', async (_case, leavePaused) => {
    seedPausedSession({ resumable: true });
    useResumeStore.getState().markFailed('task-1', 'Cannot resume a task in To Do');
    await renderSessionScreen();
    // Held, and drawn, for as long as the session stays paused.
    expect(screen.getByTestId('session-resume-error')).toBeTruthy();
    expect(useResumeStore.getState().byTaskId['task-1']).toEqual({ phase: 'failed', message: 'Cannot resume a task in To Do' });

    await act(() => {
      leavePaused();
    });

    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(useResumeStore.getState().byTaskId['task-1']).toBeUndefined();
  });

  /**
   * The Resume panel takes the terminal lens's place for a paused session, so
   * the swap veil yields to it: a veil over the panel would swallow the Resume
   * tap. The desktop's pause clears the task's session_id (keeping the task
   * on the board with `resumable: true`), which this screen reads as the
   * session going away and opens its quiet window; the board row still offers
   * Resume, so the panel stays. The window opens on the board's word alone here.
   */
  it('yields the swap veil to the Resume panel while the quiet window is open on a paused session', async () => {
    seedPausedSession({ resumable: true });
    await renderSessionScreen();
    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();

    await act(() => {
      seedBoard({ sessionId: null, resumable: true });
    });

    // The veil first: a veil that covers the panel also hides it from the
    // accessibility tree, so asserting the panel first would fail with "not
    // found" rather than naming the veil.
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();

    // Control: the quiet window really is open. Once the board no longer
    // offers Resume (the task moved to Done, say), the same open window shows
    // its veil - and the stream's stale copy of the flag does not outvote it.
    await act(() => {
      seedBoard({ sessionId: null, resumable: false });
    });
    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(screen.getByTestId('session-swap-veil')).toBeTruthy();
  });

  /**
   * A desktop pause leaves the phone NO stream on the paused session, so a
   * screen opened onto the task afterwards (from the feed's Paused card, say)
   * has no session at all: the board row alone draws the panel.
   */
  it('shows the Resume panel for a desktop-paused task the screen holds no session for', async () => {
    seedBoard({ sessionId: null, resumable: true });
    await renderSessionScreen();

    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();
    await act(async () => {
      await fireEvent.press(screen.getByTestId('session-resume-button'));
    });
    expect(resumeTaskSessionMock).toHaveBeenCalledWith('task-1', 'project-1');
  });

  /**
   * The desktop task view's launch overlay. Tapped from a screen that never
   * bound a session, Resume's panel goes the moment the desktop labels the
   * task "Resuming session..." - and with no ended session to key on, the
   * quiet window cannot cover the pane. The waiting veil does, until the
   * resumed session binds.
   */
  it('covers the pane with the waiting veil from the resume\'s label until a session binds', async () => {
    seedBoard({ sessionId: null, resumable: true });
    await renderSessionScreen();
    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();

    await act(() => {
      seedBoard({ sessionId: null, resumable: true, spawnProgress: 'Resuming session...' });
    });
    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(screen.getByTestId('session-swap-veil')).toBeTruthy();

    await act(() => {
      seedBoard({ sessionId: 'sess-2' });
    });
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();
  });

  /**
   * The launch face is the TERMINAL lens's waiting face: the veil stands in for
   * a pane that has nothing to show yet. Chat has its own empty state and Changes
   * its own list, so neither is covered, though all three share the footer, which
   * drops to the switcher alone because there is no live PTY to send keys or
   * messages to.
   */
  it('leaves the Chat lens uncovered while the resume is labelled, with the footer down to the switcher', async () => {
    seedBoard({ sessionId: null, resumable: true });
    await renderSessionScreen();
    await fireEvent.press(screen.getByTestId('stub-mode-chat'));

    await act(() => {
      seedBoard({ sessionId: null, resumable: true, spawnProgress: 'Resuming session...' });
    });

    // The veil first: a veil over the pane also hides the pane from the
    // accessibility tree, so asserting the pane first would fail with "not found"
    // rather than naming the veil.
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    expect(screen.queryByTestId('session-swap-veil-empty')).toBeNull();
    expect(screen.getByTestId('stub-chat-pane')).toBeTruthy();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'keys-hidden' });
  });

  /**
   * The same launch face for a screen BOUND to the paused session: the
   * idle-timeout suspend keeps `session_id` on the paused row, so the phone
   * holds a stream on it. When the resume's label lands the panel goes, and
   * nothing has ended yet for the quiet window to open on, so without this the
   * user watched the raw paused frame, quick keys live against a session with
   * no PTY, for the whole of the desktop's git phase.
   */
  it('covers a bound paused session with the cleared waiting veil while its resume is labelled', async () => {
    seedPausedSession({ resumable: true });
    await renderSessionScreen();
    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();

    await act(() => {
      seedBoard({ sessionId: 'sess-1', resumable: true, spawnProgress: 'Resuming session...' });
    });

    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(screen.getByTestId('session-swap-veil-empty')).toBeTruthy();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'keys-hidden' });
  });

  /**
   * The hand-over: the paused row's feed ends (naming its successor) under a
   * pane the launch face has already cleared. The quiet window that opens on
   * that end must open cleared too, never putting the dead frame back between
   * the label and the successor's paint.
   */
  it('keeps the pane cleared when the labelled paused session ends into its successor', async () => {
    seedPausedSession({ resumable: true });
    await renderSessionScreen();
    await act(() => {
      seedBoard({ sessionId: 'sess-1', resumable: true, spawnProgress: 'Resuming session...' });
    });

    await act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 'Resuming session...', successorSessionId: 'sess-2' },
      });
    });
    expect(screen.getByTestId('session-swap-veil-empty')).toBeTruthy();

    await act(() => {
      seedBoard({ sessionId: 'sess-2' });
    });
    expect(screen.getByTestId('session-swap-veil-empty')).toBeTruthy();
  });

  it('gives the paused frame and its Resume back when the label goes with no resume', async () => {
    seedPausedSession({ resumable: true });
    await renderSessionScreen();
    await act(() => {
      seedBoard({ sessionId: 'sess-1', resumable: true, spawnProgress: 'Resuming session...' });
    });

    await act(() => {
      seedBoard({ sessionId: 'sess-1', resumable: true });
    });

    expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();
  });

  /**
   * The launch face remembers which bound session it cleared the pane over, so
   * that session's end opens the quiet window already cleared (the hand-over
   * above). That memory has to go when the resume FAILS: the label clears, the
   * row still names the parked session and it still reads suspended, so its
   * frame is back on screen. A LATER end of that same session (a Stop, say) is
   * an ordinary end, and its window opens on the dimmed last frame like any
   * other, never on the cleared waiting face a flag left over from the failed
   * resume would give it.
   */
  it('opens a later end of the session on the dimmed frame, not cleared, once a resume of it has failed', async () => {
    seedPausedSession({ resumable: true });
    await renderSessionScreen();
    await act(() => {
      seedBoard({ sessionId: 'sess-1', resumable: true, spawnProgress: 'Resuming session...' });
    });
    // The control: the launch face really did clear the pane over this session.
    expect(screen.getByTestId('session-swap-veil-empty')).toBeTruthy();

    await act(() => {
      seedBoard({ sessionId: 'sess-1', resumable: true });
    });
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();

    // A Stop: an unlabelled end, and the desktop clears the session and offers no Resume.
    await act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'session-ended', intentional: true },
      });
      seedBoard({ sessionId: null, resumable: false });
    });

    // The veil first: the quiet window really is open.
    expect(screen.getByTestId('session-swap-veil')).toBeTruthy();
    expect(screen.queryByTestId('session-swap-veil-empty')).toBeNull();
  });

  /**
   * The other order of the hand-over. The board binds the successor (and clears
   * the label in the same write) BEFORE the paused session's own end arrives.
   * The screen follows the board to the successor at once, so the old session is
   * no longer the one it is bound to: its late end opens no quiet window here at
   * all, cleared or otherwise, and the old frame is never drawn again.
   * What this pins is that nothing veils or offers Resume over the successor's
   * pane; the window that keeps the old frame off screen is the one the
   * hand-over test above covers.
   */
  it('draws no veil and no Resume when the board binds the successor before the old session\'s end arrives', async () => {
    seedPausedSession({ resumable: true });
    await renderSessionScreen();
    await act(() => {
      seedBoard({ sessionId: 'sess-1', resumable: true, spawnProgress: 'Resuming session...' });
    });
    expect(screen.getByTestId('session-swap-veil-empty')).toBeTruthy();

    await act(() => {
      seedBoard({ sessionId: 'sess-2' });
    });
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();

    await act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 'Resuming session...', successorSessionId: 'sess-2' },
      });
    });

    expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    expect(screen.queryByTestId('session-swap-veil-empty')).toBeNull();
    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
  });

  /**
   * The ordering the launch face's memory is kept for. The label goes because
   * the board has moved PAST the paused session without naming a successor the
   * screen can bind (here the task drops out of the `'sessions'` projection),
   * and the session's own end arrives a moment later. The screen is still bound
   * to it, so that end opens the window, and it must open cleared: the label's
   * going is not a resume failing, and the old frame must not come back between
   * the label and the successor's paint. The memory is therefore dropped only
   * while the row still names the session and it still reads suspended (the
   * failed-resume test above), never merely because the launch face went away.
   */
  it('keeps the window cleared when the board moves past the session before its end arrives', async () => {
    seedPausedSession({ resumable: true });
    await renderSessionScreen();
    await act(() => {
      seedBoard({ sessionId: 'sess-1', resumable: true, spawnProgress: 'Resuming session...' });
    });
    expect(screen.getByTestId('session-swap-veil-empty')).toBeTruthy();

    await act(() => {
      useBoardStore.setState((state) => ({
        boardsByProjectId: {
          ...state.boardsByProjectId,
          'project-1': { ...state.boardsByProjectId['project-1'], tasksById: {} },
        },
      }));
    });
    // Between the label going and the end arriving the pane is the paused frame again.
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();

    await act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'session-ended', intentional: true, spawnProgressLabel: 'Resuming session...', successorSessionId: 'sess-2' },
      });
    });

    expect(screen.getByTestId('session-swap-veil-empty')).toBeTruthy();
  });

  /**
   * The terminal mirror's fit-to-height button and its reference cell read the
   * pane's height as "the height the lens is read at". The Resume panel drops
   * the quick-key row, so the pane is TALLER than that: a fit taken there would
   * pin a cell no ordinary session ever uses. The pane says so by not being a
   * fit reference while the panel shows, and is one again as soon as it goes.
   */
  it('tells the terminal its pane is not a fit reference while the Resume panel shows, and again once it is gone', async () => {
    seedPausedSession({ resumable: true });
    await renderSessionScreen();
    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();

    expect(screen.getByTestId('stub-terminal-tab').props.accessibilityValue).toEqual({ text: 'fit-layout-is-reference-false' });

    await act(() => {
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'running' }));
    });

    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(screen.getByTestId('stub-terminal-tab').props.accessibilityValue).toEqual({ text: 'fit-layout-is-reference-true' });
  });

  it('keeps the terminal pane a fit reference when no Resume panel shows (a paused session the desktop does not mark resumable)', async () => {
    seedPausedSession({ resumable: false });
    await renderSessionScreen();

    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(screen.getByTestId('stub-terminal-tab').props.accessibilityValue).toEqual({ text: 'fit-layout-is-reference-true' });
  });

  it('shows no Resume for a running session', async () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore
      .getState()
      .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'running' }));
    useActivityStore.setState((state) => ({
      bySessionId: { ...state.bySessionId, 'sess-1': { ...state.bySessionId['sess-1'], resumable: true } },
    }));
    await renderSessionScreen();

    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'keys-shown' });
  });
});

/**
 * The task on screen is what clears its own alerts (the reconciler's clear on
 * open). Keyed on the TASK, so a respawn's rebind to a new session keeps the
 * claim; released when the screen goes. Lives beside the Resume suite only for
 * its harness: the claim is independent of what the lens shows.
 */
describe('SessionScreen notification surface', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockIsFocused = true;
    mockFocusListeners.clear();
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    seedBoard();
  });

  it('claims its task as an open notification surface while shown, and releases it when gone', async () => {
    await renderSessionScreen();
    expect(getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);

    await screen.unmount();
    expect(getOpenNotificationSurfaces()).toEqual([]);
  });

  /**
   * The claim follows FOCUS, not mount: a route pushed over the session (the
   * file diff, the move sheet) leaves it mounted but no longer on screen, so its
   * alerts are no longer redundant. Unmounting releases the claim under a plain
   * `useEffect` too, which is why the test above cannot tell the two apart. Both
   * halves are asserted in one test: the release while the screen is still
   * mounted, and the claim again when focus returns (a release that never
   * re-claimed would pass the first half alone).
   *
   * Mutation seen failing: swapping the surface effect's `useFocusEffect(` for
   * a plain `useEffect(` in SessionScreen (the claim survived the blur: expected
   * `[]`, received `[{ kind: 'task', taskId: 'task-1' }]`). The unmount test
   * above stayed green under it.
   */
  it('releases its task while a route is pushed over it, and claims it again when focus returns', async () => {
    await renderSessionScreen();
    expect(getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);

    await act(() => {
      mockSetFocused(false);
    });
    // Blurred, not unmounted: the release is the blur's, not the teardown's.
    expect(screen.getByTestId('stub-session-input-bar')).toBeTruthy();
    expect(getOpenNotificationSurfaces()).toEqual([]);

    await act(() => {
      mockSetFocused(true);
    });
    expect(getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);
  });

  /**
   * Keyed on the TASK, so a respawn's rebind keeps the claim. The registry
   * cannot show this on its own: it is ref-counted and answers one entry per
   * surface, and React runs a changed effect's cleanup and its re-run inside one
   * commit, so a claim keyed on the session ends every rebind reading exactly
   * one task surface too. What differs is the OPEN: a claim keyed on the task is
   * opened once and never again, a claim keyed on the session is released and
   * opened anew at each rebind. So the test listens for opens, and asserts the
   * one held across the whole respawn (sess-1, then the gap with no session,
   * then sess-2), a registry that never reads empty or doubled at a step, and a
   * release by the unmount that leaves nothing behind (a leaked holder would
   * keep the surface open).
   *
   * The rebind assertions are the control: without them a screen that never
   * rebound would pass for "kept the claim through it".
   *
   * Mutation seen failing: keying the effect on the session as well, `[taskId]`
   * becoming `[taskId, sessionId]` on the surface effect in SessionScreen (the
   * claim was released and reopened at each rebind: three opens of `{ kind:
   * 'task', taskId: 'task-1' }` received where one was expected). Every
   * registry assertion before that one stayed green under it, as predicted
   * above, and so did the unmount and blur tests.
   */
  it('keeps one task claim open, opened once, while the screen rebinds to another session of the same task', async () => {
    const openedSurfaces: NotificationSurface[] = [];
    const stopListening = subscribeToOpenedNotificationSurfaces((surface) => {
      openedSurfaces.push(surface);
    });
    try {
      await renderSessionScreen();
      expect(openSessionScreenMock).toHaveBeenCalledWith('sess-1');
      expect(getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);
      expect(openedSurfaces).toEqual([{ kind: 'task', taskId: 'task-1' }]);

      // The respawn's gap: the desktop has cleared the task's session and not yet bound the successor.
      await act(() => {
        seedBoard({ sessionId: null });
      });
      expect(closeSessionScreenMock).toHaveBeenCalledWith('sess-1');
      expect(getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);

      // The successor binds.
      await act(() => {
        seedBoard({ sessionId: 'sess-2' });
      });
      expect(openSessionScreenMock).toHaveBeenCalledWith('sess-2');
      expect(getOpenNotificationSurfaces()).toEqual([{ kind: 'task', taskId: 'task-1' }]);

      // Held across the whole respawn, not dropped and taken again.
      expect(openedSurfaces).toEqual([{ kind: 'task', taskId: 'task-1' }]);

      await screen.unmount();
      expect(getOpenNotificationSurfaces()).toEqual([]);
    } finally {
      stopListening();
    }
  });
});
