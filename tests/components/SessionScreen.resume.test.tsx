import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SessionScreen } from '@/screens/task/SessionScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useResumeStore } from '@/state/resumeStore';
import { boardColumnFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { resumeTaskSession } from '@/connection/actions';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockRouter = { replace: jest.fn(), back: jest.fn(), push: jest.fn(), canGoBack: jest.fn(() => true) };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({ taskId: 'task-1', sessionId: 'sess-1', projectId: 'project-1', mode: 'terminal' }),
  useRouter: () => mockRouter,
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
}));

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
// Records `quickKeysHidden` so the footer's half of the paused layout is visible here.
jest.mock('@/screens/task/SessionInputBar', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    SessionInputBar: (props: { quickKeysHidden?: boolean }) => (
      <View testID="stub-session-input-bar" accessibilityValue={{ text: props.quickKeysHidden === true ? 'keys-hidden' : 'keys-shown' }} />
    ),
  };
});

const resumeTaskSessionMock = resumeTaskSession as jest.Mock;

/** `sessionId: null` is the board's report once the desktop has paused the task: it clears the task's `session_id`. */
function seedBoard({ sessionId = 'sess-1' }: { sessionId?: string | null } = {}): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture(), boardColumnFixture({ id: 'lane-review', name: 'Code Review', role: null, position: 1 })],
        tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', session_id: sessionId, swimlane_id: 'lane-review' }) },
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
 * A paused session, as the desktop's subscribe snapshot reports it. No wire
 * on protocol 0.15.0 carries `resumable` (desktop #762 adds it in 0.16.0), so
 * a desktop that offers Resume is seeded by flipping the entry directly; the
 * default, false, is what every desktop the phone can reach today produces.
 */
function seedPausedSession({ resumable }: { resumable: boolean }): void {
  useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
  useActivityStore
    .getState()
    .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'suspended' }));
  if (resumable) {
    useActivityStore.setState((state) => ({
      bySessionId: { ...state.bySessionId, 'sess-1': { ...state.bySessionId['sess-1'], resumable: true } },
    }));
  }
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
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useResumeStore.setState({ byTaskId: {} });
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
   * preparing, never as paused, so the panel gives way and the attempt ends.
   */
  it('gives way and ends the attempt when the paused session ends into its resume', async () => {
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
    expect(useResumeStore.getState().byTaskId['task-1']).toBeUndefined();
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
   * tap. The desktop's pause clears the task's session_id, which this screen
   * reads as the session going away and opens its quiet window; the session
   * it keeps bound is still paused, so the panel stays. The window opens on
   * the board's word alone here (not a `session-ended`, which would end the
   * session's paused display and take the panel with it).
   */
  it('yields the swap veil to the Resume panel while the quiet window is open on a paused session', async () => {
    seedPausedSession({ resumable: true });
    await renderSessionScreen();
    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();

    await act(() => {
      seedBoard({ sessionId: null });
    });

    // The veil first: a veil that covers the panel also hides it from the
    // accessibility tree, so asserting the panel first would fail with "not
    // found" rather than naming the veil.
    expect(screen.queryByTestId('session-swap-veil')).toBeNull();
    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();

    // Control: the quiet window really is open. Once the desktop no longer
    // offers Resume, the same open window shows its veil.
    await act(() => {
      useActivityStore.setState((state) => ({
        bySessionId: { ...state.bySessionId, 'sess-1': { ...state.bySessionId['sess-1'], resumable: false } },
      }));
    });
    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(screen.getByTestId('session-swap-veil')).toBeTruthy();
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
