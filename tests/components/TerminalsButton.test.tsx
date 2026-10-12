import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { TerminalsButton } from '@/screens/terminals/TerminalsButton';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useCommandTerminalStore } from '@/state/commandTerminalStore';
import { streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { commandTerminalWireFixture, seedCommandTerminalBoard } from '../helpers/commandTerminals';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ push: mockPush }),
}));

const mockLaunchCommandTerminal = jest.fn();
jest.mock('@/connection/actions', () => ({
  launchCommandTerminal: (projectId: string) => mockLaunchCommandTerminal(projectId),
}));

const PROJECT_ID = 'project-1';

async function renderButton(projectId: string = PROJECT_ID): Promise<void> {
  await render(
    <ThemeProvider>
      <TerminalsButton projectId={projectId} />
    </ThemeProvider>,
  );
}

/** A listed terminal whose agent the desktop has classified, in the given activity state. */
function observeTerminal(sessionId: string, state: 'thinking' | 'idle' | 'permission'): void {
  useActivityStore.getState().registerCommandTerminal(sessionId, PROJECT_ID);
  useActivityStore.getState().applySnapshot(sessionId, '', PROJECT_ID, streamSnapshotFixture({ activity: { state, reason: null } }));
}

describe('TerminalsButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLaunchCommandTerminal.mockReturnValue('launch-from-button');
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useCommandTerminalStore.getState().reset();
  });

  describe('when the desktop does not offer the verb', () => {
    it('renders nothing when the board says terminals are not offered', async () => {
      seedCommandTerminalBoard({ offered: false });
      await renderButton();

      expect(screen.queryByTestId('header-terminals-button')).toBeNull();
    });

    it('renders nothing even with terminals listed, since the grant was narrowed', async () => {
      seedCommandTerminalBoard({ offered: false, terminals: [commandTerminalWireFixture()] });
      await renderButton();

      expect(screen.queryByTestId('header-terminals-button')).toBeNull();
    });

    it('renders nothing for a project whose board has not loaded (the flag is absent)', async () => {
      await renderButton('project-never-loaded');

      expect(screen.queryByTestId('header-terminals-button')).toBeNull();
    });
  });

  describe('with none running', () => {
    it('shows the new-terminal mark alone, with no count and no tone mark', async () => {
      seedCommandTerminalBoard();
      await renderButton();

      expect(screen.getByTestId('header-terminals-new')).toBeTruthy();
      expect(screen.queryByTestId('header-terminals-count')).toBeNull();
      expect(screen.queryByTestId('header-terminals-working')).toBeNull();
      expect(screen.queryByTestId('header-terminals-needs-you')).toBeNull();
      expect(screen.getByTestId('header-terminals-button').props.accessibilityLabel).toBe('New Command Terminal');
    });

    it('starts a terminal for this project and pushes its screen on the launch, with no sheet in between', async () => {
      seedCommandTerminalBoard();
      await renderButton();

      await fireEvent.press(screen.getByTestId('header-terminals-button'));

      expect(mockLaunchCommandTerminal).toHaveBeenCalledTimes(1);
      expect(mockLaunchCommandTerminal).toHaveBeenCalledWith(PROJECT_ID);
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/command-terminal',
        params: { launchId: 'launch-from-button', projectId: PROJECT_ID },
      });
    });

    it('addresses the project it was rendered for, not a default', async () => {
      seedCommandTerminalBoard({ projectId: 'project-9', projectName: 'Nine' });
      await renderButton('project-9');

      await fireEvent.press(screen.getByTestId('header-terminals-button'));

      expect(mockLaunchCommandTerminal).toHaveBeenCalledWith('project-9');
      expect(mockPush).toHaveBeenCalledWith({
        pathname: '/command-terminal',
        params: { launchId: 'launch-from-button', projectId: 'project-9' },
      });
    });
  });

  describe('with terminals running', () => {
    it('shows the count and the green mark when every terminal is working', async () => {
      seedCommandTerminalBoard({
        terminals: [
          commandTerminalWireFixture({ sessionId: 'terminal-a', slot: 1 }),
          commandTerminalWireFixture({ sessionId: 'terminal-b', slot: 2, name: 'Command Terminal 2' }),
        ],
      });
      observeTerminal('terminal-a', 'thinking');
      observeTerminal('terminal-b', 'thinking');
      await renderButton();

      expect(screen.getByTestId('header-terminals-count')).toHaveTextContent('2');
      expect(screen.getByTestId('header-terminals-working')).toBeTruthy();
      expect(screen.queryByTestId('header-terminals-needs-you')).toBeNull();
      expect(screen.queryByTestId('header-terminals-new')).toBeNull();
      expect(screen.getByTestId('header-terminals-button').props.accessibilityLabel).toBe('Command Terminals, 2 running');
    });

    it('reads a terminal the desktop has not classified yet as working, not as needing you', async () => {
      seedCommandTerminalBoard({ terminals: [commandTerminalWireFixture({ sessionId: 'terminal-a' })] });
      // Registered but never snapshotted: activityObserved is still false, and
      // its default state is 'idle', which must not read as the user's move yet.
      useActivityStore.getState().registerCommandTerminal('terminal-a', PROJECT_ID);
      await renderButton();

      expect(screen.getByTestId('header-terminals-working')).toBeTruthy();
      expect(screen.queryByTestId('header-terminals-needs-you')).toBeNull();
    });

    it('turns amber when any terminal is idle, even while another works', async () => {
      seedCommandTerminalBoard({
        terminals: [
          commandTerminalWireFixture({ sessionId: 'terminal-a', slot: 1 }),
          commandTerminalWireFixture({ sessionId: 'terminal-b', slot: 2, name: 'Command Terminal 2' }),
        ],
      });
      observeTerminal('terminal-a', 'thinking');
      observeTerminal('terminal-b', 'idle');
      await renderButton();

      expect(screen.getByTestId('header-terminals-needs-you')).toBeTruthy();
      expect(screen.queryByTestId('header-terminals-working')).toBeNull();
      expect(screen.getByTestId('header-terminals-count')).toHaveTextContent('2');
      expect(screen.getByTestId('header-terminals-button').props.accessibilityLabel).toBe('Command Terminals, 2 running, one or more need you');
    });

    it('turns amber when a terminal is asking for permission', async () => {
      seedCommandTerminalBoard({ terminals: [commandTerminalWireFixture({ sessionId: 'terminal-a' })] });
      observeTerminal('terminal-a', 'thinking');
      await renderButton();
      expect(screen.getByTestId('header-terminals-working')).toBeTruthy();

      await act(() => {
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId: 'terminal-a',
          taskId: '',
          payload: { type: 'permission', promptId: 'terminal-a:tool-1', pending: true },
        });
      });

      expect(screen.getByTestId('header-terminals-needs-you')).toBeTruthy();
      expect(screen.queryByTestId('header-terminals-working')).toBeNull();
    });

    it('follows a terminal from needing you back to working as the activity stream moves', async () => {
      seedCommandTerminalBoard({ terminals: [commandTerminalWireFixture({ sessionId: 'terminal-a' })] });
      observeTerminal('terminal-a', 'idle');
      await renderButton();
      expect(screen.getByTestId('header-terminals-needs-you')).toBeTruthy();

      await act(() => {
        useActivityStore.getState().applyActivityEvent({
          kind: 'activity',
          sessionId: 'terminal-a',
          taskId: '',
          payload: { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } },
        });
      });

      expect(screen.getByTestId('header-terminals-working')).toBeTruthy();
      expect(screen.queryByTestId('header-terminals-needs-you')).toBeNull();
    });

    it('counts a start in flight, which takes a slot before the board lists it', async () => {
      seedCommandTerminalBoard({ terminals: [commandTerminalWireFixture({ sessionId: 'terminal-a', slot: 1 })] });
      observeTerminal('terminal-a', 'thinking');
      await renderButton();
      expect(screen.getByTestId('header-terminals-count')).toHaveTextContent('1');

      await act(() => {
        useCommandTerminalStore.getState().beginLaunch(PROJECT_ID, 2);
      });

      expect(screen.getByTestId('header-terminals-count')).toHaveTextContent('2');
    });

    it('turns an in-flight start with nothing else running into the running state, not the new-terminal mark', async () => {
      seedCommandTerminalBoard();
      await renderButton();
      expect(screen.getByTestId('header-terminals-new')).toBeTruthy();

      await act(() => {
        useCommandTerminalStore.getState().beginLaunch(PROJECT_ID, 1);
      });

      expect(screen.getByTestId('header-terminals-count')).toHaveTextContent('1');
      expect(screen.getByTestId('header-terminals-working')).toBeTruthy();
      expect(screen.queryByTestId('header-terminals-new')).toBeNull();
    });

    it('stops counting a start that failed, and ignores another project\'s start', async () => {
      seedCommandTerminalBoard();
      const failedLaunchId = useCommandTerminalStore.getState().beginLaunch(PROJECT_ID, 1);
      useCommandTerminalStore.getState().markLaunchFailed(failedLaunchId, 'The desktop could not start the agent');
      useCommandTerminalStore.getState().beginLaunch('project-other', 1);
      await renderButton();

      expect(screen.getByTestId('header-terminals-new')).toBeTruthy();
      expect(screen.queryByTestId('header-terminals-count')).toBeNull();
    });

    it('opens the Terminals sheet for this project on a tap, and starts nothing', async () => {
      seedCommandTerminalBoard({ terminals: [commandTerminalWireFixture({ sessionId: 'terminal-a' })] });
      observeTerminal('terminal-a', 'thinking');
      await renderButton();

      await fireEvent.press(screen.getByTestId('header-terminals-button'));

      expect(mockLaunchCommandTerminal).not.toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith({ pathname: '/command-terminals', params: { projectId: PROJECT_ID } });
    });

    it('opens the sheet rather than starting another when only a start in flight is running', async () => {
      seedCommandTerminalBoard();
      useCommandTerminalStore.getState().beginLaunch(PROJECT_ID, 1);
      await renderButton();

      await fireEvent.press(screen.getByTestId('header-terminals-button'));

      expect(mockLaunchCommandTerminal).not.toHaveBeenCalled();
      expect(mockPush).toHaveBeenCalledWith({ pathname: '/command-terminals', params: { projectId: PROJECT_ID } });
    });
  });
});
