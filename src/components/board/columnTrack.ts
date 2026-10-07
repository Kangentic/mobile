import type { BoardColumnWire } from '@kangentic/protocol';
import { isDoneRole, isTodoRole } from '@/state/boardStore';

/**
 * One mark of the column strip's step track.
 *
 * A UI view model, not a wire type: it is shaped like the desktop's
 * `WorkflowRouteStep` (kangentic #732) so the strip draws the desktop's
 * route-aware track unchanged. When the route lands in `@kangentic/protocol`,
 * map the protocol type INTO this one rather than widening it - see
 * .claude/rules/protocol-types-from-package.md.
 */
export interface ColumnTrackStep {
  columnId: string;
  name: string;
  color: string;
  /** `skipped` comes only from a route that leaves a column out; the strip does not draw it. */
  state: 'done' | 'current' | 'ahead' | 'skipped';
}

/**
 * The task's whole journey, one step per stop in board order: the board's To
 * Do column, each working column, then its Done column. The track keeps the
 * same length for the task's whole life and only the `current` step moves, as
 * the desktop's approved track does (design sign-off T2, 2026-10-07).
 *
 * - To Do is `current` while the task waits there, `done` once it has left.
 * - A working column is `current` while the task is in it, `skipped` when the
 *   route leaves it out, `done` once passed (every one of them once the task
 *   is Done), and `ahead` otherwise. The task's own column is `current` even
 *   when its route skips it, so a task moved into a skipped column still shows
 *   where it is.
 * - Done is `ahead` until the task finishes, then `current`.
 *
 * A port of the desktop's `routeSteps` and `boardEnds` (#732,
 * `src/shared/workflow-route.ts`), in the same order of checks. Working
 * columns are its route candidates: the visible ones minus both system roles.
 * The ends are found as its `todoColumn` / `doneColumn` find them, by role and
 * excluding only ghosts, because the desktop's Done lane arrives flagged
 * `is_archived`. A board without one of the two simply has no such end.
 *
 * `route` is the column ids the task visits. Null means every working column,
 * which is right for an ordinary task and is phase 1's stand-in for a workflow
 * task, whose route is not on the wire yet; once it is, callers pass
 * `task.workflow?.route ?? null`. An empty array is a route that visits
 * nothing, not "no route".
 *
 * Returns no steps when the task's column is not a stop of the journey (an
 * archived or ghost working column, an unknown id, or no column at all), so
 * the strip draws the column's marker alone rather than a track with nothing
 * current.
 */
export function buildJourneyTrack(
  columns: readonly BoardColumnWire[],
  currentColumnId: string | null,
  route: readonly string[] | null = null,
): ColumnTrackStep[] {
  if (currentColumnId === null) return [];
  const todoColumn = columns.find((column) => isTodoRole(column.role) && !column.is_ghost) ?? null;
  const doneColumn = columns.find((column) => isDoneRole(column.role) && !column.is_ghost) ?? null;
  const workingColumns = columns
    .filter(
      (column) => !column.is_archived && !column.is_ghost && !isTodoRole(column.role) && !isDoneRole(column.role),
    )
    .sort((first, second) => first.position - second.position);

  // Passed is decided by sort index, not by comparing positions: two columns
  // tied on position keep their snapshot order, and the one drawn first is the
  // one the task has passed.
  const currentWorkingIndex = workingColumns.findIndex((column) => column.id === currentColumnId);
  const place =
    todoColumn?.id === currentColumnId
      ? 'todo'
      : doneColumn?.id === currentColumnId
        ? 'done'
        : currentWorkingIndex !== -1
          ? 'working'
          : null;
  if (place === null) return [];

  const onRoute = route === null ? null : new Set(route);
  const workingSteps = workingColumns.map((column, columnIndex): ColumnTrackStep => {
    if (columnIndex === currentWorkingIndex) return stepOf(column, 'current');
    if (onRoute !== null && !onRoute.has(column.id)) return stepOf(column, 'skipped');
    if (place === 'done' || columnIndex < currentWorkingIndex) return stepOf(column, 'done');
    return stepOf(column, 'ahead');
  });
  return [
    ...(todoColumn !== null ? [stepOf(todoColumn, place === 'todo' ? 'current' : 'done')] : []),
    ...workingSteps,
    ...(doneColumn !== null ? [stepOf(doneColumn, place === 'done' ? 'current' : 'ahead')] : []),
  ];
}

function stepOf(column: BoardColumnWire, state: ColumnTrackStep['state']): ColumnTrackStep {
  return { columnId: column.id, name: column.name, color: column.color, state };
}
