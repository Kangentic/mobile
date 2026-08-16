/**
 * boardStore: snapshot application, optimistic move + rollback, the
 * snapshot-during-pending-move re-application, and the live-session
 * selector the bootstrap keys on.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReadBoardProjectSummary } from '@kangentic/protocol';
import {
  findTaskById,
  selectColumnsOrdered,
  selectColumnTaskCount,
  selectLiveSessionIds,
  selectProjectAccentColor,
  selectTaskColumn,
  selectTasksForColumn,
  useBoardStore,
} from '@/state/boardStore';
import { boardColumnFixture, boardSnapshotFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

const COLUMNS = [
  boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 }),
  boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 }),
  boardColumnFixture({ id: 'lane-ghost', name: 'Ghost', position: 2, is_ghost: true }),
  // Archived because it ARCHIVES what lands in it, not because it is hidden -
  // the done lane's deliberate exception to "archived means hidden".
  boardColumnFixture({ id: 'lane-done', name: 'Done', position: 3, role: 'done', is_archived: true }),
  // A genuinely hidden archived column (role stays 'todo') - proves the
  // carve-out is role-specific, not "any archived column is now visible".
  boardColumnFixture({ id: 'lane-old-sprint', name: 'Old Sprint', position: 4, is_archived: true }),
];

function snapshotWithTasks(): ReturnType<typeof boardSnapshotFixture> {
  return boardSnapshotFixture({
    projectId: 'project-1',
    columns: COLUMNS,
    tasks: [
      boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-todo', position: 0, session_id: 'sess-1' }),
      boardTaskFixture({ id: 'task-2', swimlane_id: 'lane-todo', position: 1 }),
      boardTaskFixture({ id: 'task-3', swimlane_id: 'lane-doing', position: 0, session_id: 'sess-3', archived_at: '2026-07-01T00:00:00.000Z' }),
    ],
  });
}

describe('boardStore', () => {
  beforeEach(() => {
    useBoardStore.getState().reset();
  });

  it('applies snapshots and filters archived/ghost columns and archived tasks in selectors', () => {
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    const board = useBoardStore.getState().boardsByProjectId['project-1'];

    expect(selectColumnsOrdered(board).map((column) => column.id)).toEqual(['lane-todo', 'lane-doing', 'lane-done']);
    expect(selectTasksForColumn(board, 'lane-todo').map((task) => task.id)).toEqual(['task-1', 'task-2']);
    expect(selectTasksForColumn(board, 'lane-doing')).toEqual([]);
  });

  /**
   * Regression: the done lane ships with `is_archived: true` because it is
   * the lane that ARCHIVES what lands in it, not because it is hidden - the
   * desktop's own column config builder marks a column hidden with
   * `is_archived && role !== 'done'`. Reading `is_archived` without that
   * carve-out shipped once and kept completed work off the phone entirely
   * (see selectColumnsOrdered's doc comment in src/state/boardStore.ts).
   */
  it('selectColumnsOrdered keeps the archived done column but still drops a genuinely hidden archived column and a ghost column', () => {
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    const board = useBoardStore.getState().boardsByProjectId['project-1'];
    const columnIds = selectColumnsOrdered(board).map((column) => column.id);

    expect(columnIds).toContain('lane-done');
    expect(columnIds).not.toContain('lane-ghost');
    expect(columnIds).not.toContain('lane-old-sprint');
    expect(columnIds).toEqual(['lane-todo', 'lane-doing', 'lane-done']);
  });

  /**
   * A pre-0.9.0 desktop echoes no `view` and always sends every task, so an
   * absent field has to mean 'full'. Reading it as "filtered, unknown how"
   * would strand the Board tab on its loading state forever.
   */
  it('treats a snapshot with no view echo as a full board', () => {
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    expect(useBoardStore.getState().boardsByProjectId['project-1'].view).toBe('full');
  });

  it('selectColumnTaskCount uses the wire counts under a sessions board and the local list under a full one', () => {
    useBoardStore.getState().applyBoardSnapshot(
      boardSnapshotFixture({
        projectId: 'project-1',
        columns: COLUMNS,
        // What a 'sessions' snapshot looks like: one task on the wire, but
        // the column really holds five. Appending has to land at 5, not 1.
        tasks: [boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-todo', position: 0, session_id: 'sess-1' })],
        view: 'sessions',
        taskCountsByColumnId: { 'lane-todo': 5 },
      }),
    );
    const sessionsBoard = useBoardStore.getState().boardsByProjectId['project-1'];
    expect(selectColumnTaskCount(sessionsBoard, 'lane-todo')).toBe(5);
    // A column with no live session is absent from the map entirely.
    expect(selectColumnTaskCount(sessionsBoard, 'lane-doing')).toBe(0);

    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    const fullBoard = useBoardStore.getState().boardsByProjectId['project-1'];
    expect(selectColumnTaskCount(fullBoard, 'lane-todo')).toBe(2);
  });

  it('hasHydratedSnapshot latches true on the first snapshot and resets with the rest of the board', () => {
    expect(useBoardStore.getState().hasHydratedSnapshot).toBe(false);

    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    expect(useBoardStore.getState().hasHydratedSnapshot).toBe(true);

    useBoardStore.getState().reset();
    expect(useBoardStore.getState().hasHydratedSnapshot).toBe(false);
  });

  it('selectLiveSessionIds unions non-archived tasks with a session across boards', () => {
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    // task-3 has a session but is archived - excluded.
    expect([...selectLiveSessionIds(useBoardStore.getState())]).toEqual(['sess-1']);
  });

  it('optimistic move reorders immediately, commit finalizes, and a racing snapshot re-applies the pending move', () => {
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    const moveId = useBoardStore.getState().applyOptimisticMove({
      projectId: 'project-1',
      taskId: 'task-1',
      toSwimlaneId: 'lane-doing',
      toPosition: 0,
    });
    expect(moveId).not.toBeNull();

    let board = useBoardStore.getState().boardsByProjectId['project-1'];
    expect(selectTasksForColumn(board, 'lane-doing').map((task) => task.id)).toEqual(['task-1']);
    expect(selectTasksForColumn(board, 'lane-todo').map((task) => task.id)).toEqual(['task-2']);

    // A stale snapshot (sent before the desktop applied the move) races in:
    // the pending move stays applied on top.
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    board = useBoardStore.getState().boardsByProjectId['project-1'];
    expect(selectTasksForColumn(board, 'lane-doing').map((task) => task.id)).toEqual(['task-1']);

    useBoardStore.getState().commitMove(moveId ?? '');
    expect(useBoardStore.getState().pendingMoves).toEqual([]);
  });

  it('rollbackMove restores the original column and position', () => {
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    const moveId = useBoardStore.getState().applyOptimisticMove({
      projectId: 'project-1',
      taskId: 'task-1',
      toSwimlaneId: 'lane-doing',
      toPosition: 0,
    });

    useBoardStore.getState().rollbackMove(moveId ?? '');
    const board = useBoardStore.getState().boardsByProjectId['project-1'];
    expect(selectTasksForColumn(board, 'lane-todo').map((task) => task.id)).toEqual(['task-1', 'task-2']);
    expect(selectTasksForColumn(board, 'lane-doing')).toEqual([]);
    expect(useBoardStore.getState().pendingMoves).toEqual([]);
  });

  it('applyOptimisticMove returns null for an unknown task (no phantom pending move)', () => {
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    const moveId = useBoardStore.getState().applyOptimisticMove({
      projectId: 'project-1',
      taskId: 'task-ghost',
      toSwimlaneId: 'lane-doing',
      toPosition: 0,
    });
    expect(moveId).toBeNull();
    expect(useBoardStore.getState().pendingMoves).toEqual([]);
  });

  it('optimistic edit patches immediately, rollback restores, and a racing snapshot re-applies the pending edit', () => {
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    const editId = useBoardStore.getState().applyOptimisticTaskEdit({
      projectId: 'project-1',
      taskId: 'task-1',
      title: 'Renamed task',
    });
    expect(editId).not.toBeNull();
    expect(useBoardStore.getState().boardsByProjectId['project-1'].tasksById['task-1'].title).toBe('Renamed task');

    // A snapshot racing the in-flight edit keeps the optimistic title.
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    expect(useBoardStore.getState().boardsByProjectId['project-1'].tasksById['task-1'].title).toBe('Renamed task');

    if (editId) useBoardStore.getState().rollbackTaskEdit(editId);
    expect(useBoardStore.getState().boardsByProjectId['project-1'].tasksById['task-1'].title).toBe('Fix the login bug');
  });

  it('optimistic removal hides immediately, commit finalizes, rollback restores the card', () => {
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    const removalId = useBoardStore.getState().applyOptimisticRemoval({ projectId: 'project-1', taskId: 'task-2' });
    expect(removalId).not.toBeNull();
    expect(useBoardStore.getState().boardsByProjectId['project-1'].tasksById['task-2']).toBeUndefined();

    // A snapshot racing the in-flight delete does not resurrect the card.
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    expect(useBoardStore.getState().boardsByProjectId['project-1'].tasksById['task-2']).toBeUndefined();

    if (removalId) useBoardStore.getState().rollbackRemoval(removalId);
    expect(useBoardStore.getState().boardsByProjectId['project-1'].tasksById['task-2']).toBeDefined();

    const secondRemovalId = useBoardStore.getState().applyOptimisticRemoval({ projectId: 'project-1', taskId: 'task-2' });
    if (secondRemovalId) useBoardStore.getState().commitRemoval(secondRemovalId);
    expect(useBoardStore.getState().pendingRemovals).toEqual([]);
  });

  it('findTaskById locates a task and its project across cached boards', () => {
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    expect(findTaskById(useBoardStore.getState(), 'task-2')?.projectId).toBe('project-1');
    expect(findTaskById(useBoardStore.getState(), 'task-ghost')).toBeNull();
  });

  describe('selectTaskColumn', () => {
    it('resolves the located task\'s column by swimlane_id', () => {
      useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
      expect(selectTaskColumn(useBoardStore.getState(), 'task-1')?.id).toBe('lane-todo');
    });

    it('returns null for an unlocated task', () => {
      useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
      expect(selectTaskColumn(useBoardStore.getState(), 'task-ghost')).toBeNull();
    });

    it('returns null when the task\'s swimlane names no column in the holding board', () => {
      useBoardStore.getState().applyBoardSnapshot(
        boardSnapshotFixture({
          projectId: 'project-1',
          columns: COLUMNS,
          tasks: [boardTaskFixture({ id: 'task-orphan', swimlane_id: 'lane-missing', position: 0 })],
        }),
      );
      expect(selectTaskColumn(useBoardStore.getState(), 'task-orphan')).toBeNull();
    });

    /**
     * Raw board.columns, not selectColumnsOrdered: the chip is STATUS, so a
     * task parked in a hidden archived column must still show where it sits
     * rather than silently losing its move affordance.
     */
    it('resolves a column that selectColumnsOrdered would filter out', () => {
      useBoardStore.getState().applyBoardSnapshot(
        boardSnapshotFixture({
          projectId: 'project-1',
          columns: COLUMNS,
          tasks: [boardTaskFixture({ id: 'task-parked', swimlane_id: 'lane-old-sprint', position: 0 })],
        }),
      );
      const board = useBoardStore.getState().boardsByProjectId['project-1'];
      expect(selectColumnsOrdered(board).map((column) => column.id)).not.toContain('lane-old-sprint');
      expect(selectTaskColumn(useBoardStore.getState(), 'task-parked')?.id).toBe('lane-old-sprint');
    });

    /**
     * The useSyncExternalStore contract the selector exists to honor: for one
     * state it must return the SAME reference every call (the column element
     * inside the store's own array), or a Zustand-subscribed component loops.
     */
    it('returns a stable reference for an unchanged state', () => {
      useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
      const state = useBoardStore.getState();
      const firstResult = selectTaskColumn(state, 'task-1');
      const secondResult = selectTaskColumn(state, 'task-1');
      expect(firstResult).not.toBeNull();
      expect(secondResult).toBe(firstResult);
      expect(state.boardsByProjectId['project-1'].columns).toContain(firstResult);
    });

    /**
     * The other half of the selector's doc-comment contract: an optimistic
     * move swaps the task's swimlane_id under an UNCHANGED columns array, so
     * the header chip re-labels the instant the user confirms a move,
     * before the desktop's re-snapshot lands.
     */
    it('re-labels under an optimistic move without replacing the columns array', () => {
      useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
      const columnsBeforeMove = useBoardStore.getState().boardsByProjectId['project-1'].columns;

      useBoardStore.getState().applyOptimisticMove({
        projectId: 'project-1',
        taskId: 'task-1',
        toSwimlaneId: 'lane-doing',
        toPosition: 0,
      });

      expect(selectTaskColumn(useBoardStore.getState(), 'task-1')?.id).toBe('lane-doing');
      expect(useBoardStore.getState().boardsByProjectId['project-1'].columns).toBe(columnsBeforeMove);
    });
  });

  describe('selectProjectAccentColor', () => {
    // protocol 0.5.0 ships `color?: string` on the summary; the selector
    // still narrows defensively (an older desktop, or hostile wire data,
    // must pass through as null rather than crash - hence the unsafe-cast
    // fixtures below modeling shapes the type forbids).
    const plainProject: ReadBoardProjectSummary = { id: 'project-plain', name: 'Plain' };
    const coloredProject: ReadBoardProjectSummary = {
      id: 'project-colored',
      name: 'Colored',
      color: '#5da9e0',
    };
    const alternateKeyProject: ReadBoardProjectSummary & { projectColor: string } = {
      id: 'project-alternate',
      name: 'Alternate',
      projectColor: '#c792ea',
    };
    const nonStringColorProject = {
      id: 'project-nonstring',
      name: 'NonString',
      color: 42,
    } as unknown as ReadBoardProjectSummary;
    const emptyColorProject: ReadBoardProjectSummary = {
      id: 'project-empty',
      name: 'Empty',
      color: '',
    };

    it('returns null for an unknown project or one without a color field', () => {
      const state = { projects: [plainProject] };
      expect(selectProjectAccentColor(state, 'project-missing')).toBeNull();
      expect(selectProjectAccentColor(state, 'project-plain')).toBeNull();
    });

    it('passes through a string color field when the wire ships one', () => {
      const state = { projects: [coloredProject] };
      expect(selectProjectAccentColor(state, 'project-colored')).toBe('#5da9e0');
    });

    it('accepts the alternate projectColor key', () => {
      const state = { projects: [alternateKeyProject] };
      expect(selectProjectAccentColor(state, 'project-alternate')).toBe('#c792ea');
    });

    it('ignores non-string and empty color values', () => {
      const state = { projects: [nonStringColorProject, emptyColorProject] };
      expect(selectProjectAccentColor(state, 'project-nonstring')).toBeNull();
      expect(selectProjectAccentColor(state, 'project-empty')).toBeNull();
    });
  });
});
