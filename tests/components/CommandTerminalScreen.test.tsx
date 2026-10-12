import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { ActivityEventPayload } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import {
  CommandTerminalScreen,
  START_FAILURE_HOLD_MS,
  STARTING_COMMAND_TERMINAL_CAPTION,
  START_FAILED_TITLE,
  UNLISTED_TERMINAL_GRACE_MS,
} from '@/screens/terminals/CommandTerminalScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useCommandTerminalStore } from '@/state/commandTerminalStore';
import { useTerminalUiStore } from '@/state/terminalUiStore';
import { closeSessionScreen, openSessionScreen } from '@/connection/actions';
import { streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { commandTerminalWireFixture, seedCommandTerminalBoard, setBoardCommandTerminals } from '../helpers/commandTerminals';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

// The real SessionInputBar mounts the composer, which pulls in the dictation engine.
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn().mockReturnValue(true),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    start: jest.fn(),
    stop: jest.fn(),
  },
  useSpeechRecognitionEvent: jest.fn(),
}));

let mockParams: { launchId?: string; sessionId?: string; projectId?: string } = {};
const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockSetParams = jest.fn();
const mockCanGoBack = jest.fn(() => true);
// ONE object, as expo-router's own `router` is: the leave effect keys its
// callback on the router, and a fresh object per render would re-run it (and
// re-pop) on every render, which no real app does.
const mockRouter = { back: mockBack, replace: mockReplace, setParams: mockSetParams, canGoBack: mockCanGoBack, push: jest.fn() };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
  // The real one throws outside a navigator. Everything mounted here is
  // focused for its whole life, so a plain effect is the faithful stand-in.
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
}));

const mockStopCommandTerminal = jest.fn();
const mockWriteTerminal = jest.fn();
jest.mock('@/connection/actions', () => ({
  openSessionScreen: jest.fn(),
  closeSessionScreen: jest.fn(),
  stopCommandTerminal: (sessionId: string) => mockStopCommandTerminal(sessionId),
  writeTerminal: (sessionId: string, data: string) => mockWriteTerminal(sessionId, data),
  sendUserMessage: jest.fn().mockResolvedValue(undefined),
  setDiffWatch: jest.fn(),
}));

// The panes are heavy (xterm WebView, FlashList transcript, diff list). This
// test is about the screen's binding, navigation and INPUT GATE, so each becomes
// a marker that records the props the screen hands it. The footer stays REAL:
// the gate's footer half is `session-input-row`'s pointerEvents, which a stub
// cannot show.
const mockTerminalTabProps: { current: { sessionId: string | null; inputEnabled?: boolean; active: boolean } | null } = { current: null };
jest.mock('@/screens/task/TerminalTab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    TerminalTab: (props: { sessionId: string | null; inputEnabled?: boolean; active: boolean }) => {
      mockTerminalTabProps.current = props;
      return ReactModule.createElement(View, { testID: 'stub-terminal-tab' });
    },
  };
});

const mockChatPaneProps: { current: { taskId: string; sessionId: string | null; projectId: string | null } | null } = { current: null };
jest.mock('@/screens/task/ChatPane', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    ChatPane: (props: { taskId: string; sessionId: string | null; projectId: string | null }) => {
      mockChatPaneProps.current = props;
      return ReactModule.createElement(View, { testID: 'stub-chat-pane' });
    },
  };
});

const mockChangesTabProps: { current: { taskId: string | null; projectId: string | null; isActive: boolean } | null } = { current: null };
jest.mock('@/screens/task/ChangesTab', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    ChangesTab: (props: { taskId: string | null; projectId: string | null; isActive: boolean }) => {
      mockChangesTabProps.current = props;
      return ReactModule.createElement(View, { testID: 'stub-changes-tab' });
    },
  };
});

const openSessionScreenMock = openSessionScreen as jest.Mock;
const closeSessionScreenMock = closeSessionScreen as jest.Mock;

const PROJECT_ID = 'project-1';
const SESSION_ID = 'terminal-1';

function renderScreen(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <CommandTerminalScreen />
    </ThemeProvider>,
  );
}

function seedListedTerminal(overrides: { named?: boolean; name?: string } = {}): void {
  seedCommandTerminalBoard({
    terminals: [
      commandTerminalWireFixture({
        sessionId: SESSION_ID,
        projectId: PROJECT_ID,
        slot: 1,
        name: overrides.name ?? 'Command Terminal 1',
        named: overrides.named ?? false,
      }),
    ],
  });
}

function pushActivityEvent(payload: ActivityEventPayload, sessionId: string = SESSION_ID): void {
  useActivityStore.getState().applyActivityEvent({ kind: 'activity', sessionId, taskId: '', payload });
}

/** The desktop classifying the terminal's agent: its first activity push flips `activityObserved`. */
function classifyAgent(sessionId: string = SESSION_ID): void {
  pushActivityEvent({ type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }, sessionId);
}

function inputRow(): ReturnType<typeof screen.getByTestId> {
  return screen.getByTestId('session-input-row', { includeHiddenElements: true });
}

describe('CommandTerminalScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanGoBack.mockReturnValue(true);
    mockParams = {};
    mockTerminalTabProps.current = null;
    mockChatPaneProps.current = null;
    mockChangesTabProps.current = null;
    mockWriteTerminal.mockResolvedValue(undefined);
    mockStopCommandTerminal.mockResolvedValue(undefined);
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useCommandTerminalStore.getState().reset();
    useTerminalUiStore.setState({ paintedSessionIds: {} });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('opened from a launch that is still starting', () => {
    let launchId: string;

    beforeEach(() => {
      seedCommandTerminalBoard({ terminals: [] });
      launchId = useCommandTerminalStore.getState().beginLaunch(PROJECT_ID, 2);
      mockParams = { launchId, projectId: PROJECT_ID };
    });

    it('opens at once on the desktop\'s own words, under the predicted title', async () => {
      await renderScreen();

      const startingFace = screen.getByTestId('command-terminal-starting');
      expect(startingFace.props.accessibilityLabel).toBe(STARTING_COMMAND_TERMINAL_CAPTION);
      expect(screen.getByText('Starting Command Terminal...')).toBeTruthy();
      expect(screen.getByTestId('command-terminal-title')).toHaveTextContent('Command Terminal 2');
      expect(screen.queryByTestId('command-terminal-start-failed')).toBeNull();
    });

    it('binds no session yet, and holds input', async () => {
      await renderScreen();

      expect(openSessionScreenMock).not.toHaveBeenCalled();
      expect(mockSetParams).not.toHaveBeenCalled();
      expect(mockTerminalTabProps.current?.sessionId).toBeNull();
      expect(mockTerminalTabProps.current?.inputEnabled).toBe(false);
    });

    it('disables Stop, and a tap on it stops and leaves nothing', async () => {
      await renderScreen();

      const stopButton = screen.getByTestId('command-terminal-stop');
      expect(stopButton.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
      await fireEvent.press(stopButton);

      expect(mockStopCommandTerminal).not.toHaveBeenCalled();
      expect(mockBack).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('shows no "Command Terminal" pill, since the predicted title already says it', async () => {
      await renderScreen();

      expect(screen.queryByTestId('command-terminal-pill')).toBeNull();
    });

    it('binds the session, writes it into the route and enables Stop when the launch flips to started', async () => {
      await renderScreen();

      await act(() => {
        useCommandTerminalStore.getState().markLaunchStarted(launchId, { sessionId: 'terminal-9', slot: 2, name: 'Command Terminal 2' });
      });

      expect(openSessionScreenMock).toHaveBeenCalledTimes(1);
      expect(openSessionScreenMock).toHaveBeenCalledWith('terminal-9');
      // Written into the route so a remount binds the same terminal rather than a launch that is gone.
      expect(mockSetParams).toHaveBeenCalledWith({ sessionId: 'terminal-9' });
      expect(mockTerminalTabProps.current?.sessionId).toBe('terminal-9');
      expect(screen.getByTestId('command-terminal-stop').props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
    });

    it('stops the BOUND session, once, and leaves, after the launch started', async () => {
      await renderScreen();
      await act(() => {
        useCommandTerminalStore.getState().markLaunchStarted(launchId, { sessionId: 'terminal-9', slot: 2, name: 'Command Terminal 2' });
      });

      await fireEvent.press(screen.getByTestId('command-terminal-stop'));

      expect(mockStopCommandTerminal).toHaveBeenCalledTimes(1);
      expect(mockStopCommandTerminal).toHaveBeenCalledWith('terminal-9');
      expect(mockBack).toHaveBeenCalledTimes(1);
    });

    it('takes the started launch\'s name as the title until the board lists the terminal', async () => {
      await renderScreen();

      await act(() => {
        useCommandTerminalStore.getState().markLaunchStarted(launchId, { sessionId: 'terminal-9', slot: 3, name: 'Command Terminal 3' });
      });

      expect(screen.getByTestId('command-terminal-title')).toHaveTextContent('Command Terminal 3');
    });

    it('does not treat a started terminal the board has not listed yet as over, however long that takes', async () => {
      jest.useFakeTimers();
      await renderScreen();
      await act(() => {
        useCommandTerminalStore.getState().markLaunchStarted(launchId, { sessionId: 'terminal-9', slot: 2, name: 'Command Terminal 2' });
      });

      await act(() => {
        jest.advanceTimersByTime(UNLISTED_TERMINAL_GRACE_MS * 5);
      });

      expect(mockBack).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('releases the session screen it opened when it unmounts', async () => {
      const { unmount } = await renderScreen();
      await act(() => {
        useCommandTerminalStore.getState().markLaunchStarted(launchId, { sessionId: 'terminal-9', slot: 2, name: 'Command Terminal 2' });
      });
      expect(closeSessionScreenMock).not.toHaveBeenCalled();

      await unmount();

      expect(closeSessionScreenMock).toHaveBeenCalledWith('terminal-9');
    });
  });

  describe('opened from a launch that fails', () => {
    let launchId: string;

    beforeEach(() => {
      seedCommandTerminalBoard({ terminals: [] });
      launchId = useCommandTerminalStore.getState().beginLaunch(PROJECT_ID, 1);
      mockParams = { launchId, projectId: PROJECT_ID };
    });

    it('shows the reason in place of the starting face, and holds input and Stop', async () => {
      await renderScreen();

      await act(() => {
        useCommandTerminalStore.getState().markLaunchFailed(launchId, 'Command Terminal limit reached');
      });

      expect(screen.getByTestId('command-terminal-start-failed')).toBeTruthy();
      expect(screen.getByText(START_FAILED_TITLE)).toBeTruthy();
      expect(screen.getByTestId('command-terminal-start-failed-reason')).toHaveTextContent('Command Terminal limit reached');
      expect(screen.queryByTestId('command-terminal-starting')).toBeNull();
      expect(mockTerminalTabProps.current?.inputEnabled).toBe(false);
      expect(screen.getByTestId('command-terminal-stop').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    });

    it('holds the line for START_FAILURE_HOLD_MS, then goes back', async () => {
      jest.useFakeTimers();
      await renderScreen();
      await act(() => {
        useCommandTerminalStore.getState().markLaunchFailed(launchId, 'Command Terminal limit reached');
      });

      await act(() => {
        jest.advanceTimersByTime(START_FAILURE_HOLD_MS - 1);
      });
      expect(mockBack).not.toHaveBeenCalled();
      expect(screen.getByTestId('command-terminal-start-failed')).toBeTruthy();

      await act(() => {
        jest.advanceTimersByTime(1);
      });
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('goes home instead when there is nothing behind it', async () => {
      jest.useFakeTimers();
      mockCanGoBack.mockReturnValue(false);
      await renderScreen();
      await act(() => {
        useCommandTerminalStore.getState().markLaunchFailed(launchId, 'Command Terminal limit reached');
      });

      await act(() => {
        jest.advanceTimersByTime(START_FAILURE_HOLD_MS);
      });

      expect(mockBack).not.toHaveBeenCalled();
      expect(mockReplace).toHaveBeenCalledWith('/');
    });

    it('clears the failed launch on the way out, so a later visit cannot find it', async () => {
      const { unmount } = await renderScreen();
      await act(() => {
        useCommandTerminalStore.getState().markLaunchFailed(launchId, 'Command Terminal limit reached');
      });
      expect(useCommandTerminalStore.getState().launchesById[launchId]).toBeDefined();

      await unmount();

      expect(useCommandTerminalStore.getState().launchesById[launchId]).toBeUndefined();
    });
  });

  describe('opened for a listed terminal (by session)', () => {
    beforeEach(() => {
      mockParams = { sessionId: SESSION_ID, projectId: PROJECT_ID };
    });

    it('titles itself with the terminal\'s name and binds the session', async () => {
      seedListedTerminal({ name: 'Fix the flaky login test', named: true });
      await renderScreen();

      expect(screen.getByTestId('command-terminal-title')).toHaveTextContent('Fix the flaky login test');
      expect(openSessionScreenMock).toHaveBeenCalledWith(SESSION_ID);
      // The route already carries the session: nothing to write back.
      expect(mockSetParams).not.toHaveBeenCalled();
      expect(mockTerminalTabProps.current?.sessionId).toBe(SESSION_ID);
    });

    it('shows the "Command Terminal" pill once the terminal has a name of its own', async () => {
      seedListedTerminal({ name: 'Fix the flaky login test', named: true });
      await renderScreen();

      expect(screen.getByTestId('command-terminal-pill')).toHaveTextContent('Command Terminal');
    });

    it('shows NO pill for an unnamed terminal, whose title already says it', async () => {
      seedListedTerminal({ name: 'Command Terminal 1', named: false });
      await renderScreen();

      expect(screen.getByTestId('command-terminal-title')).toHaveTextContent('Command Terminal 1');
      expect(screen.queryByTestId('command-terminal-pill')).toBeNull();
    });

    it('draws the pill as soon as the desktop names the terminal under an open screen', async () => {
      seedListedTerminal({ name: 'Command Terminal 1', named: false });
      await renderScreen();
      expect(screen.queryByTestId('command-terminal-pill')).toBeNull();

      await act(() => {
        setBoardCommandTerminals(PROJECT_ID, [
          commandTerminalWireFixture({ sessionId: SESSION_ID, projectId: PROJECT_ID, name: 'Fix the flaky login test', named: true }),
        ]);
      });

      expect(screen.getByTestId('command-terminal-pill')).toBeTruthy();
      expect(screen.getByTestId('command-terminal-title')).toHaveTextContent('Fix the flaky login test');
    });

    it('titles a terminal the board does not list (yet) with the generic title, and no pill', async () => {
      seedCommandTerminalBoard({ terminals: [] });
      await renderScreen();

      expect(screen.getByTestId('command-terminal-title')).toHaveTextContent('Command Terminal');
      expect(screen.queryByTestId('command-terminal-pill')).toBeNull();
    });

    it('mounts the three lenses on the terminal\'s own project, with no task', async () => {
      seedListedTerminal();
      await renderScreen();

      expect(mockTerminalTabProps.current?.active).toBe(true);
      // A terminal has no task: the chat lens settles on the reading view and
      // Changes is the PROJECT folder's diff.
      expect(mockChatPaneProps.current).toEqual(expect.objectContaining({ taskId: '', sessionId: SESSION_ID, projectId: PROJECT_ID }));
      expect(mockChangesTabProps.current).toEqual(expect.objectContaining({ taskId: null, projectId: PROJECT_ID, isActive: false }));
    });

    it('goes back from the header\'s back button', async () => {
      seedListedTerminal();
      await renderScreen();

      await fireEvent.press(screen.getByTestId('command-terminal-back'));

      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(mockStopCommandTerminal).not.toHaveBeenCalled();
    });

    it('holds "Starting Command Terminal..." over the terminal until its first frame paints', async () => {
      seedListedTerminal();
      await renderScreen();
      expect(screen.getByTestId('command-terminal-starting')).toBeTruthy();

      await act(() => {
        useTerminalUiStore.getState().markTerminalPainted(SESSION_ID);
      });

      expect(screen.queryByTestId('command-terminal-starting')).toBeNull();
    });

    it('releases the session screen when it unmounts', async () => {
      seedListedTerminal();
      const { unmount } = await renderScreen();

      await unmount();

      expect(closeSessionScreenMock).toHaveBeenCalledWith(SESSION_ID);
    });
  });

  describe('leaving when the terminal ends', () => {
    beforeEach(() => {
      mockParams = { sessionId: SESSION_ID, projectId: PROJECT_ID };
    });

    it('stays put while the terminal lives', async () => {
      seedListedTerminal();
      await renderScreen();
      await act(() => {
        classifyAgent();
      });

      expect(mockBack).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('goes back on a session-ended for the bound session', async () => {
      seedListedTerminal();
      await renderScreen();

      await act(() => {
        pushActivityEvent({ type: 'session-ended', intentional: true });
      });

      expect(mockBack).toHaveBeenCalledTimes(1);
    });

    it('ignores a session-ended for some other session', async () => {
      seedListedTerminal();
      await renderScreen();

      await act(() => {
        pushActivityEvent({ type: 'session-ended', intentional: true }, 'some-other-session');
      });

      expect(mockBack).not.toHaveBeenCalled();
    });

    it('goes home instead of back when there is nothing behind it', async () => {
      mockCanGoBack.mockReturnValue(false);
      seedListedTerminal();
      await renderScreen();

      await act(() => {
        pushActivityEvent({ type: 'session-ended', intentional: false });
      });

      expect(mockBack).not.toHaveBeenCalled();
      expect(mockReplace).toHaveBeenCalledWith('/');
    });

    it('goes back when a terminal that was listed disappears from the board', async () => {
      seedListedTerminal();
      await renderScreen();
      expect(mockBack).not.toHaveBeenCalled();

      await act(() => {
        setBoardCommandTerminals(PROJECT_ID, []);
      });

      expect(mockBack).toHaveBeenCalledTimes(1);
    });

    describe('for a terminal no board lists', () => {
      beforeEach(() => {
        jest.useFakeTimers();
        // The board has loaded and does not list it: the notification-tapped-after-it-ended shape.
        seedCommandTerminalBoard({ terminals: [] });
        mockParams = { sessionId: 'ghost-terminal', projectId: PROJECT_ID };
      });

      it('waits out UNLISTED_TERMINAL_GRACE_MS, and not a moment less, before going back', async () => {
        await renderScreen();

        await act(() => {
          jest.advanceTimersByTime(UNLISTED_TERMINAL_GRACE_MS - 1);
        });
        expect(mockBack).not.toHaveBeenCalled();

        await act(() => {
          jest.advanceTimersByTime(1);
        });
        expect(mockBack).toHaveBeenCalledTimes(1);
      });

      it('stays when the board lists it inside the grace (a refresh that was still in flight)', async () => {
        await renderScreen();
        await act(() => {
          jest.advanceTimersByTime(UNLISTED_TERMINAL_GRACE_MS - 1_000);
        });

        await act(() => {
          setBoardCommandTerminals(PROJECT_ID, [commandTerminalWireFixture({ sessionId: 'ghost-terminal', projectId: PROJECT_ID })]);
        });
        await act(() => {
          jest.advanceTimersByTime(UNLISTED_TERMINAL_GRACE_MS * 5);
        });

        expect(mockBack).not.toHaveBeenCalled();
      });

      it('never goes back while its board has not loaded, since an absent listing then says nothing', async () => {
        useBoardStore.getState().reset();
        await renderScreen();

        await act(() => {
          jest.advanceTimersByTime(UNLISTED_TERMINAL_GRACE_MS * 5);
        });

        expect(mockBack).not.toHaveBeenCalled();
      });

      it('never goes back on the grace when the route carries no project to check a board for', async () => {
        mockParams = { sessionId: 'ghost-terminal' };
        await renderScreen();

        await act(() => {
          jest.advanceTimersByTime(UNLISTED_TERMINAL_GRACE_MS * 5);
        });

        expect(mockBack).not.toHaveBeenCalled();
      });
    });
  });

  describe('Stop', () => {
    beforeEach(() => {
      mockParams = { sessionId: SESSION_ID, projectId: PROJECT_ID };
      seedListedTerminal();
    });

    it('stops THIS terminal once, with no confirmation, and goes straight back', async () => {
      await renderScreen();

      await fireEvent.press(screen.getByTestId('command-terminal-stop'));

      expect(mockStopCommandTerminal).toHaveBeenCalledTimes(1);
      expect(mockStopCommandTerminal).toHaveBeenCalledWith(SESSION_ID);
      expect(mockBack).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/confirm|are you sure/i)).toBeNull();
    });

    it('goes home when there is nothing behind it', async () => {
      mockCanGoBack.mockReturnValue(false);
      await renderScreen();

      await fireEvent.press(screen.getByTestId('command-terminal-stop'));

      expect(mockStopCommandTerminal).toHaveBeenCalledWith(SESSION_ID);
      expect(mockReplace).toHaveBeenCalledWith('/');
    });
  });

  describe('the header marks', () => {
    beforeEach(() => {
      mockParams = { sessionId: SESSION_ID, projectId: PROJECT_ID };
      seedListedTerminal();
      // The stream feed registers a listed terminal's entry; an activity event
      // for a session with no entry is dropped.
      useActivityStore.getState().registerCommandTerminal(SESSION_ID, PROJECT_ID);
    });

    it('rests muted while the terminal starts', async () => {
      await renderScreen();

      expect(screen.getByTestId('command-terminal-mark-rest')).toBeTruthy();
      expect(screen.getByTestId('command-terminal-stop-mark-rest')).toBeTruthy();
    });

    it('is green once it works, and amber once it needs you', async () => {
      await renderScreen();

      await act(() => {
        classifyAgent();
      });
      expect(screen.getByTestId('command-terminal-mark-working')).toBeTruthy();
      expect(screen.getByTestId('command-terminal-stop-mark-working')).toBeTruthy();

      await act(() => {
        pushActivityEvent({ type: 'activity', state: 'idle', reason: { kind: 'idle' } });
      });
      expect(screen.getByTestId('command-terminal-mark-needs-you')).toBeTruthy();
      expect(screen.getByTestId('command-terminal-stop-mark-needs-you')).toBeTruthy();
    });
  });

  /**
   * THE INPUT GATE. Before the desktop has classified the terminal's agent
   * (`activityObserved`), the PTY can be a bare shell at the project root, and
   * keeping it untyped is the phone's half of the promise that the
   * `command-terminal` verb adds no shell reach. The screen holds input in
   * TWO places that must agree: the terminal pane (`inputEnabled` on
   * TerminalTab, which is what the pane's own message handler and the
   * direct-key field honour) and the footer (the quick keys and the composer
   * go inert and leave the accessibility tree).
   *
   * Both states are asserted, in the same test, so a gate that was open all
   * along cannot pass as held and a gate that never opens cannot pass as open.
   */
  describe('the input gate', () => {
    beforeEach(() => {
      mockParams = { sessionId: SESSION_ID, projectId: PROJECT_ID };
      seedListedTerminal();
      useActivityStore.getState().registerCommandTerminal(SESSION_ID, PROJECT_ID);
    });

    it('holds input in the pane and the footer until the agent is classified, then opens both', async () => {
      await renderScreen();

      // Before: registered but never classified.
      expect(useActivityStore.getState().bySessionId[SESSION_ID]?.activityObserved).toBe(false);
      expect(mockTerminalTabProps.current?.inputEnabled).toBe(false);
      expect(inputRow().props.pointerEvents).toBe('none');
      expect(inputRow().props.accessibilityElementsHidden).toBe(true);
      expect(inputRow().props.importantForAccessibility).toBe('no-hide-descendants');

      await act(() => {
        classifyAgent();
      });

      // After: the desktop has spoken for the agent.
      expect(useActivityStore.getState().bySessionId[SESSION_ID]?.activityObserved).toBe(true);
      expect(mockTerminalTabProps.current?.inputEnabled).toBe(true);
      expect(inputRow().props.pointerEvents).toBe('auto');
      expect(inputRow().props.accessibilityElementsHidden).toBe(false);
      expect(inputRow().props.importantForAccessibility).toBe('auto');
    });

    it('starts open for a terminal whose agent was classified before the screen opened', async () => {
      classifyAgent();
      await renderScreen();

      expect(mockTerminalTabProps.current?.inputEnabled).toBe(true);
      expect(inputRow().props.pointerEvents).toBe('auto');
    });

    it('sends no quick key while held, and sends it once open', async () => {
      await renderScreen();

      await fireEvent.press(screen.getByTestId('quick-key-esc', { includeHiddenElements: true }));
      expect(mockWriteTerminal).not.toHaveBeenCalled();

      await act(() => {
        classifyAgent();
      });
      await fireEvent.press(screen.getByTestId('quick-key-esc'));

      expect(mockWriteTerminal).toHaveBeenCalledTimes(1);
      expect(mockWriteTerminal).toHaveBeenCalledWith(SESSION_ID, expect.any(String));
    });

    it('holds the composer too: the chat lens footer is inert while held', async () => {
      await renderScreen();

      await fireEvent.press(screen.getByTestId('session-mode-chat'));

      expect(inputRow().props.pointerEvents).toBe('none');
      expect(screen.queryByTestId('composer-input')).toBeNull();
      expect(screen.getByTestId('composer-input', { includeHiddenElements: true })).toBeTruthy();

      await act(() => {
        classifyAgent();
      });

      expect(inputRow().props.pointerEvents).toBe('auto');
      expect(screen.getByTestId('composer-input')).toBeTruthy();
    });

    it('opens on a permission prompt too, since an agent that is asking is an agent that is up', async () => {
      await renderScreen();
      expect(mockTerminalTabProps.current?.inputEnabled).toBe(false);

      await act(() => {
        pushActivityEvent({ type: 'permission', promptId: `${SESSION_ID}:tool-1`, pending: true });
      });

      expect(mockTerminalTabProps.current?.inputEnabled).toBe(true);
    });

    it('stays held on a snapshot that carries no activity state, which is the desktop saying it has not classified the agent', async () => {
      await renderScreen();

      await act(() => {
        useActivityStore
          .getState()
          .applySnapshot(SESSION_ID, '', PROJECT_ID, streamSnapshotFixture({ activity: { state: null, reason: null } }));
      });

      expect(mockTerminalTabProps.current?.inputEnabled).toBe(false);
      expect(inputRow().props.pointerEvents).toBe('none');
    });

    it('opens on a snapshot that carries an activity state', async () => {
      await renderScreen();

      await act(() => {
        useActivityStore
          .getState()
          .applySnapshot(SESSION_ID, '', PROJECT_ID, streamSnapshotFixture({ activity: { state: 'idle', reason: null } }));
      });

      expect(mockTerminalTabProps.current?.inputEnabled).toBe(true);
      expect(inputRow().props.pointerEvents).toBe('auto');
    });
  });
});
