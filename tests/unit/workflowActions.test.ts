/**
 * The workflow reads and the one Pause or Resume (protocol 0.21.0, task #116).
 * The verb client is faked at the connection manager, so these pin what the
 * actions send and what they leave in the store, not the wire.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@kangentic/protocol';
import { CapabilityError, CapabilityTimeoutError } from '@/channel';
import { useWorkflowStore } from '@/state/workflowStore';

const boardToolRead = vi.fn<(tool: string, params: JsonValue) => Promise<JsonValue>>();
const boardToolWrite = vi.fn<(tool: string, params: JsonValue) => Promise<JsonValue>>();
const refreshSnapshots = vi.fn(async () => undefined);

vi.mock('@/connection/connectionManager', () => ({
  requireVerbClient: () => ({ boardToolRead, boardToolWrite }),
}));
vi.mock('@/connection/actions', () => ({
  DESKTOP_REFUSAL_MESSAGE_MAX_LENGTH: 160,
  refreshSnapshots: () => refreshSnapshots(),
}));

const { controlWorkflow, fetchProjectWorkflows, fetchWorkflowDetail, WORKFLOW_PAUSE_FAILED_MESSAGE, WORKFLOW_RESUME_FAILED_MESSAGE } = await import(
  '@/connection/workflowActions'
);

const DETAIL: JsonValue = { workflow: { id: 'workflow-1', title: 'Checkout hardening', state: 'running', color_slot: 5 }, homeProjectId: 'project-1', tasks: [] };

beforeEach(() => {
  vi.clearAllMocks();
  useWorkflowStore.getState().reset();
  boardToolRead.mockImplementation(async (tool) => (tool === 'list_workflows' ? [{ id: 'workflow-1', title: 'Checkout hardening', state: 'running' }] : DETAIL));
  boardToolWrite.mockResolvedValue(null);
});

describe('fetchProjectWorkflows', () => {
  it("asks the project and keeps its list", async () => {
    await fetchProjectWorkflows('project-1');
    expect(boardToolRead).toHaveBeenCalledWith('list_workflows', { project: 'project-1' });
    expect(useWorkflowStore.getState().listsByProjectId['project-1']).toEqual({
      status: 'ready',
      entries: [{ id: 'workflow-1', title: 'Checkout hardening', state: 'running' }],
    });
  });

  it('marks a refused read failed and keeps what it had, so a desktop without workflows shows none', async () => {
    await fetchProjectWorkflows('project-1');
    boardToolRead.mockRejectedValueOnce(new CapabilityError('board-tool-read', 'Tool not allowed for board-tool-read: list_workflows'));
    await fetchProjectWorkflows('project-1');
    const list = useWorkflowStore.getState().listsByProjectId['project-1'];
    expect(list?.status).toBe('failed');
    expect(list?.entries).toHaveLength(1);
  });

  it('runs a read asked for while one is in flight once more after it, never alongside', async () => {
    let releaseFirst: () => void = () => undefined;
    boardToolRead.mockImplementationOnce(
      () =>
        new Promise<JsonValue>((resolve) => {
          releaseFirst = () => resolve([]);
        }),
    );
    const first = fetchProjectWorkflows('project-1');
    await fetchProjectWorkflows('project-1');
    await fetchProjectWorkflows('project-1');
    expect(boardToolRead).toHaveBeenCalledTimes(1);
    releaseFirst();
    await first;
    expect(boardToolRead).toHaveBeenCalledTimes(2);
  });
});

describe('fetchWorkflowDetail', () => {
  it("asks the workflow's home and keeps the read", async () => {
    await fetchWorkflowDetail('project-1', 'workflow-1');
    expect(boardToolRead).toHaveBeenCalledWith('get_workflow', { project: 'project-1', workflow: 'workflow-1' });
    expect(useWorkflowStore.getState().detailsById['workflow-1']?.detail?.title).toBe('Checkout hardening');
  });

  it('marks an unreadable answer failed', async () => {
    boardToolRead.mockResolvedValueOnce({ note: 'get_workflow completed.' });
    await fetchWorkflowDetail('project-1', 'workflow-1');
    expect(useWorkflowStore.getState().detailsById['workflow-1']?.status).toBe('failed');
  });
});

describe('controlWorkflow', () => {
  it('sends the tool to the home project and leaves no failure on success', async () => {
    await controlWorkflow('pause', 'project-1', 'workflow-1');
    expect(boardToolWrite).toHaveBeenCalledWith('pause_workflow', { project: 'project-1', workflow: 'workflow-1' });
    expect(useWorkflowStore.getState().controlFailuresById['workflow-1']).toBeUndefined();
    expect(useWorkflowStore.getState().controlsById['workflow-1']).toBeUndefined();
    expect(refreshSnapshots).toHaveBeenCalled();
  });

  it("keeps the desktop's own refusal sentence, capped", async () => {
    boardToolWrite.mockRejectedValueOnce(new CapabilityError('board-tool-write', `"Checkout hardening" is paused, not running. ${'x'.repeat(200)}`));
    await controlWorkflow('pause', 'project-1', 'workflow-1');
    const failure = useWorkflowStore.getState().controlFailuresById['workflow-1'] ?? '';
    expect(failure.startsWith('"Checkout hardening" is paused')).toBe(true);
    expect(failure.length).toBe(160);
  });

  it("falls back to the desktop's own line when nothing reached it", async () => {
    boardToolWrite.mockRejectedValueOnce(new Error('Not connected'));
    await controlWorkflow('resume', 'project-1', 'workflow-1');
    expect(useWorkflowStore.getState().controlFailuresById['workflow-1']).toBe(WORKFLOW_RESUME_FAILED_MESSAGE);
    boardToolWrite.mockRejectedValueOnce(new Error('Not connected'));
    await controlWorkflow('pause', 'project-1', 'workflow-1');
    expect(useWorkflowStore.getState().controlFailuresById['workflow-1']).toBe(WORKFLOW_PAUSE_FAILED_MESSAGE);
  });

  it('says nothing on a timeout, since the desktop may still have applied it', async () => {
    boardToolWrite.mockRejectedValueOnce(new CapabilityTimeoutError('board-tool-write'));
    await controlWorkflow('pause', 'project-1', 'workflow-1');
    expect(useWorkflowStore.getState().controlFailuresById['workflow-1']).toBeUndefined();
  });

  it('sends nothing while another control of the same workflow is in flight', async () => {
    useWorkflowStore.getState().beginControl('workflow-1', 'pausing');
    await controlWorkflow('pause', 'project-1', 'workflow-1');
    expect(boardToolWrite).not.toHaveBeenCalled();
  });
});
