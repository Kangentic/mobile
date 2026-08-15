import React from 'react';
import { Dimensions, StyleSheet } from 'react-native';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '@/components';
import { MoveTaskScreen } from '@/screens/MoveTaskScreen';
import { CapabilityError } from '@/channel';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';
import {
  clampSheetContentHeight,
  LIST_FLOOR_HEIGHT,
  MOVE_SHEET_RESERVED_HEIGHT,
  SHEET_CONTENT_CEILING,
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

const mockMoveTaskOptimistic = jest.fn().mockResolvedValue(undefined);
jest.mock('@/connection/actions', () => ({
  moveTaskOptimistic: (input: unknown) => mockMoveTaskOptimistic(input),
}));

/** Two tasks already sitting in Doing, so an append is distinguishable from a hardcoded 0. */
function seedBoard(): void {
  useBoardStore.setState({
    projects: [{ id: 'project-1', name: 'Alpha' }],
    boardsByProjectId: {
      'project-1': {
        columns: [
          boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 }),
          boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 }),
        ],
        tasksById: {
          'task-1': boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-todo', title: 'Fix the login redirect' }),
          'task-2': boardTaskFixture({ id: 'task-2', swimlane_id: 'lane-doing' }),
          'task-3': boardTaskFixture({ id: 'task-3', swimlane_id: 'lane-doing' }),
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

function renderMoveTaskScreen(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <MoveTaskScreen />
    </ThemeProvider>,
  );
}

describe('MoveTaskScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
    useBoardStore.getState().reset();
    seedBoard();
  });

  it('shows the task and disables its current column', () => {
    renderMoveTaskScreen();

    expect(screen.getByText('Fix the login redirect')).toBeTruthy();
    expect(screen.getByTestId('move-target-lane-todo').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('move-target-lane-doing').props.accessibilityState.disabled).toBe(false);
    // Nothing picked yet, so there is nothing to confirm.
    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(true);
  });

  /**
   * Appending to the BOTTOM of the target column is the one true Kanban
   * convention here, so targetPosition is the column's existing task count.
   * Hardcoding 0 would silently move every task to the top instead.
   */
  it('appends after the tasks already in the target column', async () => {
    renderMoveTaskScreen();

    fireEvent.press(screen.getByTestId('move-target-lane-doing'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('move-confirm'));
    });

    expect(mockMoveTaskOptimistic).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskId: 'task-1',
      targetSwimlaneId: 'lane-doing',
      targetPosition: 2,
    });
    expect(mockBack).toHaveBeenCalled();
  });

  /**
   * A desktop refusal carries a reason worth showing; any other failure is a
   * transport blip whose raw message would mean nothing to the user. This path
   * is deliberately narrower than the edit/archive/delete handling.
   */
  it('shows a CapabilityError verbatim but generalises any other failure', async () => {
    mockMoveTaskOptimistic.mockRejectedValueOnce(new CapabilityError('move-task', 'The desktop rejected the move'));
    const refused = renderMoveTaskScreen();
    fireEvent.press(screen.getByTestId('move-target-lane-doing'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('move-confirm'));
    });
    expect(screen.getByText('The desktop rejected the move')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
    refused.unmount();

    mockMoveTaskOptimistic.mockRejectedValueOnce(new Error('some transport blip'));
    renderMoveTaskScreen();
    fireEvent.press(screen.getByTestId('move-target-lane-doing'));
    await act(async () => {
      fireEvent.press(screen.getByTestId('move-confirm'));
    });
    expect(screen.getByText('Move failed - check the connection')).toBeTruthy();
    expect(screen.queryByText('some transport blip')).toBeNull();
  });

  /**
   * The feed spans every paired project, so the columns offered must come from
   * the TASK's own board, not from whichever board was last looked at.
   */
  it('renders the columns of the project named in the params', () => {
    useBoardStore.setState((state) => ({
      boardsByProjectId: {
        ...state.boardsByProjectId,
        'project-2': {
          columns: [boardColumnFixture({ id: 'p2-triage', name: 'Triage', position: 0 })],
          tasksById: { 'task-9': boardTaskFixture({ id: 'task-9', swimlane_id: 'p2-triage' }) },
          snapshotAt: 0,
          showTicketNumbers: true,
          view: 'full' as const,
          taskCountsByColumnId: {},
        },
      },
    }));
    mockParams = { taskId: 'task-9', projectId: 'project-2' };

    renderMoveTaskScreen();

    expect(screen.getByTestId('move-target-p2-triage')).toBeTruthy();
    expect(screen.queryByTestId('move-target-lane-doing')).toBeNull();
  });
});

/**
 * The column list's height cap is derived from the window, not fixed: a
 * fixed maxHeight: 420 shipped first and pushed the Move button off screen on
 * small phones with enough columns (the 2026-08-15 iOS tester recording).
 * These tests pin the WIRING (windowHeight + insets.bottom + the screen's own
 * budget reach the rendered style), not the derivation math itself, which is
 * pinned separately in tests/unit/sheetContentHeights.test.ts.
 */
describe('MoveTaskScreen column list height cap', () => {
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
          <MoveTaskScreen />
        </SafeAreaProvider>
      </ThemeProvider>,
    );
  }

  /** Mirrors exactly what MoveTaskScreen derives listMaxHeight from. */
  function expectedListMaxHeight(windowHeight: number): number {
    return clampSheetContentHeight({
      windowHeight,
      reservedHeight: MOVE_SHEET_RESERVED_HEIGHT + BOTTOM_INSET,
      floorHeight: LIST_FLOOR_HEIGHT,
    });
  }

  it('rests at the historical 420 ceiling on a tall window, unaligned (lists stay unaligned)', () => {
    mockWindowHeight(1280);
    renderWithInsets();

    const style = StyleSheet.flatten(screen.getByTestId('move-target-list').props.style);

    expect(expectedListMaxHeight(1280)).toBe(SHEET_CONTENT_CEILING);
    expect(style.maxHeight).toBe(SHEET_CONTENT_CEILING);
  });

  it('shrinks the list cap on a short window, strictly between the floor and the ceiling', () => {
    mockWindowHeight(600);
    renderWithInsets();

    const style = StyleSheet.flatten(screen.getByTestId('move-target-list').props.style);
    const expectedMaxHeight = expectedListMaxHeight(600);

    // Sanity: this window actually exercises the clamp, not either saturated end.
    expect(expectedMaxHeight).toBeGreaterThan(LIST_FLOOR_HEIGHT);
    expect(expectedMaxHeight).toBeLessThan(SHEET_CONTENT_CEILING);
    expect(expectedMaxHeight).not.toBe(HISTORICAL_FIXED_CAP);
    expect(style.maxHeight).toBe(expectedMaxHeight);
  });
});
