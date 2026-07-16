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
  selectLiveSessionIds,
  selectProjectAccentColor,
  selectTasksForColumn,
  useBoardStore,
} from '@/state/boardStore';
import { boardColumnFixture, boardSnapshotFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

const COLUMNS = [
  boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 }),
  boardColumnFixture({ id: 'lane-doing', name: 'Doing', position: 1 }),
  boardColumnFixture({ id: 'lane-ghost', name: 'Ghost', position: 2, is_ghost: true }),
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

    expect(selectColumnsOrdered(board).map((column) => column.id)).toEqual(['lane-todo', 'lane-doing']);
    expect(selectTasksForColumn(board, 'lane-todo').map((task) => task.id)).toEqual(['task-1', 'task-2']);
    expect(selectTasksForColumn(board, 'lane-doing')).toEqual([]);
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

  it('findTaskById locates a task and its project across cached boards', () => {
    useBoardStore.getState().applyBoardSnapshot(snapshotWithTasks());
    expect(findTaskById(useBoardStore.getState(), 'task-2')?.projectId).toBe('project-1');
    expect(findTaskById(useBoardStore.getState(), 'task-ghost')).toBeNull();
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
