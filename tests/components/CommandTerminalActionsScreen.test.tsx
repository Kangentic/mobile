import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { CommandTerminalActionsScreen } from '@/screens/CommandTerminalActionsScreen';
import { useBoardStore } from '@/state/boardStore';
import { commandTerminalWireFixture, seedCommandTerminalBoard, setBoardCommandTerminals } from '../helpers/commandTerminals';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
const mockReplace = jest.fn();
let mockParams: { sessionId?: string; projectId?: string } = { sessionId: 'terminal-1', projectId: 'project-1' };
const mockRouter = { back: mockBack, replace: mockReplace, push: jest.fn() };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => mockRouter,
}));

const mockStopCommandTerminal = jest.fn();
jest.mock('@/connection/actions', () => ({
  stopCommandTerminal: (sessionId: string) => mockStopCommandTerminal(sessionId),
}));

async function renderActions(): Promise<void> {
  await render(
    <ThemeProvider>
      <CommandTerminalActionsScreen />
    </ThemeProvider>,
  );
}

function rowIsDisabled(testID: string): boolean {
  return screen.getByTestId(testID).props.accessibilityState.disabled === true;
}

describe('CommandTerminalActionsScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { sessionId: 'terminal-1', projectId: 'project-1' };
    mockStopCommandTerminal.mockResolvedValue(undefined);
    useBoardStore.getState().reset();
    seedCommandTerminalBoard({
      terminals: [
        commandTerminalWireFixture({ sessionId: 'terminal-1', slot: 1, name: 'Fix the flaky login test', named: true }),
        commandTerminalWireFixture({ sessionId: 'terminal-2', slot: 2, name: 'Command Terminal 2' }),
      ],
    });
  });

  it('titles itself with the terminal\'s name, not the other terminal\'s', async () => {
    await renderActions();

    expect(screen.getByText('Fix the flaky login test')).toBeTruthy();
    expect(screen.queryByText('Command Terminal 2')).toBeNull();
  });

  it('falls back to a generic title for a terminal the board no longer lists', async () => {
    mockParams = { sessionId: 'terminal-gone', projectId: 'project-1' };
    await renderActions();

    expect(screen.getByText('Command Terminal')).toBeTruthy();
  });

  it('offers exactly the two actions a terminal has, and no task actions', async () => {
    await renderActions();

    const sheet = screen.getByTestId('command-terminal-actions-sheet');
    expect(within(sheet).getByText('Open terminal')).toBeTruthy();
    expect(within(sheet).getByText('Stop terminal')).toBeTruthy();
    for (const absentLabel of ['Move', 'Edit', 'Archive', 'Delete', 'Pause session', 'Resume session']) {
      expect(within(sheet).queryByText(absentLabel)).toBeNull();
    }
  });

  /**
   * ui-conventions.md, visible tap targets: the sheet's rows are the task
   * actions hub's family, on the shared raised sheet-row surface.
   */
  it.each(['command-terminal-action-open', 'command-terminal-action-stop'])('draws %s on a raised row with a hairline outline', async (testID) => {
    await renderActions();

    const rowSurface = StyleSheet.flatten(screen.getByTestId(testID).props.style as StyleProp<ViewStyle>) as ViewStyle;
    expect(rowSurface.backgroundColor).toBe(darkTerminalTheme.colors.surfaceRaised);
    expect(rowSurface.borderColor).toBe(darkTerminalTheme.colors.border);
    expect(rowSurface.borderWidth).toBe(StyleSheet.hairlineWidth);
  });

  it('replaces the sheet with the terminal on "Open terminal", rather than pushing over it', async () => {
    await renderActions();

    await fireEvent.press(screen.getByTestId('command-terminal-action-open'));

    expect(mockReplace).toHaveBeenCalledTimes(1);
    expect(mockReplace).toHaveBeenCalledWith({
      pathname: '/command-terminal',
      params: { sessionId: 'terminal-1', projectId: 'project-1' },
    });
    expect(mockStopCommandTerminal).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('stops THIS terminal once on "Stop terminal", then closes the sheet', async () => {
    await renderActions();

    await act(async () => {
      await fireEvent.press(screen.getByTestId('command-terminal-action-stop'));
    });

    expect(mockStopCommandTerminal).toHaveBeenCalledTimes(1);
    expect(mockStopCommandTerminal).toHaveBeenCalledWith('terminal-1');
    expect(mockBack).toHaveBeenCalledTimes(1);
    expect(mockReplace).not.toHaveBeenCalled();
  });

  it('enables both rows for a listed terminal', async () => {
    await renderActions();

    expect(rowIsDisabled('command-terminal-action-open')).toBe(false);
    expect(rowIsDisabled('command-terminal-action-stop')).toBe(false);
  });

  it('disables both rows, and acts on neither, when the terminal is not listed', async () => {
    mockParams = { sessionId: 'terminal-gone', projectId: 'project-1' };
    await renderActions();

    expect(rowIsDisabled('command-terminal-action-open')).toBe(true);
    expect(rowIsDisabled('command-terminal-action-stop')).toBe(true);

    await fireEvent.press(screen.getByTestId('command-terminal-action-open'));
    await fireEvent.press(screen.getByTestId('command-terminal-action-stop'));

    expect(mockReplace).not.toHaveBeenCalled();
    expect(mockStopCommandTerminal).not.toHaveBeenCalled();
    expect(mockBack).not.toHaveBeenCalled();
  });

  it('disables both rows when the terminal leaves the board while the sheet is open', async () => {
    await renderActions();
    expect(rowIsDisabled('command-terminal-action-open')).toBe(false);

    await act(() => {
      setBoardCommandTerminals('project-1', [commandTerminalWireFixture({ sessionId: 'terminal-2', slot: 2 })]);
    });

    expect(rowIsDisabled('command-terminal-action-open')).toBe(true);
    expect(rowIsDisabled('command-terminal-action-stop')).toBe(true);
  });

  it.each([
    ['no sessionId', { projectId: 'project-1' }],
    ['no projectId', { sessionId: 'terminal-1' }],
    ['neither', {}],
  ])('disables both rows when the route carries %s', async (_description, params) => {
    mockParams = params;
    await renderActions();

    expect(rowIsDisabled('command-terminal-action-open')).toBe(true);
    expect(rowIsDisabled('command-terminal-action-stop')).toBe(true);
  });
});
