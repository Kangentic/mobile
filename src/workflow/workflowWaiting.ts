import type { BoardTaskWorkflowWire } from '@kangentic/protocol';
import { isTodoRole } from '@/state/boardStore';
import { normalizeWorkflowState } from './workflowState';

/** What a waiting workflow card's footer says, and whether it draws the pause glyph. */
export interface WorkflowWaitingFooter {
  label: string;
  paused: boolean;
}

/**
 * The footer of a workflow task that waits in To Do, worded as the desktop's
 * `waitingLabel` (src/shared/workflow-waiting.ts) words it:
 *
 * - one task it waits for: "Blocked by #413..."
 * - several: "Blocked by 2 tasks..." (a count, never a list)
 * - none, workflow paused: "Paused"
 * - none, workflow running: "Queued..." (it waits for an agent slot)
 *
 * A blocker wins over the pause. Only in To Do, and only while the workflow is
 * running or paused (the desktop's `boardWaiting`); the caller shows it only
 * when the card has no session footer of its own.
 */
export function workflowWaitingFooter(
  workflow: BoardTaskWorkflowWire | null | undefined,
  columnRole: string | null,
): WorkflowWaitingFooter | null {
  if (!workflow || !isTodoRole(columnRole)) return null;
  const state = normalizeWorkflowState(workflow.state);
  if (state !== 'running' && state !== 'paused') return null;
  const pending = workflow.waiting_for;
  if (pending.length === 1) return { label: `Blocked by ${pending[0]}...`, paused: false };
  if (pending.length > 1) return { label: `Blocked by ${pending.length} tasks...`, paused: false };
  if (state === 'paused') return { label: 'Paused', paused: true };
  return { label: 'Queued...', paused: false };
}
