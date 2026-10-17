import { create } from 'zustand';
import type { WorkflowDetail, WorkflowListEntry } from '@/workflow/workflowView';

/**
 * What the phone has read of a project's workflows (protocol 0.21.0's
 * `list_workflows` and `get_workflow` board tools), and a Pause or Resume in
 * flight.
 *
 * The board rows say which workflow each task belongs to; only these reads say
 * which workflows a project has (a draft has no row on any board) and which
 * tasks a workflow holds across boards, in what order. Held outside any screen
 * because the Board header's Workflows button, the Workflows sheet and the
 * workflow view all draw from the same reads. In memory only, like every other
 * desktop read, and cleared with them on unpair.
 */

export type WorkflowReadStatus = 'loading' | 'ready' | 'failed';

export interface ProjectWorkflowList {
  status: WorkflowReadStatus;
  /** The last list read; kept while a re-read is in flight, so nothing flickers. */
  entries: WorkflowListEntry[];
}

export interface WorkflowDetailRead {
  status: WorkflowReadStatus;
  /** The last detail read; kept while a re-read is in flight. */
  detail: WorkflowDetail | null;
}

export type WorkflowControlPhase = 'pausing' | 'resuming';

interface WorkflowStoreState {
  listsByProjectId: Record<string, ProjectWorkflowList>;
  detailsById: Record<string, WorkflowDetailRead>;
  controlsById: Record<string, WorkflowControlPhase>;
  /** The line a refused Pause or Resume shows under the view's header, until the next attempt. */
  controlFailuresById: Record<string, string>;
  markListLoading: (projectId: string) => void;
  setList: (projectId: string, entries: WorkflowListEntry[]) => void;
  markListFailed: (projectId: string) => void;
  markDetailLoading: (workflowId: string) => void;
  setDetail: (workflowId: string, detail: WorkflowDetail) => void;
  markDetailFailed: (workflowId: string) => void;
  beginControl: (workflowId: string, phase: WorkflowControlPhase) => void;
  endControl: (workflowId: string, failure: string | null) => void;
  reset: () => void;
}

export const useWorkflowStore = create<WorkflowStoreState>((set) => ({
  listsByProjectId: {},
  detailsById: {},
  controlsById: {},
  controlFailuresById: {},

  markListLoading: (projectId) =>
    set((state) => ({
      listsByProjectId: {
        ...state.listsByProjectId,
        [projectId]: { status: 'loading', entries: state.listsByProjectId[projectId]?.entries ?? [] },
      },
    })),

  setList: (projectId, entries) =>
    set((state) => ({ listsByProjectId: { ...state.listsByProjectId, [projectId]: { status: 'ready', entries } } })),

  markListFailed: (projectId) =>
    set((state) => ({
      listsByProjectId: {
        ...state.listsByProjectId,
        [projectId]: { status: 'failed', entries: state.listsByProjectId[projectId]?.entries ?? [] },
      },
    })),

  markDetailLoading: (workflowId) =>
    set((state) => ({
      detailsById: {
        ...state.detailsById,
        [workflowId]: { status: 'loading', detail: state.detailsById[workflowId]?.detail ?? null },
      },
    })),

  setDetail: (workflowId, detail) =>
    set((state) => ({ detailsById: { ...state.detailsById, [workflowId]: { status: 'ready', detail } } })),

  markDetailFailed: (workflowId) =>
    set((state) => ({
      detailsById: {
        ...state.detailsById,
        [workflowId]: { status: 'failed', detail: state.detailsById[workflowId]?.detail ?? null },
      },
    })),

  beginControl: (workflowId, phase) =>
    set((state) => {
      const controlFailuresById = { ...state.controlFailuresById };
      delete controlFailuresById[workflowId];
      return { controlsById: { ...state.controlsById, [workflowId]: phase }, controlFailuresById };
    }),

  endControl: (workflowId, failure) =>
    set((state) => {
      const controlsById = { ...state.controlsById };
      delete controlsById[workflowId];
      const controlFailuresById = { ...state.controlFailuresById };
      if (failure === null) delete controlFailuresById[workflowId];
      else controlFailuresById[workflowId] = failure;
      return { controlsById, controlFailuresById };
    }),

  reset: () => set({ listsByProjectId: {}, detailsById: {}, controlsById: {}, controlFailuresById: {} }),
}));

const NO_WORKFLOWS: readonly WorkflowListEntry[] = [];

/** A project's unfinished workflows as last read; a stable empty value before the first read. */
export function selectProjectWorkflows(
  state: Pick<WorkflowStoreState, 'listsByProjectId'>,
  projectId: string | null,
): readonly WorkflowListEntry[] {
  if (projectId === null) return NO_WORKFLOWS;
  return state.listsByProjectId[projectId]?.entries ?? NO_WORKFLOWS;
}

/** A workflow's last detail read, or null. The stored object, so safe as a selector. */
export function selectWorkflowDetailRead(
  state: Pick<WorkflowStoreState, 'detailsById'>,
  workflowId: string | null,
): WorkflowDetailRead | null {
  if (workflowId === null) return null;
  return state.detailsById[workflowId] ?? null;
}
