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
  return { __esModule: true, TerminalTab: () => <View testID="stub-terminal-tab" /> };
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

function seedBoard(): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture(), boardColumnFixture({ id: 'lane-review', name: 'Code Review', role: null, position: 1 })],
        tasksById: { 'task-1': boardTaskFixture({ id: 'task-1', session_id: 'sess-1', swimlane_id: 'lane-review' }) },
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

function renderSessionScreen(): void {
  render(
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
    renderSessionScreen();

    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();
    expect(screen.getByText('Resume session')).toBeTruthy();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'keys-hidden' });

    await act(async () => {
      fireEvent.press(screen.getByTestId('session-resume-button'));
    });
    expect(resumeTaskSessionMock).toHaveBeenCalledWith('task-1', 'project-1');
  });

  /**
   * The gate. A desktop that does not mark the session resumable answers
   * `start-session` by re-running the column's automations, so there the
   * phone offers no Resume at all, on any surface, rather than a different one.
   */
  it('offers no Resume for a paused session the desktop does not mark resumable', () => {
    seedPausedSession({ resumable: false });
    renderSessionScreen();

    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(screen.queryByTestId('task-header-resume')).toBeNull();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'keys-shown' });
  });

  it('reads "Resuming agent..." with a spinner, and takes no second tap, while the resume runs', () => {
    seedPausedSession({ resumable: true });
    useResumeStore.getState().markResuming('task-1', Date.now());
    renderSessionScreen();

    expect(screen.getByText('Resuming agent...')).toBeTruthy();
    expect(screen.getByTestId('session-resume-spinner')).toBeTruthy();
    expect(screen.getByTestId('session-resume-button').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
  });

  it.each([
    ['the desktop\'s failure line when no reason came back', null, 'Session could not be resumed.'],
    ['the desktop\'s own refusal text when it sent one', 'Cannot resume a task in To Do', 'Cannot resume a task in To Do'],
  ])('shows %s under a live button after a failed resume', (_case, message, expected) => {
    seedPausedSession({ resumable: true });
    useResumeStore.getState().markFailed('task-1', message);
    renderSessionScreen();

    expect(screen.getByTestId('session-resume-error').props.children).toBe(expected);
    expect(screen.getByText('Resume session')).toBeTruthy();
    expect(screen.getByTestId('session-resume-button').props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
  });

  /**
   * A desktop resume never revives the paused session: it ends it, with the
   * desktop's resume label, and binds a successor. The label reads as
   * preparing, never as paused, so the panel gives way and the attempt ends.
   */
  it('gives way and ends the attempt when the paused session ends into its resume', () => {
    seedPausedSession({ resumable: true });
    useResumeStore.getState().markResuming('task-1', Date.now());
    renderSessionScreen();
    expect(screen.getByTestId('session-resume-panel')).toBeTruthy();

    act(() => {
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

  it('shows no Resume for a running session', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore
      .getState()
      .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'running' }));
    useActivityStore.setState((state) => ({
      bySessionId: { ...state.bySessionId, 'sess-1': { ...state.bySessionId['sess-1'], resumable: true } },
    }));
    renderSessionScreen();

    expect(screen.queryByTestId('session-resume-panel')).toBeNull();
    expect(screen.getByTestId('stub-session-input-bar').props.accessibilityValue).toEqual({ text: 'keys-shown' });
  });
});
