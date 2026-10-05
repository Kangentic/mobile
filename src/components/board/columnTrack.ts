import type { BoardColumnWire } from '@kangentic/protocol';
import { isDoneRole, isTodoRole } from '@/state/boardStore';

/**
 * One segment of the column strip's step track.
 *
 * A UI view model, not a wire type: it is shaped like the desktop's
 * `WorkflowRouteStep` (kangentic #732) so the strip can draw the desktop's
 * route-aware track unchanged once that route reaches the phone. Phase 1 has
 * no route on the wire and fills it from column order instead
 * (`buildPositionalTrack`). When the route lands in `@kangentic/protocol`, map
 * the protocol type INTO this one rather than widening it - see
 * .claude/rules/protocol-types-from-package.md.
 */
export interface ColumnTrackStep {
  columnId: string;
  name: string;
  color: string;
  /** `skipped` is never produced from column order; it exists for the route-aware track, which does not draw it. */
  state: 'done' | 'current' | 'ahead' | 'skipped';
}

/**
 * The track as column ORDER describes it: every working column before the
 * task's is done, its own is current, the rest are ahead.
 *
 * Working columns are the desktop's route candidates: the visible ones minus
 * the To Do and Done roles, which the desktop's track never draws either.
 * Visibility is `selectColumnsOrdered`'s rule (archived and ghost columns are
 * desktop-internal); its Done-lane carve-out is moot here because Done is
 * excluded by role anyway.
 *
 * Not route-aware, and that is the known phase 1 gap: a task that skipped a
 * column shows it as done, where the desktop leaves it out. Returns no steps
 * at all when the task's column is not a working column (To Do, Done,
 * archived, ghost, or unresolved), so the strip draws no track rather than a
 * track with nothing current.
 */
export function buildPositionalTrack(
  columns: readonly BoardColumnWire[],
  currentColumnId: string | null,
): ColumnTrackStep[] {
  if (currentColumnId === null) return [];
  const workingColumns = columns
    .filter(
      (column) => !column.is_archived && !column.is_ghost && !isTodoRole(column.role) && !isDoneRole(column.role),
    )
    .sort((first, second) => first.position - second.position);
  const currentIndex = workingColumns.findIndex((column) => column.id === currentColumnId);
  if (currentIndex === -1) return [];
  return workingColumns.map((column, columnIndex) => ({
    columnId: column.id,
    name: column.name,
    color: column.color,
    state: columnIndex < currentIndex ? 'done' : columnIndex === currentIndex ? 'current' : 'ahead',
  }));
}
