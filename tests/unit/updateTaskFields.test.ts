/**
 * updateTaskFields carrying the column automations switch (protocol 0.22.0).
 * The switch has no verb of its own: it is `update_task`'s camelCase
 * `automationsDisabled` param, and the desktop ignores an unknown key, so the
 * snake_case spelling the board row uses would be a silent no-op the card's
 * optimistic flip would then hide until the next read. Mocked wholesale in
 * every component test, so this is the only place the real write runs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CapabilityError } from '@/channel';
import { updateTaskFields } from '@/connection/actions';
import { useBoardStore } from '@/state/boardStore';
import { boardSnapshotFixture, boardTaskFixture } from '@/devsupport/desktopFixtures';

const { boardToolWrite } = vi.hoisted(() => ({
  boardToolWrite: vi.fn(),
}));

vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection: vi.fn(() => null),
  requireSubscriptions: vi.fn(),
  requireVerbClient: () => ({ boardToolWrite }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
// @/connection/actions also imports settingsStore, which persists via
// expo-secure-store - fake it so the vitest (node) run has no native module.
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

function seedBoard(automationsDisabled = false): void {
  useBoardStore.getState().applyBoardSnapshot(
    boardSnapshotFixture({
      projectId: 'project-1',
      tasks: [boardTaskFixture({ id: 'task-1', title: 'Fix the login bug', automations_disabled: automationsDisabled })],
    }),
  );
}

function automationsDisabledOfTask(): boolean | null | undefined {
  return useBoardStore.getState().boardsByProjectId['project-1'].tasksById['task-1'].automations_disabled;
}

afterEach(() => {
  boardToolWrite.mockReset();
  useBoardStore.getState().reset();
});

describe('updateTaskFields: the automations switch', () => {
  it('sends the camelCase automationsDisabled param through update_task, and nothing it was not given', async () => {
    seedBoard();
    boardToolWrite.mockResolvedValue({ updated: 'task-1' });

    await updateTaskFields({ projectId: 'project-1', taskId: 'task-1', automationsDisabled: true });

    expect(boardToolWrite).toHaveBeenCalledWith('update_task', { project: 'project-1', taskId: 'task-1', automationsDisabled: true });
  });

  it('flips the card before the desktop answers, and keeps the flip once it accepts', async () => {
    seedBoard();
    let acceptWrite: (value: unknown) => void = () => undefined;
    boardToolWrite.mockReturnValue(
      new Promise((resolve) => {
        acceptWrite = resolve;
      }),
    );

    const write = updateTaskFields({ projectId: 'project-1', taskId: 'task-1', automationsDisabled: true });
    expect(automationsDisabledOfTask()).toBe(true);

    acceptWrite({ updated: 'task-1' });
    await write;
    expect(automationsDisabledOfTask()).toBe(true);
    expect(useBoardStore.getState().pendingEdits).toEqual([]);
  });

  it('puts the card back and rethrows the desktop refusal', async () => {
    seedBoard();
    const refusal = new CapabilityError('board-tool-write', 'This task is in a workflow. Pause the workflow to hold it. The task was not updated.');
    boardToolWrite.mockRejectedValue(refusal);

    await expect(updateTaskFields({ projectId: 'project-1', taskId: 'task-1', automationsDisabled: true })).rejects.toBe(refusal);

    expect(automationsDisabledOfTask()).toBe(false);
    expect(useBoardStore.getState().pendingEdits).toEqual([]);
  });

  // Enable automations is `false`, the falsy value. A truthy check anywhere on
  // the path (the param spread, the optimistic row) would drop exactly this
  // write while every `true` test above stayed green.
  describe('enabling a held task (automationsDisabled: false)', () => {
    it('sends automationsDisabled: false through update_task rather than dropping it as falsy', async () => {
      seedBoard(true);
      boardToolWrite.mockResolvedValue({ updated: 'task-1' });

      await updateTaskFields({ projectId: 'project-1', taskId: 'task-1', automationsDisabled: false });

      expect(boardToolWrite).toHaveBeenCalledWith('update_task', { project: 'project-1', taskId: 'task-1', automationsDisabled: false });
    });

    it('flips the held card to enabled before the desktop answers, and keeps the flip once it accepts', async () => {
      seedBoard(true);
      let acceptWrite: (value: unknown) => void = () => undefined;
      boardToolWrite.mockReturnValue(
        new Promise((resolve) => {
          acceptWrite = resolve;
        }),
      );
      expect(automationsDisabledOfTask()).toBe(true);

      const write = updateTaskFields({ projectId: 'project-1', taskId: 'task-1', automationsDisabled: false });
      expect(automationsDisabledOfTask()).toBe(false);

      acceptWrite({ updated: 'task-1' });
      await write;
      expect(automationsDisabledOfTask()).toBe(false);
      expect(useBoardStore.getState().pendingEdits).toEqual([]);
    });

    it('puts the card back on held and rethrows when the desktop refuses the write', async () => {
      seedBoard(true);
      const refusal = new CapabilityError('board-tool-write', 'refused by the desktop');
      let refuseWrite: (reason: unknown) => void = () => undefined;
      boardToolWrite.mockReturnValue(
        new Promise((_resolve, reject) => {
          refuseWrite = reject;
        }),
      );

      const write = updateTaskFields({ projectId: 'project-1', taskId: 'task-1', automationsDisabled: false });
      // The flip is in flight, so the rollback below has something to undo.
      expect(automationsDisabledOfTask()).toBe(false);

      refuseWrite(refusal);
      await expect(write).rejects.toBe(refusal);

      expect(automationsDisabledOfTask()).toBe(true);
      expect(useBoardStore.getState().pendingEdits).toEqual([]);
    });
  });
});
