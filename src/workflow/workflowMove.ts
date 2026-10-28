import type { BoardColumnWire, BoardTaskWire, BoardTaskWorkflowWire } from '@kangentic/protocol';
import { isTodoRole } from '@/state/boardStore';
import { normalizeWorkflowState } from './workflowState';

export interface WorkflowMoveCheck {
  /** The task's workflow; null or absent for an ordinary task. */
  workflow: BoardTaskWorkflowWire | null | undefined;
  fromColumnId: string;
  toColumnId: string;
  toRole: string | null;
  /**
   * The task's own automations are paused (`automations_disabled` is true),
   * the desktop's `taskHeld`. Not gated on `automations_pausable`: a desktop
   * older than that field clears the switch when a task joins a workflow and
   * refuses to set it on one, so it never sends a held workflow row.
   */
  held: boolean;
}

/**
 * Whether a hand on the phone may move a task, a port of the desktop's
 * `workflowMoveRefusal` (src/shared/workflow-lock.ts) for its `mobile` origin,
 * in the same order of checks. A yes or no rather than the desktop's sentence:
 * the phone disables a refused column and says nothing (design sign-off
 * 2026-10-17), and the desktop refuses the same move on its own anyway.
 *
 * - An ordinary task, and a move within its own column, always may.
 * - A draft or finished workflow's task may go anywhere, To Do included.
 * - No other workflow task moves into To Do: that move ends its session and
 *   deletes its worktree and branch.
 * - A paused workflow's task moves by hand to any other column, and so does a
 *   held one (its own automations paused, kangentic #923) while the rest of
 *   its workflow runs: the person working it is the one who moves it on. A
 *   held card is not limited to a human gate's target either.
 * - A running workflow's task moves only by the workflow, except out of a
 *   human gate into the next column on its route (`gate_target_id`), which is
 *   how a person reports that step done.
 *
 * `lock_reason` is not consulted: it is set exactly when the workflow runs and
 * the card is neither held nor gated, which the state, the hold and the gate
 * already say.
 */
export function workflowAllowsMove(check: WorkflowMoveCheck): boolean {
  const { workflow } = check;
  if (!workflow) return true;
  if (check.fromColumnId === check.toColumnId) return true;
  const state = normalizeWorkflowState(workflow.state);
  if (state === 'draft' || state === 'done') return true;
  if (isTodoRole(check.toRole)) return false;
  if (state === 'paused' || check.held) return true;
  return workflow.gate_target_id !== null && workflow.gate_target_id === check.toColumnId;
}

/**
 * The columns a hand may move a task to: every column but its own that
 * `workflowAllowsMove` accepts. The Move sheet disables the rest, and the
 * long-press hub disables Move when none is left, so the two read one rule and
 * the hub can never offer Move into a sheet with nothing to pick.
 */
export function workflowMoveTargetIds(
  task: Pick<BoardTaskWire, 'swimlane_id' | 'workflow' | 'automations_disabled'>,
  columns: readonly Pick<BoardColumnWire, 'id' | 'role'>[],
): Set<string> {
  const targetIds = new Set<string>();
  const held = task.automations_disabled === true;
  for (const column of columns) {
    if (column.id === task.swimlane_id) continue;
    if (workflowAllowsMove({ workflow: task.workflow, fromColumnId: task.swimlane_id, toColumnId: column.id, toRole: column.role, held })) {
      targetIds.add(column.id);
    }
  }
  return targetIds;
}

/**
 * Archive takes a task out of its workflow, which only the desktop's Remove
 * does, so it is refused for every workflow task in every state (the desktop's
 * `sendAwayRefusal`). The desktop would accept a paused workflow's archive as a
 * plain move into Done, so the phone refuses it itself.
 */
export function workflowBlocksArchive(workflow: BoardTaskWorkflowWire | null | undefined): boolean {
  return workflow !== null && workflow !== undefined;
}
