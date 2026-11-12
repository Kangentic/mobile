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
   * the desktop's old `taskHeld`. Read only for a desktop before v0.55.0
   * (see `movesStoppedCards`): a current one has no hold in its lock, refuses
   * to set one on a running or paused workflow's task, and cleared the old
   * ones. Not gated on `automations_pausable`: a desktop older than that field
   * clears the switch when a task joins a workflow and refuses to set it on
   * one, so it never sends a held workflow row.
   */
  held: boolean;
}

/**
 * Whether this row comes from a desktop that lets a hand take a STOPPED card
 * of a running workflow to any column but To Do (kangentic v0.55.0, ec403ad81
 * "a stopped card is the owner's to move"). There `lock_reason` alone says
 * whether the card is in motion: null means stopped, and `gate_target_id`
 * only names the likeliest next column.
 *
 * No protocol field marks that desktop, so this reads the one that changed
 * with it. The same release made a running or paused workflow's task refuse
 * a hold (7aff391f1), and its rows say so with `automations_pausable: false`.
 * Every older desktop sends `true` on every workflow row (v0.51.0 to v0.54.0,
 * protocol 0.25.0 to 0.27.0) or omits the field (before 0.25.0), and there a
 * null lock on a running card meant held or in a human gate, which opens only
 * the gate's target. Read from the desktop's tags and its workflow-wire.ts at
 * v0.54.0, not measured against a live older desktop.
 *
 * Decision (task #143): the phone keeps the older rule for an older desktop
 * rather than reading a null lock as "any column" everywhere, as the protocol
 * doc does, because that desktop refuses those columns itself.
 */
function movesStoppedCards(workflow: BoardTaskWorkflowWire): boolean {
  return workflow.automations_pausable === false;
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
 * - A paused workflow's task moves by hand to any other column.
 * - A running workflow's task is locked while it is in motion and the
 *   owner's once it stops (the desktop's "in motion, locked; stopped, the
 *   owner's", 2026-11-05): a stopped card moves by hand to any column but To
 *   Do. The desktop decides which, and says so with `lock_reason`, null on a
 *   stopped card. A card in To Do or Done is never stopped.
 * - On a desktop before v0.55.0 (`movesStoppedCards`), a running workflow's
 *   card moves by hand only while held (its own automations paused, kangentic
 *   #923), to any column but To Do, or out of a human gate into the gate's
 *   target (`gate_target_id`). The hold is checked first, so a stale gate
 *   left by an optimistic hold cannot pin it.
 *
 * The stopped-card branch asks for the RAW state `running`, so a state this
 * app does not know (read as running) never unlocks a card.
 */
export function workflowAllowsMove(check: WorkflowMoveCheck): boolean {
  const { workflow } = check;
  if (!workflow) return true;
  if (check.fromColumnId === check.toColumnId) return true;
  const state = normalizeWorkflowState(workflow.state);
  if (state === 'draft' || state === 'done') return true;
  if (isTodoRole(check.toRole)) return false;
  if (state === 'paused') return true;
  if (workflow.state === 'running' && movesStoppedCards(workflow)) return workflow.lock_reason === null;
  // A desktop before v0.55.0: a null lock meant held or in a human gate.
  if (check.held) return true;
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
