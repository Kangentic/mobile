import type { BoardTaskWorkflowWire } from '@kangentic/protocol';
import type { WorkflowDetail, WorkflowMember } from '@/workflow/workflowView';

/**
 * A board row's `workflow` (protocol 0.21.0), for the component tests: a
 * running workflow whose card is locked by nothing in particular (no gate, no
 * blocker). Override only what a test is about.
 */
export function workflowWireFixture(overrides: Partial<BoardTaskWorkflowWire> = {}): BoardTaskWorkflowWire {
  return {
    id: 'workflow-1',
    title: 'Ship the checkout',
    project_id: 'project-1',
    state: 'running',
    color_slot: 2,
    route: [],
    waiting_for: [],
    lock_reason: null,
    gate_target_id: null,
    ...overrides,
  };
}

/** The desktop's own sentence for a refused move, as a locked running card carries it. */
export const WORKFLOW_LOCK_REASON = 'This task is moved by its workflow.';

/** One task of a workflow as `get_workflow` describes it, already read into the view's shape. */
export function workflowMemberFixture(overrides: Partial<WorkflowMember> = {}): WorkflowMember {
  return {
    key: '#1',
    taskId: 'task-1',
    displayId: 1,
    projectId: 'project-1',
    board: null,
    title: 'Write the plan',
    columnName: 'Executing',
    place: 'working',
    waitsFor: [],
    ...overrides,
  };
}

/** A workflow's `get_workflow` read, already parsed into the view's shape. */
export function workflowDetailFixture(overrides: Partial<WorkflowDetail> = {}): WorkflowDetail {
  return {
    id: 'workflow-1',
    title: 'Ship the checkout',
    state: 'running',
    colorSlot: 2,
    homeProjectId: 'project-1',
    members: [],
    ...overrides,
  };
}
