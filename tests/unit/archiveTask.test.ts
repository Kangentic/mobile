/**
 * archiveTask: matches the board's done-role column by role ALONE, exactly
 * as the desktop's own lookup does. A `!is_archived` guard here looks
 * defensive but is fatal: the done lane ships with `is_archived: true`
 * precisely BECAUSE it is the lane that archives what lands in it, so the
 * guard matched nothing and every archive threw (see the doc comment above
 * archiveTask in src/connection/actions.ts). Mocked wholesale in every
 * component test, so this is the only place the real lookup runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveTask } from '@/connection/actions';
import { useBoardStore } from '@/state/boardStore';
import { boardColumnFixture, boardSnapshotFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

const { moveTask } = vi.hoisted(() => ({
  moveTask: vi.fn(),
}));

vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection: vi.fn(() => null),
  requireSubscriptions: vi.fn(),
  requireVerbClient: () => ({ moveTask }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
// @/connection/actions also imports settingsStore, which persists via
// expo-secure-store - fake it so the vitest (node) run has no native module.
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

// An archived, non-done column sits BEFORE the done column here on purpose:
// a wrong predicate that matches on `is_archived` (or matches the first
// archived column found) rather than `role === 'done'` would pick this one
// instead and silently archive into the wrong lane.
const COLUMNS = [
  boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 }),
  boardColumnFixture({ id: 'lane-old-sprint', name: 'Old Sprint', position: 1, is_archived: true }),
  boardColumnFixture({ id: 'lane-done', name: 'Done', position: 2, role: 'done', is_archived: true }),
];

function seedBoardWithDoneColumn(): void {
  useBoardStore.getState().applyBoardSnapshot(
    boardSnapshotFixture({
      projectId: 'project-1',
      columns: COLUMNS,
      tasks: [boardTaskFixture({ id: 'task-1', swimlane_id: 'lane-todo', position: 0 })],
    }),
  );
}

afterEach(() => {
  moveTask.mockReset();
  useBoardStore.getState().reset();
});

describe('archiveTask', () => {
  it('moves the task into the done column matched by role alone, even though the done column carries is_archived: true', async () => {
    seedBoardWithDoneColumn();
    moveTask.mockResolvedValue({ ok: true });

    await archiveTask({ projectId: 'project-1', taskId: 'task-1' });

    expect(moveTask).toHaveBeenCalledWith({
      taskId: 'task-1',
      targetSwimlaneId: 'lane-done',
      targetPosition: 0,
      projectId: 'project-1',
    });
    expect(useBoardStore.getState().boardsByProjectId['project-1'].tasksById['task-1'].swimlane_id).toBe('lane-done');
  });

  it('throws when the board has no done column, and never calls moveTask', async () => {
    useBoardStore.getState().applyBoardSnapshot(
      boardSnapshotFixture({
        projectId: 'project-2',
        columns: [boardColumnFixture({ id: 'lane-todo', name: 'To Do', position: 0 })],
        tasks: [boardTaskFixture({ id: 'task-2', swimlane_id: 'lane-todo', position: 0 })],
      }),
    );

    await expect(archiveTask({ projectId: 'project-2', taskId: 'task-2' })).rejects.toThrow(
      'This board has no Done column to archive into',
    );
    expect(moveTask).not.toHaveBeenCalled();
  });
});
