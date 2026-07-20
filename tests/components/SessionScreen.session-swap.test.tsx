import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SessionScreen } from '@/screens/task/SessionScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useSettingsStore } from '@/state/settingsStore';
import { boardTaskFixture } from '@/devsupport/desktopFixtures';
import { closeSessionScreen, openSessionScreen } from '@/connection/actions';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

let mockParams: { taskId: string; sessionId?: string; projectId?: string; mode?: string } = { taskId: 'task-1' };
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

jest.mock('@/connection/actions', () => ({
  openSessionScreen: jest.fn(),
  closeSessionScreen: jest.fn(),
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
    TerminalTab: (props: { sessionId: string | null }) =>
      ReactModule.createElement(View, { testID: 'stub-terminal-tab', accessibilityLabel: props.sessionId ?? 'none' }),
  };
});

jest.mock('@/screens/task/SessionInputBar', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    SessionInputBar: (props: { sessionId: string | null; mode: string }) =>
      props.sessionId === null
        ? null
        : ReactModule.createElement(View, { testID: 'stub-session-input-bar', accessibilityLabel: props.mode }),
  };
});

const openSessionScreenMock = openSessionScreen as jest.Mock;
const closeSessionScreenMock = closeSessionScreen as jest.Mock;

function seedTaskWithSession(sessionId: string | null): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', session_id: sessionId }),
        },
        backlog: [],
        snapshotAt: 0,
        showTicketNumbers: true,
      },
    },
    pendingMoves: [],
  });
}

function renderSessionScreen(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <SessionScreen />
    </ThemeProvider>,
  );
}

describe('SessionScreen session binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1' };
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
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

  it('pushes the changes route from the header chip', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a', projectId: 'project-1' };
    seedTaskWithSession('sess-a');
    renderSessionScreen();
    fireEvent.press(screen.getByTestId('task-header-changes'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/task/[taskId]/changes',
      params: { taskId: 'task-1', projectId: 'project-1' },
    });
  });
});
