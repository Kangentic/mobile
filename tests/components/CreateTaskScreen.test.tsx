import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { CreateTaskScreen } from '@/screens/CreateTaskScreen';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture } from '@/devsupport/desktopFixtures';
import {
  alignHeightToTextLineGrid,
  clampSheetContentHeight,
  CREATE_SHEET_RESERVED_HEIGHT,
  DESCRIPTION_FLOOR_HEIGHT,
  SHEET_KEYBOARD_ALLOWANCE,
} from '@/lib/sheetContentHeights';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
let mockParams: { projectId?: string } = { projectId: 'project-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: jest.fn(), back: mockBack, push: jest.fn() }),
}));

const mockCreateTask = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/actions', () => ({
  createTask: (input: unknown) => mockCreateTask(input),
}));

function seedBoard(): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [
          boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 }),
          boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 }),
        ],
        tasksById: {},
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
    },
    pendingMoves: [],
  });
}

function renderCreateTaskScreen(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <CreateTaskScreen />
    </ThemeProvider>,
  );
}

describe('CreateTaskScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { projectId: 'project-1' };
    useBoardStore.getState().reset();
    seedBoard();
  });

  /**
   * The column defaults to the board's FIRST column, never whichever one the
   * pager happened to be showing: a new task is new work, not a continuation
   * of whatever was being read.
   */
  it('creates in the first column by default and dismisses the sheet on success', async () => {
    renderCreateTaskScreen();

    fireEvent.changeText(screen.getByTestId('create-task-title'), 'New feature');
    await act(async () => {
      fireEvent.press(screen.getByTestId('create-task-confirm'));
    });

    expect(mockCreateTask).toHaveBeenCalledWith({
      projectId: 'project-1',
      title: 'New feature',
      description: '',
      column: 'To Do',
    });
    // Dismissing IS router.back() now: the sheet is a route, so there is no
    // visible prop for anything to leave stuck open.
    expect(mockBack).toHaveBeenCalled();
  });

  it('sends the tapped column, and offers Backlog alongside the real ones', async () => {
    renderCreateTaskScreen();

    expect(screen.getByTestId('create-task-column-Backlog')).toBeTruthy();
    fireEvent.press(screen.getByTestId('create-task-column-Doing'));
    expect(screen.getByTestId('create-task-column-Doing').props.accessibilityState).toEqual({ selected: true });
    expect(screen.getByTestId('create-task-column-To Do').props.accessibilityState).toEqual({ selected: false });

    fireEvent.changeText(screen.getByTestId('create-task-title'), 'Ship it');
    await act(async () => {
      fireEvent.press(screen.getByTestId('create-task-confirm'));
    });

    expect(mockCreateTask).toHaveBeenCalledWith({
      projectId: 'project-1',
      title: 'Ship it',
      description: '',
      column: 'Doing',
    });
  });

  it('trims the title and blocks confirm on a blank one', async () => {
    renderCreateTaskScreen();

    // Whitespace only: the button stays disabled and nothing is sent.
    fireEvent.changeText(screen.getByTestId('create-task-title'), '   ');
    await act(async () => {
      fireEvent.press(screen.getByTestId('create-task-confirm'));
    });
    expect(mockCreateTask).not.toHaveBeenCalled();

    fireEvent.changeText(screen.getByTestId('create-task-title'), '  Padded  ');
    fireEvent.changeText(screen.getByTestId('create-task-description'), '  notes  ');
    await act(async () => {
      fireEvent.press(screen.getByTestId('create-task-confirm'));
    });
    expect(mockCreateTask).toHaveBeenCalledWith({
      projectId: 'project-1',
      title: 'Padded',
      description: 'notes',
      column: 'To Do',
    });
  });

  /** A failed create keeps the sheet open with the reason, so the typing is not lost. */
  it('surfaces a failure and stays open', async () => {
    mockCreateTask.mockRejectedValueOnce(new Error('relay down'));
    renderCreateTaskScreen();

    fireEvent.changeText(screen.getByTestId('create-task-title'), 'New feature');
    await act(async () => {
      fireEvent.press(screen.getByTestId('create-task-confirm'));
    });

    expect(screen.getByText('Create failed - check the connection')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
    expect(screen.getByTestId('create-task-title').props.value).toBe('New feature');
  });
});

/**
 * The description box's height cap is derived from the window, not fixed: a
 * fixed maxHeight: 420 shipped first and hid the confirm button behind the
 * keyboard on small phones (the 2026-08-15 iOS tester recording). These tests
 * pin the WIRING (windowHeight + insets.bottom + the screen's own budget
 * reach the rendered style), not the derivation math itself, which is
 * pinned separately in tests/unit/sheetContentHeights.test.ts.
 */
describe('CreateTaskScreen description height cap', () => {
  // A non-zero, non-default gesture-bar-shaped inset: with the safe-area
  // mock's default of 0, a screen that forgot to add insets.bottom would
  // pass every assertion below by coincidence.
  const BOTTOM_INSET = 34;
  const HISTORICAL_FIXED_CAP = 420; // the bug this module's derivation replaced

  beforeEach(() => {
    // Deliberately independent of the sibling describe above: do not rely on
    // whatever mockParams/store state its last test happened to leave behind.
    mockParams = { projectId: 'project-1' };
    useBoardStore.getState().reset();
    seedBoard();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  function mockWindowHeight(height: number): void {
    jest.spyOn(Dimensions, 'get').mockImplementation(() => ({ width: 400, height, scale: 2, fontScale: 1 }));
  }

  function renderWithInsets(): ReturnType<typeof render> {
    return render(
      <ThemeProvider>
        <SafeAreaProvider
          initialMetrics={{
            frame: { x: 0, y: 0, width: 400, height: 800 },
            insets: { top: 0, left: 0, right: 0, bottom: BOTTOM_INSET },
          }}
        >
          <CreateTaskScreen />
        </SafeAreaProvider>
      </ThemeProvider>,
    );
  }

  /** Mirrors exactly what CreateTaskScreen derives descriptionMaxHeight from. */
  function expectedDescriptionMaxHeight(windowHeight: number): number {
    return alignHeightToTextLineGrid({
      height: clampSheetContentHeight({
        windowHeight,
        reservedHeight: CREATE_SHEET_RESERVED_HEIGHT + BOTTOM_INSET + SHEET_KEYBOARD_ALLOWANCE,
        floorHeight: DESCRIPTION_FLOOR_HEIGHT,
      }),
      lineHeight: darkTerminalTheme.typography.body.lineHeight,
      verticalPadding: 2 * darkTerminalTheme.spacing.sm,
    });
  }

  it('caps the description at the aligned ceiling on a tall window, resting at 120', () => {
    mockWindowHeight(1280);
    renderWithInsets();

    const style = StyleSheet.flatten(screen.getByTestId('create-task-description').props.style);
    const expectedMaxHeight = expectedDescriptionMaxHeight(1280);

    expect(expectedMaxHeight).not.toBe(HISTORICAL_FIXED_CAP); // alignment brings the 420 ceiling down to 416
    expect(style.maxHeight).toBe(expectedMaxHeight);
    expect(style.minHeight).toBe(120);
  });

  /** The exact window size from the tester recording that motivated this module. */
  it('shrinks the description cap on the 852pt tester-recording window', () => {
    mockWindowHeight(852);
    renderWithInsets();

    const style = StyleSheet.flatten(screen.getByTestId('create-task-description').props.style);
    const expectedMaxHeight = expectedDescriptionMaxHeight(852);

    expect(expectedMaxHeight).not.toBe(HISTORICAL_FIXED_CAP);
    expect(style.maxHeight).toBe(expectedMaxHeight);
    expect(style.minHeight).toBe(120);
  });

  /** Below this window, the cap itself drops under the 120 resting height, and minHeight must follow it down. */
  it('follows the cap below the 120 resting height on a very small window', () => {
    mockWindowHeight(830);
    renderWithInsets();

    const style = StyleSheet.flatten(screen.getByTestId('create-task-description').props.style);
    const expectedMaxHeight = expectedDescriptionMaxHeight(830);

    expect(expectedMaxHeight).toBeLessThan(120); // sanity: this window actually exercises the cap-below-rest branch
    expect(expectedMaxHeight).not.toBe(HISTORICAL_FIXED_CAP);
    expect(style.maxHeight).toBe(expectedMaxHeight);
    expect(style.minHeight).toBe(expectedMaxHeight);
  });
});
