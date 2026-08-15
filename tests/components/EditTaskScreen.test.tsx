import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { EditTaskScreen } from '@/screens/EditTaskScreen';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';
import {
  alignHeightToTextLineGrid,
  clampSheetContentHeight,
  DESCRIPTION_FLOOR_HEIGHT,
  EDIT_SHEET_RESERVED_HEIGHT,
  SHEET_KEYBOARD_ALLOWANCE,
} from '@/lib/sheetContentHeights';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
let mockParams: { taskId?: string; projectId?: string } = { taskId: 'task-1', projectId: 'project-1' };
jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockParams,
  useRouter: () => ({ replace: jest.fn(), back: mockBack, push: jest.fn() }),
}));

const mockUpdateTaskFields = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/actions', () => ({
  updateTaskFields: (input: unknown) => mockUpdateTaskFields(input),
}));

function seedBoard(): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [boardColumnFixture()],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', title: 'Original title', description: 'Original description' }),
        },
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
      },
    },
    pendingMoves: [],
  });
}

function renderEditTaskScreen(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <EditTaskScreen />
    </ThemeProvider>,
  );
}

describe('EditTaskScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
    useBoardStore.getState().reset();
    seedBoard();
  });

  it('prefills the current values and gates save on dirtiness', () => {
    renderEditTaskScreen();
    expect(screen.getByTestId('edit-task-title').props.value).toBe('Original title');
    expect(screen.getByTestId('edit-task-description').props.value).toBe('Original description');

    // Unchanged: save is disabled, so an untouched open cannot overwrite a
    // field the desktop changed underneath.
    fireEvent.press(screen.getByTestId('edit-task-save'));
    expect(mockUpdateTaskFields).not.toHaveBeenCalled();
  });

  it('sends only the changed fields, with the task and project from the params', async () => {
    renderEditTaskScreen();
    fireEvent.changeText(screen.getByTestId('edit-task-title'), 'Renamed title');
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-task-save'));
    });

    expect(mockUpdateTaskFields).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskId: 'task-1',
      title: 'Renamed title',
    });
    expect(mockBack).toHaveBeenCalled();
  });

  it('never saves an empty title', async () => {
    renderEditTaskScreen();
    fireEvent.changeText(screen.getByTestId('edit-task-title'), '   ');
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-task-save'));
    });
    expect(mockUpdateTaskFields).not.toHaveBeenCalled();
  });

  it('keeps the sheet open with the reason when the save fails', async () => {
    mockUpdateTaskFields.mockRejectedValueOnce(new Error('The desktop rejected the edit'));
    renderEditTaskScreen();
    fireEvent.changeText(screen.getByTestId('edit-task-title'), 'Renamed title');
    await act(async () => {
      fireEvent.press(screen.getByTestId('edit-task-save'));
    });

    expect(screen.getByText('The desktop rejected the edit')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
  });

  /** A task the board has not located yet must not render a form over empty values. */
  it('renders nothing for an unknown task', () => {
    mockParams = { taskId: 'task-missing', projectId: 'project-1' };
    renderEditTaskScreen();
    expect(screen.queryByTestId('edit-task-title')).toBeNull();
  });
});

/**
 * The description box's height cap is derived from the window, not fixed: a
 * fixed maxHeight: 420 shipped first and hid the Save button behind the
 * keyboard on small phones (the 2026-08-15 iOS tester recording). These
 * tests pin the WIRING (windowHeight + insets.bottom + the screen's own
 * budget reach the rendered style), not the derivation math itself, which is
 * pinned separately in tests/unit/sheetContentHeights.test.ts.
 */
describe('EditTaskScreen description height cap', () => {
  // A non-zero, non-default gesture-bar-shaped inset: with the safe-area
  // mock's default of 0, a screen that forgot to add insets.bottom would
  // pass every assertion below by coincidence.
  const BOTTOM_INSET = 34;
  const HISTORICAL_FIXED_CAP = 420; // the bug this module's derivation replaced

  beforeEach(() => {
    // Deliberately independent of the sibling describe above: do not rely on
    // whatever mockParams/store state its last test happened to leave behind.
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
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
          <EditTaskScreen />
        </SafeAreaProvider>
      </ThemeProvider>,
    );
  }

  /** Mirrors exactly what EditTaskScreen derives descriptionMaxHeight from. */
  function expectedDescriptionMaxHeight(windowHeight: number): number {
    return alignHeightToTextLineGrid({
      height: clampSheetContentHeight({
        windowHeight,
        reservedHeight: EDIT_SHEET_RESERVED_HEIGHT + BOTTOM_INSET + SHEET_KEYBOARD_ALLOWANCE,
        floorHeight: DESCRIPTION_FLOOR_HEIGHT,
      }),
      lineHeight: darkTerminalTheme.typography.body.lineHeight,
      verticalPadding: 2 * darkTerminalTheme.spacing.sm,
    });
  }

  it('caps the description at the aligned ceiling on a tall window, resting at 160', () => {
    mockWindowHeight(1280);
    renderWithInsets();

    const style = StyleSheet.flatten(screen.getByTestId('edit-task-description').props.style);
    const expectedMaxHeight = expectedDescriptionMaxHeight(1280);

    expect(expectedMaxHeight).not.toBe(HISTORICAL_FIXED_CAP); // alignment brings the 420 ceiling down to 416
    expect(style.maxHeight).toBe(expectedMaxHeight);
    expect(style.minHeight).toBe(160);
  });

  /** The exact window size from the tester recording that motivated this module. */
  it('shrinks the description cap on the 852pt tester-recording window', () => {
    mockWindowHeight(852);
    renderWithInsets();

    const style = StyleSheet.flatten(screen.getByTestId('edit-task-description').props.style);
    const expectedMaxHeight = expectedDescriptionMaxHeight(852);

    expect(expectedMaxHeight).not.toBe(HISTORICAL_FIXED_CAP);
    expect(style.maxHeight).toBe(expectedMaxHeight);
    expect(style.minHeight).toBe(160);
  });

  /** Below this window, the cap itself drops under the 160 resting height, and minHeight must follow it down. */
  it('follows the cap below the 160 resting height on a small window', () => {
    mockWindowHeight(820);
    renderWithInsets();

    const style = StyleSheet.flatten(screen.getByTestId('edit-task-description').props.style);
    const expectedMaxHeight = expectedDescriptionMaxHeight(820);

    expect(expectedMaxHeight).toBeLessThan(160); // sanity: this window actually exercises the cap-below-rest branch
    expect(expectedMaxHeight).not.toBe(HISTORICAL_FIXED_CAP);
    expect(style.maxHeight).toBe(expectedMaxHeight);
    expect(style.minHeight).toBe(expectedMaxHeight);
  });
});
