import React from 'react';
import { Dimensions, StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { act, fireEvent, render, screen, within } from '@testing-library/react-native';
import type { TestInstance } from 'test-renderer';
import type { BoardTaskWorkflowWire } from '@kangentic/protocol';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { ThemeProvider } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { MoveTaskScreen } from '@/screens/MoveTaskScreen';
import { CapabilityError } from '@/channel';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';
import { WORKFLOW_LOCK_REASON, workflowWireFixture } from '../helpers/workflows';
import {
  clampSheetContentHeight,
  LIST_FLOOR_HEIGHT,
  MOVE_SHEET_RESERVED_HEIGHT,
  SHEET_CONTENT_CEILING,
} from '@/lib/sheetContentHeights';

/**
 * Returns the nearest HOST ancestor of a queried host node, so the caller can
 * assert that ancestor IS the SheetScrollerSlot's View rather than merely that
 * a slot exists somewhere above it. Test Renderer (RNTL 14) only exposes host
 * instances, so `parent` is already the nearest host: there are no composite
 * wrapper layers to skip any more, which the previous react-test-renderer
 * helper had to walk past. Stopping at anything but the nearest host would let
 * a slot that wraps the wrong element (e.g. the whole Stack, which is exactly
 * the misplacement SheetScrollerSlot's own invariant comment warns against)
 * pass this check by accident.
 */
function nearestHostAncestor(instance: TestInstance): TestInstance {
  const hostAncestor = instance.parent;
  if (hostAncestor === null) {
    throw new Error('expected a host ancestor');
  }
  return hostAncestor;
}

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
        commandTerminals: [],
        commandTerminalsOffered: false,
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

  it('shows the task and disables its current column', async () => {
    await renderMoveTaskScreen();

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
    await renderMoveTaskScreen();

    await fireEvent.press(screen.getByTestId('move-target-lane-doing'));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('move-confirm'));
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
    const refused = await renderMoveTaskScreen();
    await fireEvent.press(screen.getByTestId('move-target-lane-doing'));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('move-confirm'));
    });
    expect(screen.getByText('The desktop rejected the move')).toBeTruthy();
    expect(mockBack).not.toHaveBeenCalled();
    await refused.unmount();

    mockMoveTaskOptimistic.mockRejectedValueOnce(new Error('some transport blip'));
    await renderMoveTaskScreen();
    await fireEvent.press(screen.getByTestId('move-target-lane-doing'));
    await act(async () => {
      await fireEvent.press(screen.getByTestId('move-confirm'));
    });
    expect(screen.getByText('Move failed - check the connection')).toBeTruthy();
    expect(screen.queryByText('some transport blip')).toBeNull();
  });

  /**
   * The feed spans every paired project, so the columns offered must come from
   * the TASK's own board, not from whichever board was last looked at.
   */
  it('renders the columns of the project named in the params', async () => {
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
          commandTerminals: [],
          commandTerminalsOffered: false,
        },
      },
    }));
    mockParams = { taskId: 'task-9', projectId: 'project-2' };

    await renderMoveTaskScreen();

    expect(screen.getByTestId('move-target-p2-triage')).toBeTruthy();
    expect(screen.queryByTestId('move-target-lane-doing')).toBeNull();
  });
});

/**
 * Regression cover for task #113 change 4: the current column wore the accent
 * wash and the picked column a quiet raised fill, so the sheet highlighted two
 * rows in two ways and the loud one was the one that cannot be chosen. Now only
 * the user's pick is highlighted (the same accent wash and muted outline the
 * Board's active chip wears); every other row is a raised button, and the
 * current column recedes with a "Current" tag.
 */
describe('MoveTaskScreen row highlight', () => {
  const { colors } = darkTerminalTheme;

  beforeEach(() => {
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
    useBoardStore.getState().reset();
    seedBoard();
  });

  function rowStyle(columnId: string): ViewStyle {
    return StyleSheet.flatten(screen.getByTestId(`move-target-${columnId}`).props.style as StyleProp<ViewStyle>) as ViewStyle;
  }

  it('fades the current column and tags it Current, without the accent fill', async () => {
    await renderMoveTaskScreen();

    const currentRow = rowStyle('lane-todo');
    // An unset opacity is a full-strength row, so default it for a readable failure.
    expect(currentRow.opacity ?? 1).toBeLessThan(1);
    expect(currentRow.backgroundColor).not.toBe(colors.accentSubtle);
    expect(currentRow.backgroundColor).toBe(colors.surfaceRaised);
    expect(within(screen.getByTestId('move-target-lane-todo-current')).getByText('Current')).toBeTruthy();
  });

  it('leaves the other columns full strength, raised and untagged', async () => {
    await renderMoveTaskScreen();

    const otherRow = rowStyle('lane-doing');
    expect(otherRow.opacity ?? 1).toBe(1);
    expect(otherRow.backgroundColor).toBe(colors.surfaceRaised);
    expect(otherRow.borderColor).toBe(colors.border);
    expect(otherRow.borderWidth).toBe(StyleSheet.hairlineWidth);
    expect(screen.queryByTestId('move-target-lane-doing-current')).toBeNull();
  });

  it('highlights only the picked column, with the accent wash and the muted accent outline', async () => {
    await renderMoveTaskScreen();

    await fireEvent.press(screen.getByTestId('move-target-lane-doing'));

    const pickedRow = rowStyle('lane-doing');
    expect(pickedRow.backgroundColor).toBe(colors.accentSubtle);
    expect(pickedRow.borderColor).toBe(colors.accentMuted);
    // The current column stays unhighlighted once something else is picked:
    // exactly one row wears the accent.
    expect(rowStyle('lane-todo').backgroundColor).toBe(colors.surfaceRaised);
    expect(rowStyle('lane-todo').borderColor).toBe(colors.border);
  });
});

/**
 * A workflow task (protocol 0.21.0) is moved by the desktop's rule, not freely:
 * a refused column stays in the list, disabled, with no reason (design sign-off,
 * screens 3 to 5). Every column here carries its REAL role: `boardColumnFixture`
 * defaults to `todo`, so a working column left to the default would be refused as
 * a To Do move and every case below would pass for the wrong reason.
 */
describe('MoveTaskScreen workflow tasks', () => {
  /** `held`: the task's own automations are paused (protocol 0.25.0), which frees its card as a paused workflow's is. */
  function seedWorkflowBoard(workflow: Partial<BoardTaskWorkflowWire> | null, taskColumnId = 'lane-doing', held = false): void {
    useBoardStore.setState({
      projects: [{ id: 'project-1', name: 'Alpha' }],
      boardsByProjectId: {
        'project-1': {
          columns: [
            boardColumnFixture({ id: 'lane-todo', name: 'To Do', role: 'todo', position: 0 }),
            boardColumnFixture({ id: 'lane-doing', name: 'Doing', role: null, position: 1 }),
            boardColumnFixture({ id: 'lane-review', name: 'Review', role: null, position: 2 }),
            boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 3 }),
          ],
          tasksById: {
            'task-1': boardTaskFixture({
              id: 'task-1',
              swimlane_id: taskColumnId,
              title: 'Fix the login redirect',
              automations_disabled: held,
              workflow: workflow === null ? null : workflowWireFixture(workflow),
            }),
          },
          snapshotAt: 0,
          showTicketNumbers: true,
          view: 'full',
          taskCountsByColumnId: {},
          commandTerminals: [],
          commandTerminalsOffered: false,
        },
      },
      pendingMoves: [],
    });
  }

  function rowDisabled(columnId: string): boolean {
    return screen.getByTestId(`move-target-${columnId}`).props.accessibilityState.disabled as boolean;
  }

  function rowSelected(columnId: string): boolean {
    return screen.getByTestId(`move-target-${columnId}`).props.accessibilityState.selected as boolean;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
    useBoardStore.getState().reset();
  });

  /**
   * Mutation seen failing: `workflowAllowsMove` ending in `return true` instead
   * of the gate comparison (a running workflow's locked card). The Review row
   * read enabled: "Expected: true, Received: false" on its disabled state. (The
   * To Do row stayed refused, by the role check ahead of it.)
   */
  it('refuses every column for a running workflow task that is locked and not at a gate', async () => {
    seedWorkflowBoard({ state: 'running', lock_reason: WORKFLOW_LOCK_REASON, gate_target_id: null });
    await renderMoveTaskScreen();

    for (const columnId of ['lane-todo', 'lane-doing', 'lane-review', 'lane-done']) {
      expect(rowDisabled(columnId)).toBe(true);
    }
    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(true);
  });

  /**
   * Mutations seen failing: dropping the gate preselection (`gateColumnId`
   * forced to null) left the gated row unchosen: "Expected: true, Received:
   * false" on its selected state, before Move was even looked at; and the same
   * `return true` mutation as above opened the columns the gate refuses.
   */
  it('opens only the gate target for a running workflow task at a human gate, already chosen', async () => {
    seedWorkflowBoard({ state: 'running', gate_target_id: 'lane-review' });
    await renderMoveTaskScreen();

    expect(rowDisabled('lane-review')).toBe(false);
    for (const columnId of ['lane-todo', 'lane-doing', 'lane-done']) {
      expect(rowDisabled(columnId)).toBe(true);
    }
    // Chosen without a tap, so reporting the step done is one press.
    expect(rowSelected('lane-review')).toBe(true);
    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(false);

    await act(async () => {
      await fireEvent.press(screen.getByTestId('move-confirm'));
    });

    expect(mockMoveTaskOptimistic).toHaveBeenCalledWith({
      projectId: 'project-1',
      taskId: 'task-1',
      targetSwimlaneId: 'lane-review',
      targetPosition: 0,
    });
  });

  /**
   * Mutation seen failing: deleting the `isTodoRole(toRole)` refusal in
   * `workflowAllowsMove`. The To Do row came back enabled: "Expected: true,
   * Received: false" on its disabled state.
   */
  it('refuses only To Do for a paused workflow task, and lets a hand pick any other column', async () => {
    seedWorkflowBoard({ state: 'paused' });
    await renderMoveTaskScreen();

    expect(rowDisabled('lane-todo')).toBe(true);
    expect(rowDisabled('lane-review')).toBe(false);
    expect(rowDisabled('lane-done')).toBe(false);
    // Two columns are open, so nothing is chosen for the user.
    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(true);
  });

  /**
   * Kangentic #923 (design change 5): a held card of a running workflow moves by
   * hand to any column but To Do, read from the row's own switch.
   */
  it('opens every column but To Do for a held card of a running workflow', async () => {
    seedWorkflowBoard({ state: 'running', lock_reason: null, gate_target_id: null }, 'lane-doing', true);
    await renderMoveTaskScreen();

    expect(rowDisabled('lane-todo')).toBe(true);
    expect(rowDisabled('lane-review')).toBe(false);
    expect(rowDisabled('lane-done')).toBe(false);
    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(true);
  });

  /**
   * The desktop names no gate for a held card, but the optimistic hold lands
   * before the snapshot that drops it. A stale gate must neither limit the
   * card nor pre-choose a column. Mutation seen failing: removing the
   * `automations_disabled !== true` clause from MoveTaskScreen's gateTargetId
   * left Review chosen ("Expected: false, Received: true" on its selected state).
   */
  it('chooses nothing for a held card that still carries a stale gate, and opens the rest', async () => {
    seedWorkflowBoard({ state: 'running', lock_reason: null, gate_target_id: 'lane-review' }, 'lane-doing', true);
    await renderMoveTaskScreen();

    expect(rowSelected('lane-review')).toBe(false);
    expect(rowDisabled('lane-done')).toBe(false);
    expect(rowDisabled('lane-todo')).toBe(true);
    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(true);
  });

  /**
   * Regression: the preselect keyed on "exactly one column allowed", not on the
   * gate. On a three-column board a paused workflow's card in Doing has one
   * column open (Done, since To Do is refused), so Done came pre-chosen and one
   * tap away: the archive the hub refuses, unchosen. Seen failing against that
   * code: "Expected: false, Received: true" on Done's selected state.
   */
  it('chooses nothing for a paused workflow task whose one open column is not a gate', async () => {
    seedWorkflowBoard({ state: 'paused', gate_target_id: null });
    const board = useBoardStore.getState().boardsByProjectId['project-1'];
    if (!board) throw new Error('board not seeded');
    useBoardStore.setState({
      boardsByProjectId: {
        'project-1': { ...board, columns: board.columns.filter((column) => column.id !== 'lane-review') },
      },
    });
    await renderMoveTaskScreen();

    expect(rowDisabled('lane-done')).toBe(false);
    expect(rowSelected('lane-done')).toBe(false);
    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(true);
  });

  /**
   * Mutation seen failing: removing the `draft`/`done` early return, so a
   * finished workflow's task fell through to the To Do refusal and the To Do row
   * stayed disabled ("Expected: false, Received: true"), for both states.
   */
  it.each(['done', 'draft'])('lets a %s workflow task go anywhere, To Do included', async (state) => {
    seedWorkflowBoard({ state });
    await renderMoveTaskScreen();

    for (const columnId of ['lane-todo', 'lane-review', 'lane-done']) {
      expect(rowDisabled(columnId)).toBe(false);
    }
    // The current column is still not a target.
    expect(rowDisabled('lane-doing')).toBe(true);
  });

  /**
   * A state this app does not know reads as running (the protocol says so), the
   * strictest reading: a state a newer desktop adds must not unlock a card the
   * desktop still locks.
   */
  it('reads a workflow state it does not know as running, so the card stays locked', async () => {
    seedWorkflowBoard({ state: 'archived-by-a-newer-desktop', lock_reason: WORKFLOW_LOCK_REASON });
    await renderMoveTaskScreen();

    expect(rowDisabled('lane-todo')).toBe(true);
    expect(rowDisabled('lane-review')).toBe(true);
    expect(rowDisabled('lane-done')).toBe(true);
  });

  /**
   * Mutation seen failing: `if (!workflow) return false` in `workflowAllowsMove`
   * (the ordinary task refused everywhere): "Expected: false, Received: true"
   * on the first other column's disabled state.
   */
  it('leaves an ordinary task exactly as it was: every other column open, To Do included, nothing chosen', async () => {
    seedWorkflowBoard(null);
    await renderMoveTaskScreen();

    for (const columnId of ['lane-todo', 'lane-review', 'lane-done']) {
      expect(rowDisabled(columnId)).toBe(false);
    }
    expect(rowDisabled('lane-doing')).toBe(true);
    expect(screen.getByTestId('move-confirm').props.accessibilityState.disabled).toBe(true);
  });
});

/**
 * The iOS form-sheet fix (SheetScrollerSlot) works by owning the scroller's
 * layout slot (see the component's invariant comment); a future refactor
 * that unwraps the ScrollView from its slot would silently reopen the bug
 * the wrapper exists to fix, and nothing else here would notice. This locks
 * the WIRING (the slot actually sits between the Stack and the list), not
 * the slot's own structural behavior, which SheetScrollerSlot.test.tsx
 * already covers.
 */
describe('MoveTaskScreen scroller slot wiring', () => {
  beforeEach(() => {
    mockParams = { taskId: 'task-1', projectId: 'project-1' };
    useBoardStore.getState().reset();
    seedBoard();
  });

  it('renders the column list inside a SheetScrollerSlot', async () => {
    await renderMoveTaskScreen();

    const scroller = screen.getByTestId('move-target-list');
    const slotHost = nearestHostAncestor(scroller);

    expect(slotHost.props.collapsable).toBe(false);
    expect(StyleSheet.flatten(slotHost.props.style)).toMatchObject({ overflow: 'hidden' });
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

  it('rests at the historical 420 ceiling on a tall window, unaligned (lists stay unaligned)', async () => {
    mockWindowHeight(1280);
    await renderWithInsets();

    const style = StyleSheet.flatten(screen.getByTestId('move-target-list').props.style);

    expect(expectedListMaxHeight(1280)).toBe(SHEET_CONTENT_CEILING);
    expect(style.maxHeight).toBe(SHEET_CONTENT_CEILING);
  });

  it('shrinks the list cap on a short window, strictly between the floor and the ceiling', async () => {
    mockWindowHeight(600);
    await renderWithInsets();

    const style = StyleSheet.flatten(screen.getByTestId('move-target-list').props.style);
    const expectedMaxHeight = expectedListMaxHeight(600);

    // Sanity: this window actually exercises the clamp, not either saturated end.
    expect(expectedMaxHeight).toBeGreaterThan(LIST_FLOOR_HEIGHT);
    expect(expectedMaxHeight).toBeLessThan(SHEET_CONTENT_CEILING);
    expect(expectedMaxHeight).not.toBe(HISTORICAL_FIXED_CAP);
    expect(style.maxHeight).toBe(expectedMaxHeight);
  });
});
