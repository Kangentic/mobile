import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { CommandTerminalsScreen, STOP_FAILED_MESSAGE } from '@/screens/CommandTerminalsScreen';
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
jest.mock('@/connection/actions', () => ({
  launchCommandTerminal: (projectId: string) => mockLaunchCommandTerminal(projectId),
  stopCommandTerminal: (sessionId: string) => mockStopCommandTerminal(sessionId),
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

    it('reads "Awaiting permission" for a terminal that is asking', async () => {
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

      expect(screen.getByTestId('command-terminal-row-terminal-1-activity')).toHaveTextContent('Awaiting permission');
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
});
