import type { BoardTaskWorkflowWire } from '@kangentic/protocol';

/**
 * A workflow's state and color, read the way the desktop reads them.
 *
 * The wire carries both loosely on purpose (`BoardTaskWorkflowWire.state` is an
 * open string, `color_slot` any number), so every surface narrows them here
 * once rather than at each call site.
 */

/** The four states the desktop gives a workflow (its `WorkflowState`). */
export type WorkflowStateName = 'running' | 'paused' | 'draft' | 'done';

function isWorkflowStateName(value: string): value is WorkflowStateName {
  return value === 'running' || value === 'paused' || value === 'draft' || value === 'done';
}

/**
 * The wire's state, narrowed. A value this app does not know reads as running,
 * as the protocol documents: the strictest reading for a move, so a state a
 * newer desktop adds can never unlock a card the desktop still locks.
 */
export function normalizeWorkflowState(state: string): WorkflowStateName {
  return isWorkflowStateName(state) ? state : 'running';
}

/** The desktop's word for each state, as its state chip prints it (`WorkflowStateChip`). */
export function workflowStateLabel(state: WorkflowStateName): string {
  switch (state) {
    case 'running':
      return 'Running';
    case 'paused':
      return 'Paused';
    case 'draft':
      return 'Not started';
    case 'done':
      return 'Complete';
  }
}

/** What a card's strip names on its left for a workflow task (ColumnStrip's `workflow`). */
export interface WorkflowStripLabel {
  title: string;
  colorSlot: number;
  paused: boolean;
}

/** The strip's workflow label for a board row, or null for an ordinary task. */
export function workflowStripLabel(workflow: BoardTaskWorkflowWire | null | undefined): WorkflowStripLabel | null {
  if (!workflow) return null;
  return { title: workflow.title, colorSlot: workflow.color_slot, paused: normalizeWorkflowState(workflow.state) === 'paused' };
}

/** How many categorical colors a workflow can wear (the desktop's `--color-chart-1..6`). */
export const WORKFLOW_SLOT_COUNT = 6;

/**
 * The color slot, 1 to 6, clamped exactly as the desktop's `workflowColor`
 * clamps it: rounded, with anything unreadable (NaN, 0) reading as 1.
 */
export function workflowSlotNumber(colorSlot: number): number {
  return Math.min(WORKFLOW_SLOT_COUNT, Math.max(1, Math.round(colorSlot) || 1));
}

/**
 * The count beside a workflow's state chip, worded as the desktop's picker
 * words it: tasks done of all its tasks once started, and a plain task count
 * for a workflow that has not started.
 */
export function workflowCountLabel(state: WorkflowStateName, doneCount: number, taskCount: number): string {
  if (state === 'draft') return `${taskCount} ${taskCount === 1 ? 'task' : 'tasks'}`;
  return `${doneCount} of ${taskCount}`;
}
