import { describe, expect, it } from 'vitest';
import { buildPositionalTrack, type ColumnTrackStep } from '@/components/board/columnTrack';
import { boardColumnFixture } from '@/devsupport/desktopFixtures';

/** The mock desktop's storefront board (src/connection/mockDesktop.ts, mockColumns). */
const STOREFRONT_COLUMNS = [
  boardColumnFixture({ id: 'lane-todo', name: 'To Do', role: 'todo', position: 0, color: '#8b949e' }),
  boardColumnFixture({ id: 'lane-planning', name: 'Planning', role: null, position: 1, color: '#8957e5' }),
  boardColumnFixture({ id: 'lane-executing', name: 'Executing', role: null, position: 2, color: '#58a6ff' }),
  boardColumnFixture({ id: 'lane-code-review', name: 'Code Review', role: null, position: 3, color: '#d29922' }),
  boardColumnFixture({ id: 'lane-testing', name: 'Testing', role: null, position: 4, color: '#39c5cf' }),
  boardColumnFixture({ id: 'lane-merge', name: 'Merge', role: null, position: 5, color: '#f0883e' }),
  boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 6, color: '#3fb950', is_archived: true }),
];

function statesOf(track: ColumnTrackStep[]): string[] {
  return track.map((step) => `${step.columnId}:${step.state}`);
}

describe('buildPositionalTrack', () => {
  it('marks working columns before the task done, its own current, and the rest ahead', () => {
    expect(statesOf(buildPositionalTrack(STOREFRONT_COLUMNS, 'lane-executing'))).toEqual([
      'lane-planning:done',
      'lane-executing:current',
      'lane-code-review:ahead',
      'lane-testing:ahead',
      'lane-merge:ahead',
    ]);
  });

  /**
   * The desktop's track draws route candidates only, which exclude both system
   * roles (kangentic #732, routeCandidates). A track that counted To Do would
   * put a "done" segment in front of every task that ever left it.
   */
  it('never includes the To Do or Done roles', () => {
    const columnIds = buildPositionalTrack(STOREFRONT_COLUMNS, 'lane-merge').map((step) => step.columnId);
    expect(columnIds).not.toContain('lane-todo');
    expect(columnIds).not.toContain('lane-done');
  });

  it('carries each column\'s own name and color onto its step', () => {
    const planningStep = buildPositionalTrack(STOREFRONT_COLUMNS, 'lane-testing')[0];
    expect(planningStep).toEqual({ columnId: 'lane-planning', name: 'Planning', color: '#8957e5', state: 'done' });
  });

  it('drops archived and ghost columns, which the desktop does not show', () => {
    const columns = [
      ...STOREFRONT_COLUMNS,
      boardColumnFixture({ id: 'lane-old-sprint', name: 'Old Sprint', role: null, position: 3.5, is_archived: true }),
      boardColumnFixture({ id: 'lane-ghost', name: 'Ghost', role: null, position: 4.5, is_ghost: true }),
    ];
    const columnIds = buildPositionalTrack(columns, 'lane-executing').map((step) => step.columnId);
    expect(columnIds).not.toContain('lane-old-sprint');
    expect(columnIds).not.toContain('lane-ghost');
  });

  it('orders by position, not by the order the snapshot listed the columns in', () => {
    const shuffled = [STOREFRONT_COLUMNS[4], STOREFRONT_COLUMNS[2], STOREFRONT_COLUMNS[5], STOREFRONT_COLUMNS[1], STOREFRONT_COLUMNS[3]].filter(
      (column) => column !== undefined,
    );
    expect(buildPositionalTrack(shuffled, 'lane-code-review').map((step) => step.columnId)).toEqual([
      'lane-planning',
      'lane-executing',
      'lane-code-review',
      'lane-testing',
      'lane-merge',
    ]);
  });

  /** The desktop draws a lone current segment rather than hiding the track, so the phone does too. */
  it('draws a single current step on a board with one working column', () => {
    const columns = [
      boardColumnFixture({ id: 'lane2-backlog', name: 'Backlog', role: 'todo', position: 0 }),
      boardColumnFixture({ id: 'lane2-progress', name: 'In Progress', role: null, position: 1, color: '#d29922' }),
      boardColumnFixture({ id: 'lane2-shipped', name: 'Shipped', role: 'done', position: 2 }),
    ];
    expect(statesOf(buildPositionalTrack(columns, 'lane2-progress'))).toEqual(['lane2-progress:current']);
  });

  it('returns no steps when the task sits outside the working columns, rather than a track with nothing current', () => {
    expect(buildPositionalTrack(STOREFRONT_COLUMNS, 'lane-todo')).toEqual([]);
    expect(buildPositionalTrack(STOREFRONT_COLUMNS, 'lane-done')).toEqual([]);
    expect(buildPositionalTrack(STOREFRONT_COLUMNS, 'lane-unknown')).toEqual([]);
  });

  it('returns no steps when no column resolved', () => {
    expect(buildPositionalTrack(STOREFRONT_COLUMNS, null)).toEqual([]);
    expect(buildPositionalTrack([], 'lane-executing')).toEqual([]);
  });

  it('never produces a skipped step - that state belongs to the route-aware track', () => {
    const states = buildPositionalTrack(STOREFRONT_COLUMNS, 'lane-testing').map((step) => step.state);
    expect(states).not.toContain('skipped');
  });
});
