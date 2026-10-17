import { CapabilityError, CapabilityTimeoutError } from '@/channel';
import { useWorkflowStore } from '@/state/workflowStore';
import { parseWorkflowDetail, parseWorkflowList } from '@/workflow/workflowView';
import { DESKTOP_REFUSAL_MESSAGE_MAX_LENGTH, refreshSnapshots } from './actions';
import { requireVerbClient } from './connectionManager';

/**
 * The workflow reads and controls screens call (protocol 0.21.0's board tools).
 * Each read lands in `useWorkflowStore`; a failed read marks the read failed and
 * keeps the last good one, so a screen shows what it had plus a retry.
 *
 * Every tool is sent to the workflow's HOME project (`project`), which is where
 * the desktop keeps the workflow even when its tasks sit on other boards.
 */

/** The desktop's own lines for a Pause or Resume that failed without a sentence of its own (WorkflowsView). */
export const WORKFLOW_PAUSE_FAILED_MESSAGE = 'Could not pause the workflow';
export const WORKFLOW_RESUME_FAILED_MESSAGE = 'Could not resume the workflow';

/**
 * One read per key at a time. A request that arrives while the same read is in
 * flight runs once more after it, so the newest state is always read without
 * stacking a request per board event.
 */
const readsInFlight = new Map<string, { rerun: boolean }>();

async function coalesced(key: string, read: () => Promise<void>): Promise<void> {
  const inFlight = readsInFlight.get(key);
  if (inFlight) {
    inFlight.rerun = true;
    return;
  }
  const marker = { rerun: false };
  readsInFlight.set(key, marker);
  try {
    do {
      marker.rerun = false;
      await read();
    } while (marker.rerun);
  } finally {
    readsInFlight.delete(key);
  }
}

/** A project's unfinished workflows (`list_workflows`), drafts included. */
export function fetchProjectWorkflows(projectId: string): Promise<void> {
  return coalesced(`list:${projectId}`, async () => {
    useWorkflowStore.getState().markListLoading(projectId);
    try {
      const result = await requireVerbClient().boardToolRead('list_workflows', { project: projectId });
      useWorkflowStore.getState().setList(projectId, parseWorkflowList(result));
    } catch {
      // A desktop that predates workflows refuses the tool, and a narrowed
      // grant refuses the verb: either way the project shows no workflows.
      useWorkflowStore.getState().markListFailed(projectId);
    }
  });
}

/** One workflow's tasks, routes and links (`get_workflow`), asked of its home project. */
export function fetchWorkflowDetail(homeProjectId: string, workflowId: string): Promise<void> {
  return coalesced(`detail:${workflowId}`, async () => {
    useWorkflowStore.getState().markDetailLoading(workflowId);
    try {
      const result = await requireVerbClient().boardToolRead('get_workflow', { project: homeProjectId, workflow: workflowId });
      const detail = parseWorkflowDetail(result, homeProjectId);
      if (detail === null) useWorkflowStore.getState().markDetailFailed(workflowId);
      else useWorkflowStore.getState().setDetail(workflowId, detail);
    } catch {
      useWorkflowStore.getState().markDetailFailed(workflowId);
    }
  });
}

export type WorkflowControl = 'pause' | 'resume';

/**
 * The workflow view's one Pause or Resume (design screen 7): stops or starts
 * every task of the workflow at once, as the desktop's header does, with no
 * confirmation. The desktop answers with no data, so success is read from what
 * follows: the board rows' `workflow.state` and a re-read of the workflow.
 *
 * A refusal keeps the desktop's own sentence (capped, it is peer text) for the
 * line under the header; any other failure gets the desktop's own fallback
 * line. A timeout says nothing: the desktop may still have applied it, and the
 * re-reads below will show whether it did.
 */
export async function controlWorkflow(control: WorkflowControl, homeProjectId: string, workflowId: string): Promise<void> {
  const store = useWorkflowStore.getState();
  if (store.controlsById[workflowId] !== undefined) return;
  store.beginControl(workflowId, control === 'pause' ? 'pausing' : 'resuming');
  let failure: string | null = null;
  try {
    await requireVerbClient().boardToolWrite(control === 'pause' ? 'pause_workflow' : 'resume_workflow', {
      project: homeProjectId,
      workflow: workflowId,
    });
  } catch (error) {
    const fallback = control === 'pause' ? WORKFLOW_PAUSE_FAILED_MESSAGE : WORKFLOW_RESUME_FAILED_MESSAGE;
    if (error instanceof CapabilityTimeoutError) failure = null;
    else if (error instanceof CapabilityError) {
      const refusalText = error.message.trim().slice(0, DESKTOP_REFUSAL_MESSAGE_MAX_LENGTH);
      failure = refusalText.length > 0 ? refusalText : fallback;
    } else failure = fallback;
  } finally {
    useWorkflowStore.getState().endControl(workflowId, failure);
    void refreshSnapshots().catch(() => undefined);
    void fetchWorkflowDetail(homeProjectId, workflowId);
    void fetchProjectWorkflows(homeProjectId);
  }
}
