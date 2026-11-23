/**
 * boardStore's protocol 0.29.0 share: the desktop's Settings > Task > Cards
 * Priority and Labels switches, from the board snapshot.
 *
 * Mutations seen failing: the ingest's `?? true` turned into `=== true` (the
 * absent case stored false), and either selector's fallback turned to false
 * (the no-board cases).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { selectShowTaskLabels, selectShowTaskPriority, useBoardStore } from '@/state/boardStore';
import { boardSnapshotFixture } from '@/devsupport/desktopFixtures';

function applySwitches(projectId: string, fields: { showTaskPriority?: boolean; showTaskLabels?: boolean }): void {
  useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId, tasks: [], ...fields }));
}

describe('boardStore and the 0.29.0 card switches', () => {
  beforeEach(() => {
    useBoardStore.getState().reset();
  });

  describe.each([
    ['showTaskPriority', selectShowTaskPriority],
    ['showTaskLabels', selectShowTaskLabels],
  ] as const)('%s', (field, select) => {
    it.each([
      ['true as true', true, true],
      ['false as false', false, false],
      ['absent (an older desktop) as true', undefined, true],
    ])('stores %s', (_label, wireValue, expected) => {
      applySwitches('project-1', wireValue === undefined ? {} : { [field]: wireValue });

      expect(useBoardStore.getState().boardsByProjectId['project-1'][field]).toBe(expected);
    });

    it('is selected true for no project and a project with no board yet, so nothing blinks out while a board loads', () => {
      expect(select(useBoardStore.getState(), null)).toBe(true);
      expect(select(useBoardStore.getState(), 'project-1')).toBe(true);
    });

    it('is selected as the snapshot set it, for that project only', () => {
      applySwitches('project-1', { [field]: false });

      expect(select(useBoardStore.getState(), 'project-1')).toBe(false);
      expect(select(useBoardStore.getState(), 'project-2')).toBe(true);
    });

    it('follows the next snapshot, since the desktop raises no event for its settings', () => {
      applySwitches('project-1', { [field]: false });
      applySwitches('project-1', { [field]: true });

      expect(select(useBoardStore.getState(), 'project-1')).toBe(true);
    });
  });
});
