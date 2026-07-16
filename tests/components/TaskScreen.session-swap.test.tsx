import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TaskScreen } from '@/screens/task/TaskScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { boardTaskFixture } from '@/devsupport/desktopFixtures';
import { closeSessionScreen, openSessionScreen } from '@/connection/actions';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

let mockParams: { taskId: string; sessionId?: string; projectId?: string } = { taskId: 'task-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn() }),
}));

jest.mock('@/connection/actions', () => ({
  openSessionScreen: jest.fn(),
  closeSessionScreen: jest.fn(),
}));

// The tabs are heavy (FlashList transcript, xterm WebView, diff watch); this
// test is about SESSION BINDING, so each tab becomes a marker that records
// the sessionId it received.
jest.mock('@/screens/task/ConversationTab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    ConversationTab: (props: { sessionId: string | null }) =>
      ReactModule.createElement(View, { testID: 'stub-conversation', accessibilityLabel: props.sessionId ?? 'none' }),
    ConversationFooter: (props: { sessionId: string | null }) =>
      ReactModule.createElement(View, { testID: 'stub-conversation-footer', accessibilityLabel: props.sessionId ?? 'none' }),
  };
});

jest.mock('@/screens/task/TerminalTab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    TerminalTab: () => ReactModule.createElement(View, { testID: 'stub-terminal' }),
    TerminalFooter: () => ReactModule.createElement(View, { testID: 'stub-terminal-footer' }),
  };
});

jest.mock('@/screens/task/ChangesTab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    ChangesTab: () => ReactModule.createElement(View, { testID: 'stub-changes' }),
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
      },
    },
    pendingMoves: [],
  });
}

function renderTaskScreen(): void {
  render(
    <ThemeProvider>
      <TaskScreen />
    </ThemeProvider>,
  );
}

describe('TaskScreen session binding', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1' };
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
  });

  it('binds to the param session before the board locates the task', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-param' };
    renderTaskScreen();
    expect(openSessionScreenMock).toHaveBeenCalledWith('sess-param');
    expect(screen.queryByTestId('session-ended-state')).toBeNull();
  });

  it('re-binds to the successor session when the board swaps the task session', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderTaskScreen();
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

  it('shows the ended state when the located task loses its session with no successor', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderTaskScreen();

    act(() => {
      seedTaskWithSession(null);
    });

    expect(screen.getByTestId('session-ended-state')).toBeTruthy();
    expect(closeSessionScreenMock).toHaveBeenCalledWith('sess-a');
    expect(screen.queryByTestId('stub-conversation-footer')).toBeNull();
  });

  it('recovers from the ended state when a successor session appears', () => {
    mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
    seedTaskWithSession('sess-a');
    renderTaskScreen();
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
    renderTaskScreen();
    expect(screen.queryByTestId('session-ended-state')).toBeNull();
    expect(openSessionScreenMock).not.toHaveBeenCalled();
  });

  it('declares the session dead when its feed stays rejected past the grace window', () => {
    jest.useFakeTimers();
    try {
      mockParams = { taskId: 'task-1', sessionId: 'sess-a' };
      seedTaskWithSession('sess-a');
      useActivityStore.getState().registerSession('sess-a', 'task-1', 'project-1');
      renderTaskScreen();

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
});
