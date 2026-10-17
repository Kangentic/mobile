/**
 * The workflow store (protocol 0.21.0, task #116): what survives a re-read, what a
 * new Pause or Resume attempt clears, and the selectors' stable values.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { selectProjectWorkflows, selectWorkflowDetailRead, useWorkflowStore } from '@/state/workflowStore';
import type { WorkflowDetail, WorkflowListEntry } from '@/workflow/workflowView';

const ENTRY: WorkflowListEntry = { id: 'workflow-1', title: 'Checkout hardening', state: 'running' };
const DETAIL: WorkflowDetail = {
  id: 'workflow-1',
  title: 'Checkout hardening',
  state: 'running',
  colorSlot: 5,
  homeProjectId: 'project-1',
  members: [],
};

beforeEach(() => {
  useWorkflowStore.getState().reset();
});

describe('workflow list reads', () => {
  it('keeps the last list while a re-read is loading or has failed, so nothing flickers', () => {
    const store = useWorkflowStore.getState();
    store.setList('project-1', [ENTRY]);
    store.markListLoading('project-1');
    expect(useWorkflowStore.getState().listsByProjectId['project-1']).toEqual({ status: 'loading', entries: [ENTRY] });
    store.markListFailed('project-1');
    expect(useWorkflowStore.getState().listsByProjectId['project-1']).toEqual({ status: 'failed', entries: [ENTRY] });
  });

  it('starts a never-read project with an empty list', () => {
    useWorkflowStore.getState().markListFailed('project-2');
    expect(useWorkflowStore.getState().listsByProjectId['project-2']).toEqual({ status: 'failed', entries: [] });
  });
});

describe('workflow detail reads', () => {
  it('keeps the last detail while a re-read is loading or has failed', () => {
    const store = useWorkflowStore.getState();
    store.setDetail('workflow-1', DETAIL);
    store.markDetailLoading('workflow-1');
    expect(useWorkflowStore.getState().detailsById['workflow-1']).toEqual({ status: 'loading', detail: DETAIL });
    store.markDetailFailed('workflow-1');
    expect(useWorkflowStore.getState().detailsById['workflow-1']).toEqual({ status: 'failed', detail: DETAIL });
  });

  it('starts a never-read workflow with no detail', () => {
    useWorkflowStore.getState().markDetailLoading('workflow-9');
    expect(useWorkflowStore.getState().detailsById['workflow-9']).toEqual({ status: 'loading', detail: null });
  });
});

describe('workflow controls', () => {
  it('clears the previous refusal line when a new attempt begins', () => {
    const store = useWorkflowStore.getState();
    store.beginControl('workflow-1', 'pausing');
    store.endControl('workflow-1', 'Could not pause the workflow');
    expect(useWorkflowStore.getState().controlFailuresById['workflow-1']).toBe('Could not pause the workflow');
    store.beginControl('workflow-1', 'resuming');
    expect(useWorkflowStore.getState().controlFailuresById['workflow-1']).toBeUndefined();
    expect(useWorkflowStore.getState().controlsById['workflow-1']).toBe('resuming');
  });

  it('ends an attempt, and a success clears any earlier refusal line', () => {
    const store = useWorkflowStore.getState();
    store.beginControl('workflow-1', 'pausing');
    store.endControl('workflow-1', 'refused');
    store.endControl('workflow-1', null);
    expect(useWorkflowStore.getState().controlsById['workflow-1']).toBeUndefined();
    expect(useWorkflowStore.getState().controlFailuresById['workflow-1']).toBeUndefined();
  });

  it("leaves another workflow's control and failure alone", () => {
    const store = useWorkflowStore.getState();
    store.beginControl('workflow-1', 'pausing');
    store.beginControl('workflow-2', 'resuming');
    store.endControl('workflow-2', 'refused');
    store.beginControl('workflow-1', 'pausing');
    expect(useWorkflowStore.getState().controlsById).toEqual({ 'workflow-1': 'pausing' });
    expect(useWorkflowStore.getState().controlFailuresById).toEqual({ 'workflow-2': 'refused' });
  });
});

describe('selectors', () => {
  it('returns the same empty list object for an unread project and for no project', () => {
    const state = useWorkflowStore.getState();
    expect(selectProjectWorkflows(state, 'project-1')).toBe(selectProjectWorkflows(state, null));
    expect(selectProjectWorkflows(state, 'project-1')).toEqual([]);
  });

  it('returns the stored entries and the stored detail read objects by identity', () => {
    useWorkflowStore.getState().setList('project-1', [ENTRY]);
    useWorkflowStore.getState().setDetail('workflow-1', DETAIL);
    const state = useWorkflowStore.getState();
    expect(selectProjectWorkflows(state, 'project-1')).toBe(state.listsByProjectId['project-1']?.entries);
    expect(selectWorkflowDetailRead(state, 'workflow-1')).toBe(state.detailsById['workflow-1']);
    expect(selectWorkflowDetailRead(state, 'workflow-9')).toBeNull();
    expect(selectWorkflowDetailRead(state, null)).toBeNull();
  });
});

describe('reset', () => {
  it('forgets every read and control', () => {
    const store = useWorkflowStore.getState();
    store.setList('project-1', [ENTRY]);
    store.setDetail('workflow-1', DETAIL);
    store.beginControl('workflow-1', 'pausing');
    store.endControl('workflow-1', 'refused');
    store.beginControl('workflow-2', 'pausing');
    store.reset();
    const state = useWorkflowStore.getState();
    expect(state.listsByProjectId).toEqual({});
    expect(state.detailsById).toEqual({});
    expect(state.controlsById).toEqual({});
    expect(state.controlFailuresById).toEqual({});
  });
});
