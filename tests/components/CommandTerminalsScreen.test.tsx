import React from 'react';
import { StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { NOW_TICK_MS, ThemeProvider } from '@/components';
import { CommandTerminalsScreen, EARLIER_READ_FAILED_MESSAGE, STOP_FAILED_MESSAGE } from '@/screens/CommandTerminalsScreen';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useCommandTerminalStore } from '@/state/commandTerminalStore';
import { streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { commandTerminalWireFixture, seedCommandTerminalBoard, setBoardCommandTerminals } from '../helpers/commandTerminals';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
const mockReplace = jest.fn();
const mockCanGoBack = jest.fn(() => true);
let mockParams: { projectId?: string } = { projectId: 'project-1' };
// ONE router object, as expo-router's own is: the empty-sheet effect is keyed on it.
const mockRouter = { back: mockBack, replace: mockReplace, canGoBack: mockCanGoBack };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}));

const mockLaunchCommandTerminal = jest.fn();
const mockStopCommandTerminal = jest.fn();
const mockResumeCommandTerminal = jest.fn();
const mockFetchEarlierConversations = jest.fn();
jest.mock('@/connection/actions', () => ({
  launchCommandTerminal: (projectId: string) => mockLaunchCommandTerminal(projectId),
  stopCommandTerminal: (sessionId: string) => mockStopCommandTerminal(sessionId),
  resumeCommandTerminal: (projectId: string, conversation: unknown) => mockResumeCommandTerminal(projectId, conversation),
  fetchEarlierConversations: (projectId: string) => mockFetchEarlierConversations(projectId),
}));

const PROJECT_ID = 'project-1';

function terminalFixture(slot: number): ReturnType<typeof commandTerminalWireFixture> {
  return commandTerminalWireFixture({ sessionId: `terminal-${slot}`, slot, name: `Command Terminal ${slot}` });
}

async function renderSheet(): Promise<void> {
  await render(
    <ThemeProvider>
      <CommandTerminalsScreen />
    </ThemeProvider>,
  );
}

function observeTerminal(sessionId: string, state: 'thinking' | 'idle' | 'permission' = 'thinking'): void {
  useActivityStore.getState().registerCommandTerminal(sessionId, PROJECT_ID);
  useActivityStore.getState().applySnapshot(sessionId, '', PROJECT_ID, streamSnapshotFixture({ activity: { state, reason: null } }));
}

describe('CommandTerminalsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockCanGoBack.mockReturnValue(true);
    mockParams = { projectId: PROJECT_ID };
    mockLaunchCommandTerminal.mockReturnValue('launch-from-sheet');
    mockStopCommandTerminal.mockResolvedValue(undefined);
    mockResumeCommandTerminal.mockReturnValue('launch-resume');
    mockFetchEarlierConversations.mockResolvedValue(undefined);
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useCommandTerminalStore.getState().reset();
    seedCommandTerminalBoard({ terminals: [terminalFixture(1), terminalFixture(2)] });
  });

  describe('the list', () => {
    it('titles itself "Command Terminals" with no count line under it', async () => {
      await renderSheet();

      expect(screen.getByText('Command Terminals')).toBeTruthy();
      // The design drops the count: the title and the rows are the whole header.
      expect(screen.queryByText(/\brunning\b/i)).toBeNull();
      expect(screen.queryByText(/\b\d+ terminals?\b/i)).toBeNull();
    });

    it('draws one row per terminal with its name', async () => {
      await renderSheet();

      expect(screen.getByTestId('command-terminal-row-terminal-1')).toBeTruthy();
      expect(screen.getByTestId('command-terminal-row-terminal-2')).toBeTruthy();
      expect(screen.getByText('Command Terminal 1')).toBeTruthy();
      expect(screen.getByText('Command Terminal 2')).toBeTruthy();
    });

    it('lists the project\'s terminals in slot order, whatever order the board hands them in', async () => {
      setBoardCommandTerminals(PROJECT_ID, [terminalFixture(2), terminalFixture(1)]);
      await renderSheet();

      const rowTestIds = screen
        .getAllByTestId(/^command-terminal-row-terminal-\d$/)
        .map((row) => row.props.testID as string);
      expect(rowTestIds).toEqual(['command-terminal-row-terminal-1', 'command-terminal-row-terminal-2']);
    });

    it('does not list another project\'s terminals', async () => {
      const projectBoard = useBoardStore.getState().boardsByProjectId[PROJECT_ID];
      if (projectBoard === undefined) throw new Error('the beforeEach seeds project-1');
      useBoardStore.setState((state) => ({
        boardsByProjectId: {
          ...state.boardsByProjectId,
          'project-2': {
            ...projectBoard,
            commandTerminals: [commandTerminalWireFixture({ sessionId: 'terminal-elsewhere', projectId: 'project-2', slot: 1, name: 'Elsewhere' })],
          },
        },
      }));
      await renderSheet();

      expect(screen.queryByTestId('command-terminal-row-terminal-elsewhere')).toBeNull();
      expect(screen.queryByText('Elsewhere')).toBeNull();
    });

    it('reads "Starting..." for a terminal the desktop has not classified yet', async () => {
      await renderSheet();

      expect(screen.getByTestId('command-terminal-row-terminal-1-activity')).toHaveTextContent('Starting...');
    });

    it('draws the desktop\'s own words for what a terminal is doing, from its activity event', async () => {
      observeTerminal('terminal-1');
      await renderSheet();
      expect(screen.getByTestId('command-terminal-row-terminal-1-activity')).toHaveTextContent('Thinking');

      await act(() => {
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId: 'terminal-1',
          taskId: '',
          payload: { type: 'activity', state: 'thinking', reason: { kind: 'tool', pendingCount: 1, currentTool: 'Bash' } },
        });
      });

      expect(screen.getByTestId('command-terminal-row-terminal-1-activity')).toHaveTextContent('Running Bash');
    });

    it('reads "Waiting on you" for a terminal that is asking without a wait kind', async () => {
      observeTerminal('terminal-1');
      await renderSheet();

      await act(() => {
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId: 'terminal-1',
          taskId: '',
          payload: { type: 'permission', promptId: 'terminal-1:tool-1', pending: true },
        });
      });

      expect(screen.getByTestId('command-terminal-row-terminal-1-activity')).toHaveTextContent('Waiting on you');
    });

    it('draws a start in flight as a disabled row with no Stop, taking its predicted slot', async () => {
      useCommandTerminalStore.getState().beginLaunch(PROJECT_ID, 3);
      await renderSheet();

      const startingRow = screen.getByTestId('command-terminal-row-starting-3');
      expect(startingRow).toBeTruthy();
      expect(screen.getByText('Command Terminal 3')).toBeTruthy();
      expect(screen.getByTestId('command-terminal-row-starting-3-activity')).toHaveTextContent('Starting...');
      expect(startingRow.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
      expect(screen.queryByTestId('command-terminal-row-starting-3-stop')).toBeNull();

      await fireEvent.press(startingRow);
      expect(mockReplace).not.toHaveBeenCalled();
    });
  });

  describe('opening a terminal', () => {
    it('replaces the sheet with the terminal rather than pushing over it', async () => {
      await renderSheet();

      await fireEvent.press(screen.getByTestId('command-terminal-row-terminal-2'));

      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith({
        pathname: '/command-terminal',
        params: { sessionId: 'terminal-2', projectId: PROJECT_ID },
      });
    });

    it('lists nothing and disables New when the route carries no project', async () => {
      mockParams = {};
      await renderSheet();

      expect(screen.queryByTestId('command-terminal-row-terminal-1')).toBeNull();
      const newButton = screen.getByTestId('command-terminals-new');
      expect(newButton.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
      await fireEvent.press(newButton);
      expect(mockLaunchCommandTerminal).not.toHaveBeenCalled();
    });
  });

  describe('Stop', () => {
    it('stops the terminal on ONE tap, with no confirmation, and does not open the row beneath it', async () => {
      await renderSheet();

      await fireEvent.press(screen.getByTestId('command-terminal-row-terminal-2-stop'));

      expect(mockStopCommandTerminal).toHaveBeenCalledTimes(1);
      expect(mockStopCommandTerminal).toHaveBeenCalledWith('terminal-2');
      // The Stop sits inside the row's own Pressable: its tap must not also open the terminal.
      expect(mockReplace).not.toHaveBeenCalled();
      expect(screen.queryByText(/confirm|are you sure/i)).toBeNull();
    });

    it('reads "Stopping..." with the spinner and no Stop while the stop is in flight', async () => {
      await renderSheet();
      expect(screen.getByTestId('command-terminal-row-terminal-1-stop')).toBeTruthy();

      await act(() => {
        useCommandTerminalStore.getState().markStopping('terminal-1');
      });

      expect(screen.getByTestId('command-terminal-row-terminal-1-activity')).toHaveTextContent('Stopping...');
      expect(screen.getByTestId('command-terminal-row-terminal-1-stopping')).toBeTruthy();
      expect(screen.queryByTestId('command-terminal-row-terminal-1-stop')).toBeNull();
      // The other row is untouched.
      expect(screen.getByTestId('command-terminal-row-terminal-2-stop')).toBeTruthy();
      expect(screen.queryByTestId('command-terminal-row-terminal-2-stopping')).toBeNull();
    });

    it('takes no tap on a row that is stopping', async () => {
      useCommandTerminalStore.getState().markStopping('terminal-1');
      await renderSheet();

      const stoppingRow = screen.getByTestId('command-terminal-row-terminal-1');
      expect(stoppingRow.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
      await fireEvent.press(stoppingRow);

      expect(mockReplace).not.toHaveBeenCalled();
      expect(mockStopCommandTerminal).not.toHaveBeenCalled();
    });

    it('shows no failure line until a stop is refused', async () => {
      await renderSheet();

      expect(screen.queryByTestId('command-terminals-stop-failed')).toBeNull();
    });

    it('shows the failure line under the list, and gives the row its Stop back, when a stop failed', async () => {
      await renderSheet();
      await act(() => {
        useCommandTerminalStore.getState().markStopping('terminal-1');
      });
      expect(screen.queryByTestId('command-terminals-stop-failed')).toBeNull();

      await act(() => {
        useCommandTerminalStore.getState().markStopFailed('terminal-1');
      });

      expect(screen.getByTestId('command-terminals-stop-failed')).toHaveTextContent('Stop failed - check the connection');
      expect(STOP_FAILED_MESSAGE).toBe('Stop failed - check the connection');
      expect(screen.getByTestId('command-terminal-row-terminal-1-stop')).toBeTruthy();
      expect(screen.queryByTestId('command-terminal-row-terminal-1-stopping')).toBeNull();
    });

    it('shows the failure line when ANY row\'s stop failed, once, not per row', async () => {
      useCommandTerminalStore.getState().markStopFailed('terminal-2');
      useCommandTerminalStore.getState().markStopFailed('terminal-1');
      await renderSheet();

      expect(screen.getAllByTestId('command-terminals-stop-failed')).toHaveLength(1);
    });

    it('drops the failure line once the failed stop is cleared', async () => {
      useCommandTerminalStore.getState().markStopFailed('terminal-1');
      await renderSheet();
      expect(screen.getByTestId('command-terminals-stop-failed')).toBeTruthy();

      await act(() => {
        useCommandTerminalStore.getState().clearStop('terminal-1');
      });

      expect(screen.queryByTestId('command-terminals-stop-failed')).toBeNull();
    });
  });

  /**
   * A row is ONE accessibility element (an accessible view groups its children
   * on iOS), so the Stop button nested in it is unreachable to a screen reader.
   * The row offers Stop as its own custom action instead, or a screen reader
   * could open a terminal from this sheet but never stop one.
   */
  describe('Stop as a screen reader action', () => {
    function fireAccessibilityAction(rowTestId: string, actionName: string): Promise<unknown> {
      return fireEvent(screen.getByTestId(rowTestId), 'accessibilityAction', { nativeEvent: { actionName } });
    }

    it('offers Stop as an action on a running row', async () => {
      await renderSheet();

      expect(screen.getByTestId('command-terminal-row-terminal-1').props.accessibilityActions).toEqual([{ name: 'stop', label: 'Stop' }]);
    });

    it('stops that row\'s terminal when the action is fired, and opens nothing', async () => {
      await renderSheet();

      await fireAccessibilityAction('command-terminal-row-terminal-2', 'stop');

      expect(mockStopCommandTerminal).toHaveBeenCalledTimes(1);
      expect(mockStopCommandTerminal).toHaveBeenCalledWith('terminal-2');
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('ignores an action it did not advertise', async () => {
      await renderSheet();

      await fireAccessibilityAction('command-terminal-row-terminal-1', 'activate');

      expect(mockStopCommandTerminal).not.toHaveBeenCalled();
    });

    it('offers no action on a row that is stopping', async () => {
      useCommandTerminalStore.getState().markStopping('terminal-1');
      await renderSheet();

      expect(screen.getByTestId('command-terminal-row-terminal-1').props.accessibilityActions).toBeUndefined();
      // The control: the other row still offers it, so the absence above is the stopping state's.
      expect(screen.getByTestId('command-terminal-row-terminal-2').props.accessibilityActions).toEqual([{ name: 'stop', label: 'Stop' }]);
    });

    it('offers no action on a start still in flight, which has no session to stop', async () => {
      useCommandTerminalStore.getState().beginLaunch(PROJECT_ID, 3);
      await renderSheet();

      expect(screen.getByTestId('command-terminal-row-starting-3').props.accessibilityActions).toBeUndefined();
    });
  });

  describe('New terminal', () => {
    it('starts a terminal in this project and replaces the sheet with its screen on the launch', async () => {
      await renderSheet();

      await fireEvent.press(screen.getByTestId('command-terminals-new'));

      expect(mockLaunchCommandTerminal).toHaveBeenCalledTimes(1);
      expect(mockLaunchCommandTerminal).toHaveBeenCalledWith(PROJECT_ID);
      expect(mockReplace).toHaveBeenCalledTimes(1);
      expect(mockReplace).toHaveBeenCalledWith({
        pathname: '/command-terminal',
        params: { launchId: 'launch-from-sheet', projectId: PROJECT_ID },
      });
    });

    it('is enabled below four', async () => {
      seedCommandTerminalBoard({ terminals: [terminalFixture(1), terminalFixture(2), terminalFixture(3)] });
      await renderSheet();

      expect(screen.getByTestId('command-terminals-new').props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
    });

    it('is disabled at four listed terminals, and a tap starts nothing', async () => {
      seedCommandTerminalBoard({ terminals: [terminalFixture(1), terminalFixture(2), terminalFixture(3), terminalFixture(4)] });
      await renderSheet();

      const newButton = screen.getByTestId('command-terminals-new');
      expect(newButton.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
      await fireEvent.press(newButton);

      expect(mockLaunchCommandTerminal).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    /**
     * The Board's header button hides when the desktop stops offering the verb
     * (`commandTerminalsOffered`, protocol 0.20.0), but a sheet already open
     * stays open with its rows. New is the only thing on it that STARTS a
     * terminal, so it must stop offering itself rather than send a
     * `command-terminal` start the desktop will refuse. Terminals are listed so
     * the empty-sheet effect does not close the sheet before the assertions.
     */
    it('is disabled when the desktop does not offer Command Terminals, and a tap starts nothing', async () => {
      seedCommandTerminalBoard({ terminals: [terminalFixture(1), terminalFixture(2)], offered: false });
      await renderSheet();

      const newButton = screen.getByTestId('command-terminals-new');
      expect(newButton.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
      await fireEvent.press(newButton);

      expect(mockLaunchCommandTerminal).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('keeps listing and opening the rows it already has when New is not offered', async () => {
      seedCommandTerminalBoard({ terminals: [terminalFixture(1), terminalFixture(2)], offered: false });
      await renderSheet();

      await fireEvent.press(screen.getByTestId('command-terminal-row-terminal-2'));

      expect(mockReplace).toHaveBeenCalledWith({
        pathname: '/command-terminal',
        params: { sessionId: 'terminal-2', projectId: PROJECT_ID },
      });
    });

    it('is enabled again once the desktop offers the verb', async () => {
      seedCommandTerminalBoard({ terminals: [terminalFixture(1), terminalFixture(2)], offered: false });
      await renderSheet();
      expect(screen.getByTestId('command-terminals-new').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));

      await act(() => {
        seedCommandTerminalBoard({ terminals: [terminalFixture(1), terminalFixture(2)], offered: true });
      });

      expect(screen.getByTestId('command-terminals-new').props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));
      await fireEvent.press(screen.getByTestId('command-terminals-new'));
      expect(mockLaunchCommandTerminal).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('counts a start in flight toward the four, so a second New does not look allowed', async () => {
      seedCommandTerminalBoard({ terminals: [terminalFixture(1), terminalFixture(2), terminalFixture(3)] });
      useCommandTerminalStore.getState().beginLaunch(PROJECT_ID, 4);
      await renderSheet();

      const newButton = screen.getByTestId('command-terminals-new');
      expect(newButton.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
      await fireEvent.press(newButton);
      expect(mockLaunchCommandTerminal).not.toHaveBeenCalled();
    });

    it('goes from enabled to disabled as the fourth terminal lands', async () => {
      seedCommandTerminalBoard({ terminals: [terminalFixture(1), terminalFixture(2), terminalFixture(3)] });
      await renderSheet();
      expect(screen.getByTestId('command-terminals-new').props.accessibilityState).toEqual(expect.objectContaining({ disabled: false }));

      await act(() => {
        setBoardCommandTerminals(PROJECT_ID, [terminalFixture(1), terminalFixture(2), terminalFixture(3), terminalFixture(4)]);
      });

      expect(screen.getByTestId('command-terminals-new').props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
    });
  });

  describe('closing when empty', () => {
    it('stays open while the project has terminals, and closes when the last one leaves the board', async () => {
      await renderSheet();
      expect(mockBack).not.toHaveBeenCalled();

      await act(() => {
        setBoardCommandTerminals(PROJECT_ID, [terminalFixture(2)]);
      });
      expect(mockBack).not.toHaveBeenCalled();

      await act(() => {
        setBoardCommandTerminals(PROJECT_ID, []);
      });

      expect(mockBack).toHaveBeenCalledTimes(1);
    });

    it('does not close for a start in flight with nothing listed, since that row is still a terminal', async () => {
      seedCommandTerminalBoard({ terminals: [] });
      useCommandTerminalStore.getState().beginLaunch(PROJECT_ID, 1);
      await renderSheet();

      expect(mockBack).not.toHaveBeenCalled();
    });

    it('does not pop when there is nothing to go back to', async () => {
      mockCanGoBack.mockReturnValue(false);
      seedCommandTerminalBoard({ terminals: [] });
      await renderSheet();

      expect(mockBack).not.toHaveBeenCalled();
    });
  });

  /**
   * Protocol 0.24.0's Earlier list (task #160, design changes 1 to 7, picks
   * A1, B1, C1): the desktop panel's ended conversations, under New, with the
   * Running heading over the live rows while it shows.
   */
  describe('the Earlier list', () => {
    const twoHoursAgo = (): string => new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const yesterday = (): string => new Date(Date.now() - 30 * 60 * 60 * 1000).toISOString();
    const audit = { agentSessionId: 'conversation-a', name: 'Audit image sizes on the product grid', endedAt: '' };
    const untitled = { agentSessionId: 'conversation-b', name: null, endedAt: '' };

    function holdEarlier(conversations: { agentSessionId: string; name: string | null; endedAt: string }[]): void {
      useCommandTerminalStore.getState().setEarlier(PROJECT_ID, conversations);
    }

    beforeEach(() => {
      seedCommandTerminalBoard({ terminals: [terminalFixture(1)], earlierOffered: true });
      holdEarlier([
        { ...audit, endedAt: twoHoursAgo() },
        { ...untitled, endedAt: yesterday() },
      ]);
    });

    it('reads the list on opening', async () => {
      await renderSheet();

      expect(mockFetchEarlierConversations).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('reads nothing from a desktop that does not offer Earlier, and reads once the offer arrives', async () => {
      seedCommandTerminalBoard({ terminals: [terminalFixture(1)], earlierOffered: false });
      await renderSheet();
      expect(mockFetchEarlierConversations).not.toHaveBeenCalled();

      await act(() => {
        seedCommandTerminalBoard({ terminals: [terminalFixture(1)], earlierOffered: true });
      });

      expect(mockFetchEarlierConversations).toHaveBeenCalledWith(PROJECT_ID);
    });

    it('draws each conversation as its name over when it ended, newest first, under the rule and the Earlier heading', async () => {
      await renderSheet();

      expect(screen.getByTestId('command-terminals-earlier-rule')).toBeTruthy();
      expect(screen.getByTestId('command-terminals-earlier-heading')).toHaveTextContent('Earlier');
      expect(screen.getByTestId('command-terminal-earlier-row-conversation-a-name')).toHaveTextContent('Audit image sizes on the product grid');
      expect(screen.getByTestId('command-terminal-earlier-row-conversation-a-ended')).toHaveTextContent('2 hours ago');
      expect(screen.getByTestId('command-terminal-earlier-row-conversation-b-ended')).toHaveTextContent('yesterday');
      const rowIds = screen.getAllByTestId(/^command-terminal-earlier-row-conversation-[ab]$/).map((row) => row.props.testID as string);
      expect(rowIds).toEqual(['command-terminal-earlier-row-conversation-a', 'command-terminal-earlier-row-conversation-b']);
    });

    it('reads a conversation with no name as "Untitled conversation", the desktop\'s words, and labels the row to resume it', async () => {
      await renderSheet();

      expect(screen.getByTestId('command-terminal-earlier-row-conversation-b-name')).toHaveTextContent('Untitled conversation');
      expect(screen.getByTestId('command-terminal-earlier-row-conversation-b').props.accessibilityLabel).toBe('Resume Untitled conversation');
    });

    it('heads the live rows "Running" while the Earlier list shows (decision B1)', async () => {
      await renderSheet();

      expect(screen.getByTestId('command-terminals-running-heading')).toHaveTextContent('Running');
    });

    it('draws today\'s sheet, with no heading, rule or list, when the desktop does not offer Earlier', async () => {
      seedCommandTerminalBoard({ terminals: [terminalFixture(1)], earlierOffered: false });
      await renderSheet();

      expect(screen.queryByTestId('command-terminals-running-heading')).toBeNull();
      expect(screen.queryByTestId('command-terminals-earlier-rule')).toBeNull();
      expect(screen.queryByTestId('command-terminals-earlier-heading')).toBeNull();
      expect(screen.queryByTestId('command-terminal-earlier-row-conversation-a')).toBeNull();
    });

    it('draws no Earlier section, and no Running heading, when nothing has ended (the desktop\'s own empty state)', async () => {
      holdEarlier([]);
      await renderSheet();

      expect(screen.queryByTestId('command-terminals-earlier-heading')).toBeNull();
      expect(screen.queryByTestId('command-terminals-running-heading')).toBeNull();
    });

    it('draws nothing of it before its first read lands', async () => {
      useCommandTerminalStore.getState().reset();
      useCommandTerminalStore.getState().markEarlierLoading(PROJECT_ID);
      await renderSheet();

      expect(screen.queryByTestId('command-terminals-earlier-heading')).toBeNull();
      expect(screen.queryByTestId('command-terminals-earlier-failed')).toBeNull();
    });

    it('says the list did not load when its read failed with nothing held (design change 7)', async () => {
      useCommandTerminalStore.getState().reset();
      useCommandTerminalStore.getState().markEarlierFailed(PROJECT_ID);
      await renderSheet();

      expect(screen.getByTestId('command-terminals-earlier-heading')).toBeTruthy();
      expect(screen.getByTestId('command-terminals-earlier-failed')).toHaveTextContent("Earlier didn't load - check the connection");
      expect(EARLIER_READ_FAILED_MESSAGE).toBe("Earlier didn't load - check the connection");
    });

    it('keeps the rows it holds, with no failure line, when a later read fails', async () => {
      useCommandTerminalStore.getState().markEarlierFailed(PROJECT_ID);
      await renderSheet();

      expect(screen.getByTestId('command-terminal-earlier-row-conversation-a')).toBeTruthy();
      expect(screen.queryByTestId('command-terminals-earlier-failed')).toBeNull();
    });

    it('resumes a conversation on a tap, replacing the sheet with its screen on the launch (decision C1)', async () => {
      await renderSheet();

      await fireEvent.press(screen.getByTestId('command-terminal-earlier-row-conversation-a'));

      expect(mockResumeCommandTerminal).toHaveBeenCalledTimes(1);
      expect(mockResumeCommandTerminal).toHaveBeenCalledWith(PROJECT_ID, expect.objectContaining({ agentSessionId: 'conversation-a' }));
      expect(mockReplace).toHaveBeenCalledWith({ pathname: '/command-terminal', params: { launchId: 'launch-resume', projectId: PROJECT_ID } });
    });

    it('stays put when the resume sends nothing (the desktop stopped offering Earlier)', async () => {
      mockResumeCommandTerminal.mockReturnValue(null);
      await renderSheet();

      await fireEvent.press(screen.getByTestId('command-terminal-earlier-row-conversation-a'));

      expect(mockReplace).not.toHaveBeenCalled();
    });

    it('greys every row out at four terminals, and a tap resumes nothing (design change 6)', async () => {
      seedCommandTerminalBoard({
        terminals: [terminalFixture(1), terminalFixture(2), terminalFixture(3), terminalFixture(4)],
        earlierOffered: true,
      });
      await renderSheet();

      const row = screen.getByTestId('command-terminal-earlier-row-conversation-a');
      expect(row.props.accessibilityState).toEqual(expect.objectContaining({ disabled: true }));
      await fireEvent.press(row);

      expect(mockResumeCommandTerminal).not.toHaveBeenCalled();
      expect(mockReplace).not.toHaveBeenCalled();
    });

    /**
     * Design change 4: a resume in flight is a Running row under the
     * conversation's own name, and its Earlier row is gone from the tap, so the
     * same conversation cannot be sent twice from a reopened sheet.
     */
    it('hides a conversation being resumed and shows it as a starting Running row under its own name', async () => {
      useCommandTerminalStore.getState().beginLaunch(PROJECT_ID, 2, { agentSessionId: 'conversation-a', name: audit.name });
      await renderSheet();

      expect(screen.queryByTestId('command-terminal-earlier-row-conversation-a')).toBeNull();
      expect(screen.getByTestId('command-terminal-earlier-row-conversation-b')).toBeTruthy();
      expect(screen.getByTestId('command-terminal-row-starting-2')).toBeTruthy();
      expect(screen.getByText('Audit image sizes on the product grid')).toBeTruthy();
      expect(screen.getByTestId('command-terminal-row-starting-2-activity')).toHaveTextContent('Starting...');
    });

    it('reads a blank or whitespace-only name as "Untitled conversation", and labels the row to resume it so', async () => {
      holdEarlier([
        { agentSessionId: 'conversation-empty', name: '', endedAt: twoHoursAgo() },
        { agentSessionId: 'conversation-spaces', name: '   ', endedAt: twoHoursAgo() },
      ]);
      await renderSheet();

      for (const agentSessionId of ['conversation-empty', 'conversation-spaces']) {
        const rowTestId = `command-terminal-earlier-row-${agentSessionId}`;
        expect(screen.getByTestId(`${rowTestId}-name`)).toHaveTextContent('Untitled conversation');
        expect(screen.getByTestId(rowTestId).props.accessibilityLabel).toBe('Resume Untitled conversation');
      }
    });

    describe('the list\'s height', () => {
      const ROW_GAP = 4;

      function conversations(count: number): { agentSessionId: string; name: string | null; endedAt: string }[] {
        return Array.from({ length: count }, (_unused, index) => ({
          agentSessionId: `conversation-${index}`,
          name: `Conversation ${index}`,
          endedAt: twoHoursAgo(),
        }));
      }

      function listHeight(): number {
        // The host scroll view carries the testID but not the style: FlashList
        // puts `style` on its own container, so read the nearest ancestor that has it.
        let node = screen.getByTestId('command-terminals-earlier-list').parent;
        while (node !== null) {
          const flattened = StyleSheet.flatten(node.props.style) as { height?: number } | undefined;
          if (flattened?.height !== undefined) return flattened.height;
          node = node.parent;
        }
        throw new Error('the Earlier list carries no explicit height');
      }

      async function layOutFirstRow(height: number): Promise<void> {
        await fireEvent(screen.getByTestId('command-terminal-earlier-row-conversation-0'), 'layout', { nativeEvent: { layout: { height } } });
      }

      it('becomes the rows\' measured height plus the gaps once the first row is laid out', async () => {
        holdEarlier(conversations(3));
        await renderSheet();

        await layOutFirstRow(100);

        expect(listHeight()).toBe(3 * 100 + 2 * ROW_GAP);
      });

      it('ignores a zero-height layout, keeping the last measured height', async () => {
        holdEarlier(conversations(3));
        await renderSheet();
        await layOutFirstRow(100);

        await layOutFirstRow(0);

        expect(listHeight()).toBe(3 * 100 + 2 * ROW_GAP);
      });

      it('is capped at the sheet\'s room, however many rows there are', async () => {
        holdEarlier(conversations(50));
        await renderSheet();

        await layOutFirstRow(100);
        const cappedHeight = listHeight();

        expect(cappedHeight).toBeGreaterThan(0);
        expect(cappedHeight).toBeLessThan(50 * 100 + 49 * ROW_GAP);
        // Taller rows do not move a list that is already at the cap.
        await layOutFirstRow(200);
        expect(listHeight()).toBe(cappedHeight);
      });
    });

    /**
     * The Earlier rows' "ended" labels share the sheet's clock. With no terminal
     * needing you, only the `earlierRows.length > 0` half of the provider's
     * `enabled` keeps it running. Mutation seen failing: `enabled={anyNeedsYou}`.
     */
    describe('the clock', () => {
      afterEach(() => {
        jest.useRealTimers();
      });

      it('moves an ended label on while no terminal needs you', async () => {
        jest.useFakeTimers();
        holdEarlier([{ ...audit, endedAt: new Date(Date.now() - 59 * 60 * 1000).toISOString() }]);
        await renderSheet();
        expect(screen.getByTestId('command-terminal-earlier-row-conversation-a-ended')).toHaveTextContent('59 minutes ago');

        await act(() => {
          jest.advanceTimersByTime(2 * 60 * 1000 + NOW_TICK_MS);
        });

        expect(screen.getByTestId('command-terminal-earlier-row-conversation-a-ended')).toHaveTextContent('1 hour ago');
      });
    });

    describe('closing (design change 2)', () => {
      /**
       * A failed read with nothing held shows its line, so closing would hide
       * it. Mutation seen failing: dropping `&& !earlierReadFailed` from `empty`.
       */
      it('stays open on the failure line when nothing runs, the offer is on and the read failed with nothing held', async () => {
        seedCommandTerminalBoard({ terminals: [], earlierOffered: true });
        useCommandTerminalStore.getState().reset();
        useCommandTerminalStore.getState().markEarlierFailed(PROJECT_ID);
        await renderSheet();

        expect(mockBack).not.toHaveBeenCalled();
        expect(screen.getByTestId('command-terminals-earlier-failed')).toBeTruthy();
      });

      it('stays open when the last terminal leaves the board and THEN the read fails', async () => {
        useCommandTerminalStore.getState().reset();
        useCommandTerminalStore.getState().markEarlierLoading(PROJECT_ID);
        await renderSheet();

        await act(() => {
          setBoardCommandTerminals(PROJECT_ID, []);
        });
        expect(mockBack).not.toHaveBeenCalled();

        await act(() => {
          useCommandTerminalStore.getState().markEarlierFailed(PROJECT_ID);
        });

        expect(mockBack).not.toHaveBeenCalled();
        expect(screen.getByTestId('command-terminals-earlier-failed')).toBeTruthy();
      });

      it('stays open with nothing running while Earlier has rows, and draws no Running heading then', async () => {
        seedCommandTerminalBoard({ terminals: [], earlierOffered: true });
        await renderSheet();

        expect(mockBack).not.toHaveBeenCalled();
        expect(screen.queryByTestId('command-terminals-running-heading')).toBeNull();
        expect(screen.getByTestId('command-terminal-earlier-row-conversation-a')).toBeTruthy();
      });

      /**
       * The last terminal ends with the sheet open: its conversation arrives on
       * the Earlier read the end set off, so the sheet waits for it rather than
       * closing on the board's drop. Mutation seen failing: dropping
       * `!earlierLoading` from the close rule - the sheet pops while loading.
       */
      it('waits for an Earlier read in flight when the last terminal leaves, then closes only if it brings nothing', async () => {
        holdEarlier([]);
        await renderSheet();

        await act(() => {
          useCommandTerminalStore.getState().markEarlierLoading(PROJECT_ID);
          setBoardCommandTerminals(PROJECT_ID, []);
        });
        expect(mockBack).not.toHaveBeenCalled();

        await act(() => {
          holdEarlier([]);
        });
        expect(mockBack).toHaveBeenCalledTimes(1);
      });

      it('stays open on the ended terminal\'s conversation when the read brings it', async () => {
        holdEarlier([]);
        await renderSheet();

        await act(() => {
          useCommandTerminalStore.getState().markEarlierLoading(PROJECT_ID);
          setBoardCommandTerminals(PROJECT_ID, []);
        });
        await act(() => {
          holdEarlier([{ agentSessionId: 'conversation-c', name: 'Fix the flaky checkout e2e test', endedAt: new Date().toISOString() }]);
        });

        expect(mockBack).not.toHaveBeenCalled();
        expect(screen.getByTestId('command-terminal-earlier-row-conversation-c-ended')).toHaveTextContent('just now');
      });
    });
  });
});
