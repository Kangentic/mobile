/**
 * boardStore's protocol 0.28.0 share: whether the desktop offers the resume on
 * open, and the project's priority scale.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { PriorityLevelWire } from '@kangentic/protocol';
import { selectPriorityScale, selectResumeOnOpenOffered, useBoardStore } from '@/state/boardStore';
import { boardSnapshotFixture } from '@/devsupport/desktopFixtures';

const SCALE: PriorityLevelWire[] = [
  { label: 'None', color: '#888888' },
  { label: 'Low', color: '#22aa44' },
  { label: 'Urgent', color: '#ff0000' },
];

function applyFlags(projectId: string, fields: { resumeOnOpenOffered?: boolean; priorities?: PriorityLevelWire[] }): void {
  useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId, tasks: [], ...fields }));
}

describe('boardStore and the 0.28.0 board fields', () => {
  beforeEach(() => {
    useBoardStore.getState().reset();
  });

  describe('resumeOnOpenOffered', () => {
    it.each([
      ['true', true, true],
      ['false', false, false],
      ['absent', undefined, false],
    ])('stores %s as %s', (_label, wireValue, expected) => {
      applyFlags('project-1', wireValue === undefined ? {} : { resumeOnOpenOffered: wireValue });

      expect(useBoardStore.getState().boardsByProjectId['project-1'].resumeOnOpenOffered).toBe(expected);
    });

    it('is selected false for no project and an unknown project, true once a snapshot offers it', () => {
      expect(selectResumeOnOpenOffered(useBoardStore.getState(), null)).toBe(false);
      expect(selectResumeOnOpenOffered(useBoardStore.getState(), 'project-1')).toBe(false);

      applyFlags('project-1', { resumeOnOpenOffered: true });
      expect(selectResumeOnOpenOffered(useBoardStore.getState(), 'project-1')).toBe(true);
      expect(selectResumeOnOpenOffered(useBoardStore.getState(), 'project-2')).toBe(false);
    });
  });

  describe('priorities', () => {
    it('keeps the scale the snapshot carried', () => {
      applyFlags('project-1', { priorities: SCALE });

      expect(useBoardStore.getState().boardsByProjectId['project-1'].priorities).toEqual(SCALE);
    });

    it('stores null when the snapshot carries none (an older desktop)', () => {
      applyFlags('project-1', {});

      expect(useBoardStore.getState().boardsByProjectId['project-1'].priorities).toBeNull();
    });

    it('is selected null for no project and an unknown project, and the stored array once a snapshot carries one', () => {
      expect(selectPriorityScale(useBoardStore.getState(), null)).toBeNull();
      expect(selectPriorityScale(useBoardStore.getState(), 'project-1')).toBeNull();

      applyFlags('project-1', { priorities: SCALE });
      const state = useBoardStore.getState();
      expect(selectPriorityScale(state, 'project-1')).toBe(state.boardsByProjectId['project-1'].priorities);
      expect(selectPriorityScale(state, 'project-2')).toBeNull();
    });
  });
});
