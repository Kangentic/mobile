import { describe, expect, it } from 'vitest';
import { buildJourneyTrack, type ColumnTrackStep } from '@/components/board/columnTrack';
import { boardColumnFixture } from '@/devsupport/desktopFixtures';

/** The mock desktop's storefront board (src/connection/mockDesktop.ts, mockColumns). */
const STOREFRONT_COLUMNS = [
  boardColumnFixture({ id: 'lane-todo', name: 'To Do', role: 'todo', position: 0, color: '#8b949e' }),
  boardColumnFixture({ id: 'lane-planning', name: 'Planning', role: null, position: 1, color: '#8957e5' }),
  boardColumnFixture({ id: 'lane-executing', name: 'Executing', role: null, position: 2, color: '#58a6ff' }),
  boardColumnFixture({ id: 'lane-code-review', name: 'Code Review', role: null, position: 3, color: '#d29922' }),
  boardColumnFixture({ id: 'lane-testing', name: 'Testing', role: null, position: 4, color: '#39c5cf' }),
  boardColumnFixture({ id: 'lane-merge', name: 'Merge', role: null, position: 5, color: '#f0883e' }),
  boardColumnFixture({ id: 'lane-done', name: 'Done', role: 'done', position: 6, color: '#3fb950' }),
];

/** The route in the desktop sign-off's example: Planning skipped. */
const ROUTE_WITHOUT_PLANNING = ['lane-executing', 'lane-code-review', 'lane-testing', 'lane-merge'];

function statesOf(track: ColumnTrackStep[]): string[] {
  return track.map((step) => `${step.columnId}:${step.state}`);
}

/** What the strip draws: every step but the skipped ones. */
function visibleStatesOf(track: ColumnTrackStep[]): string[] {
  return statesOf(track.filter((step) => step.state !== 'skipped'));
}

/** The storefront columns a task on `route` stops at: both ends always, and each working column the route visits (every one without a route). */
function stopsOf(route: readonly string[] | null): typeof STOREFRONT_COLUMNS {
  return STOREFRONT_COLUMNS.filter((column) => column.role !== null || route === null || route.includes(column.id));
}

describe('buildJourneyTrack', () => {
  describe('the whole journey, To Do to Done', () => {
    it('marks To Do and the columns passed done, the task\'s own current, and the rest and Done ahead', () => {
      expect(statesOf(buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-executing'))).toEqual([
        'lane-todo:done',
        'lane-planning:done',
        'lane-executing:current',
        'lane-code-review:ahead',
        'lane-testing:ahead',
        'lane-merge:ahead',
        'lane-done:ahead',
      ]);
    });

    it('puts a task waiting in To Do at the start, with every stop ahead', () => {
      expect(statesOf(buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-todo'))).toEqual([
        'lane-todo:current',
        'lane-planning:ahead',
        'lane-executing:ahead',
        'lane-code-review:ahead',
        'lane-testing:ahead',
        'lane-merge:ahead',
        'lane-done:ahead',
      ]);
    });

    it('puts a finished task at the end, with every stop passed', () => {
      expect(statesOf(buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-done'))).toEqual([
        'lane-todo:done',
        'lane-planning:done',
        'lane-executing:done',
        'lane-code-review:done',
        'lane-testing:done',
        'lane-merge:done',
        'lane-done:current',
      ]);
    });

    /**
     * The design's point: a card's track keeps one length its whole life, and
     * only the marker moves along it. "Its life" is its own stops: a task an
     * agent moves into a column its route skips gains that mark (see below).
     */
    it('keeps the same length at every stop of the journey, with exactly one current stop', () => {
      for (const route of [null, ROUTE_WITHOUT_PLANNING]) {
        const tracks = stopsOf(route).map((column) => buildJourneyTrack(STOREFRONT_COLUMNS, column.id, route).filter((step) => step.state !== 'skipped'));
        const lengths = new Set(tracks.map((track) => track.length));
        expect(lengths.size).toBe(1);
        for (const track of tracks) {
          expect(track.filter((step) => step.state === 'current')).toHaveLength(1);
        }
      }
    });
  });

  /**
   * The sign-off's own example (kangentic #732 design canvas, T2): a route of
   * Executing, Code Review, Testing and Merge, Planning skipped, draws six
   * marks in every state.
   */
  describe('a route that skips a column', () => {
    it('in To Do: the To Do marker, four bars ahead, then Done ahead', () => {
      expect(visibleStatesOf(buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-todo', ROUTE_WITHOUT_PLANNING))).toEqual([
        'lane-todo:current',
        'lane-executing:ahead',
        'lane-code-review:ahead',
        'lane-testing:ahead',
        'lane-merge:ahead',
        'lane-done:ahead',
      ]);
    });

    it('in Code Review: To Do and Executing passed, the Code Review marker, then Testing, Merge and Done ahead', () => {
      expect(visibleStatesOf(buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-code-review', ROUTE_WITHOUT_PLANNING))).toEqual([
        'lane-todo:done',
        'lane-executing:done',
        'lane-code-review:current',
        'lane-testing:ahead',
        'lane-merge:ahead',
        'lane-done:ahead',
      ]);
    });

    it('in Done: five passed bars, then the Done marker', () => {
      expect(visibleStatesOf(buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-done', ROUTE_WITHOUT_PLANNING))).toEqual([
        'lane-todo:done',
        'lane-executing:done',
        'lane-code-review:done',
        'lane-testing:done',
        'lane-merge:done',
        'lane-done:current',
      ]);
    });

    it('marks the skipped column skipped rather than dropping it, so the step keeps its board position', () => {
      const planningStep = buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-merge', ROUTE_WITHOUT_PLANNING)[1];
      expect(planningStep).toMatchObject({ columnId: 'lane-planning', state: 'skipped' });
    });

    /** As the desktop's routeSteps does: the task's own column wins, so a task moved into a skipped column still shows where it is. */
    it('marks the task\'s column current even when its route skips it', () => {
      expect(visibleStatesOf(buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-planning', ROUTE_WITHOUT_PLANNING))).toEqual([
        'lane-todo:done',
        'lane-planning:current',
        'lane-executing:ahead',
        'lane-code-review:ahead',
        'lane-testing:ahead',
        'lane-merge:ahead',
        'lane-done:ahead',
      ]);
    });

    /** Null is "every working column"; an empty route visits none, and only the two ends remain. */
    it('reads an empty route as visiting no working column, not as no route', () => {
      expect(visibleStatesOf(buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-todo', []))).toEqual(['lane-todo:current', 'lane-done:ahead']);
    });
  });

  describe('the two ends', () => {
    /**
     * The desktop sends its Done lane flagged `is_archived` (the checkout-api
     * mock board does too). The ends are found by role, as the desktop's
     * doneColumn does, so the flag must not drop Done off the end of the track.
     */
    it('still ends on an archived Done lane', () => {
      const columns = STOREFRONT_COLUMNS.map((column) => (column.id === 'lane-done' ? { ...column, is_archived: true } : column));
      const track = buildJourneyTrack(columns, 'lane-testing');
      expect(track.at(-1)).toMatchObject({ columnId: 'lane-done', state: 'ahead' });
      expect(statesOf(buildJourneyTrack(columns, 'lane-done')).at(-1)).toBe('lane-done:current');
    });

    /** The same by-role rule for the other end: an archived To Do still starts the track, and a task waiting in it still has one. */
    it('still starts on an archived To Do lane', () => {
      const columns = STOREFRONT_COLUMNS.map((column) => (column.id === 'lane-todo' ? { ...column, is_archived: true } : column));
      const track = buildJourneyTrack(columns, 'lane-testing');
      expect(track[0]).toMatchObject({ columnId: 'lane-todo', state: 'done' });
      expect(statesOf(buildJourneyTrack(columns, 'lane-todo'))[0]).toBe('lane-todo:current');
    });

    /** The ends are placed by role, never sorted in with the working columns, so a To Do or Done lane at an odd position still opens or closes the track. */
    it('keeps To Do first and Done last whatever their positions', () => {
      const oddPositions: Record<string, number> = { 'lane-todo': 4.5, 'lane-done': 2.5 };
      const columns = STOREFRONT_COLUMNS.map((column) => ({ ...column, position: oddPositions[column.id] ?? column.position }));
      expect(buildJourneyTrack(columns, 'lane-executing').map((step) => step.columnId)).toEqual(STOREFRONT_COLUMNS.map((column) => column.id));
    });

    it('never treats a ghost To Do or Done as an end', () => {
      const columns = STOREFRONT_COLUMNS.map((column) => (column.role !== null ? { ...column, is_ghost: true } : column));
      expect(buildJourneyTrack(columns, 'lane-executing').map((step) => step.columnId)).toEqual([
        'lane-planning',
        'lane-executing',
        'lane-code-review',
        'lane-testing',
        'lane-merge',
      ]);
    });

    it('draws only the ends a board has', () => {
      const withoutTodo = STOREFRONT_COLUMNS.filter((column) => column.role !== 'todo');
      expect(buildJourneyTrack(withoutTodo, 'lane-executing')[0]?.columnId).toBe('lane-planning');
      const withoutDone = STOREFRONT_COLUMNS.filter((column) => column.role !== 'done');
      expect(buildJourneyTrack(withoutDone, 'lane-executing').at(-1)?.columnId).toBe('lane-merge');
    });

    it('carries each end\'s own name and color, which the strip draws them in', () => {
      const track = buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-executing');
      expect(track[0]).toEqual({ columnId: 'lane-todo', name: 'To Do', color: '#8b949e', state: 'done' });
      expect(track.at(-1)).toEqual({ columnId: 'lane-done', name: 'Done', color: '#3fb950', state: 'ahead' });
    });
  });

  describe('the working columns', () => {
    it('carries each column\'s own name and color onto its step', () => {
      const planningStep = buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-testing')[1];
      expect(planningStep).toEqual({ columnId: 'lane-planning', name: 'Planning', color: '#8957e5', state: 'done' });
    });

    it('drops archived and ghost columns, which the desktop does not show', () => {
      const columns = [
        ...STOREFRONT_COLUMNS,
        boardColumnFixture({ id: 'lane-old-sprint', name: 'Old Sprint', role: null, position: 3.5, is_archived: true }),
        boardColumnFixture({ id: 'lane-ghost', name: 'Ghost', role: null, position: 4.5, is_ghost: true }),
      ];
      const columnIds = buildJourneyTrack(columns, 'lane-executing').map((step) => step.columnId);
      expect(columnIds).not.toContain('lane-old-sprint');
      expect(columnIds).not.toContain('lane-ghost');
    });

    it('orders by position, not by the order the snapshot listed the columns in', () => {
      const shuffled = [5, 2, 6, 0, 4, 1, 3].map((index) => STOREFRONT_COLUMNS[index]).filter((column) => column !== undefined);
      expect(buildJourneyTrack(shuffled, 'lane-code-review').map((step) => step.columnId)).toEqual(STOREFRONT_COLUMNS.map((column) => column.id));
    });

    /** Passed means drawn before the marker: a column tied on position that sorts first is behind the task, never ahead of it. */
    it('marks a column that sorts before the task\'s own done, even when their positions tie', () => {
      const columns = [
        boardColumnFixture({ id: 'lane3-todo', name: 'To Do', role: 'todo', position: 0 }),
        boardColumnFixture({ id: 'lane3-first', name: 'First', role: null, position: 1 }),
        boardColumnFixture({ id: 'lane3-second', name: 'Second', role: null, position: 1 }),
        boardColumnFixture({ id: 'lane3-done', name: 'Done', role: 'done', position: 2 }),
      ];
      expect(statesOf(buildJourneyTrack(columns, 'lane3-second'))).toEqual([
        'lane3-todo:done',
        'lane3-first:done',
        'lane3-second:current',
        'lane3-done:ahead',
      ]);
    });

    it('draws the ends around a board\'s single working column', () => {
      const columns = [
        boardColumnFixture({ id: 'lane2-backlog', name: 'Backlog', role: 'todo', position: 0 }),
        boardColumnFixture({ id: 'lane2-progress', name: 'In Progress', role: null, position: 1, color: '#d29922' }),
        boardColumnFixture({ id: 'lane2-shipped', name: 'Shipped', role: 'done', position: 2 }),
      ];
      expect(statesOf(buildJourneyTrack(columns, 'lane2-progress'))).toEqual(['lane2-backlog:done', 'lane2-progress:current', 'lane2-shipped:ahead']);
    });

    it('never produces a skipped step without a route', () => {
      for (const column of STOREFRONT_COLUMNS) {
        expect(buildJourneyTrack(STOREFRONT_COLUMNS, column.id).map((step) => step.state)).not.toContain('skipped');
      }
    });
  });

  describe('a task outside the journey', () => {
    it('returns no steps for an archived or ghost working column, rather than a track with nothing current', () => {
      const columns = [
        ...STOREFRONT_COLUMNS,
        boardColumnFixture({ id: 'lane-old-sprint', name: 'Old Sprint', role: null, position: 3.5, is_archived: true }),
        boardColumnFixture({ id: 'lane-ghost', name: 'Ghost', role: null, position: 4.5, is_ghost: true }),
      ];
      expect(buildJourneyTrack(columns, 'lane-old-sprint')).toEqual([]);
      expect(buildJourneyTrack(columns, 'lane-ghost')).toEqual([]);
    });

    it('returns no steps for a column no board holds', () => {
      expect(buildJourneyTrack(STOREFRONT_COLUMNS, 'lane-unknown')).toEqual([]);
    });

    it('returns no steps when no column resolved', () => {
      expect(buildJourneyTrack(STOREFRONT_COLUMNS, null)).toEqual([]);
      expect(buildJourneyTrack([], 'lane-executing')).toEqual([]);
    });
  });
});
