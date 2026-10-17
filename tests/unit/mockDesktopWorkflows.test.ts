/**
 * The mock desktop's workflows (protocol 0.21.0), driven through a REAL
 * ChannelController over the loopback - the stack `dev:mock` and the shipped
 * demo pairing run. The expectations come from the desktop's contract
 * (workflow-wire.ts, workflow-lock.ts, the workflow board tools), not from
 * reading the mock back:
 *
 *  - a board row carries `workflow`, with a lock sentence only while the
 *    workflow runs and the card is not in a human gate;
 *  - `list_workflows` answers per project, and storefront-web (the project the
 *    store screenshots photograph) has none, so its Board grows no button;
 *  - `get_workflow` reads into the phone's view, a draft's tasks planned;
 *  - pausing and resuming answer with no result, as the desktop's do, flip the
 *    rows, and refuse in the desktop's words when there is nothing to do.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardTaskWire } from '@kangentic/protocol';
import { CapabilityError, ChannelController } from '@/channel';
import { createMockDesktop, type MockDesktop } from '@/connection/mockDesktop';
import { parseWorkflowDetail, parseWorkflowList } from '@/workflow/workflowView';
import { waitUntil } from '../helpers/async';

const MOCK_PROJECT_ID = 'mock-project';
const MOCK_PROJECT_2_ID = 'mock-project-relay';

let mockDesktop: MockDesktop;
let controller: ChannelController;

beforeEach(async () => {
  mockDesktop = createMockDesktop();
  controller = new ChannelController({
    identity: mockDesktop.identity,
    desktopStaticPublicKey: mockDesktop.desktopStaticPublicKey,
    relayUrl: 'loopback://workflow-test',
    transport: mockDesktop.phoneTransport,
  });
  await controller.connect();
  await mockDesktop.start();
  await waitUntil(() => controller.session.isEstablished, { label: 'loopback session establishes' });
});

afterEach(() => {
  controller.dispose();
  mockDesktop.dispose();
});

async function boardRows(projectId: string): Promise<BoardTaskWire[]> {
  const snapshot = await controller.verbs.readBoardSubscribe(projectId, { view: 'full' });
  if (!('tasks' in snapshot)) throw new Error('expected a board snapshot');
  return snapshot.tasks;
}

function rowById(rows: readonly BoardTaskWire[], taskId: string): BoardTaskWire {
  const row = rows.find((candidate) => candidate.id === taskId);
  if (!row) throw new Error(`no row ${taskId}`);
  return row;
}

describe('mock desktop workflows', () => {
  it('lists no workflows on storefront-web, so the photographed Board has no Workflows button', async () => {
    const result = await controller.verbs.boardToolRead('list_workflows', { project: MOCK_PROJECT_ID });
    expect(parseWorkflowList(result)).toEqual([]);
  });

  it('lists a running, a paused and a not-started workflow on checkout-api', async () => {
    const result = await controller.verbs.boardToolRead('list_workflows', { project: MOCK_PROJECT_2_ID });
    expect(parseWorkflowList(result).map((entry) => entry.state)).toEqual(['running', 'paused', 'draft']);
  });

  it('carries no workflow on storefront-web rows and a workflow on checkout-api workflow rows', async () => {
    expect((await boardRows(MOCK_PROJECT_ID)).every((row) => (row.workflow ?? null) === null)).toBe(true);
    const rows = await boardRows(MOCK_PROJECT_2_ID);
    expect(rowById(rows, 'mock-task-wf-retry').workflow?.title).toBe('Checkout hardening');
  });

  it('locks a running card outside a gate and opens only the gate target inside one', async () => {
    const rows = await boardRows(MOCK_PROJECT_2_ID);
    const locked = rowById(rows, 'mock-task-wf-retry').workflow;
    expect(locked?.lock_reason).toBe('#6 is locked while Checkout hardening runs.');
    expect(locked?.gate_target_id).toBeNull();
    const gated = rowById(rows, 'mock-task-wf-refunds').workflow;
    expect(gated?.lock_reason).toBeNull();
    expect(gated?.gate_target_id).toBe('lane2-merge');
  });

  it('names only the unfinished tasks a card waits for', async () => {
    const rows = await boardRows(MOCK_PROJECT_2_ID);
    expect(rowById(rows, 'mock-task-wf-retry').workflow?.waiting_for).toEqual([]);
    expect(rowById(rows, 'mock-task-wf-runbook').workflow?.waiting_for).toEqual(['#6', '#7']);
  });

  it("reads a running workflow's tasks, its finished one included, and a draft's as planned", async () => {
    const running = parseWorkflowDetail(
      await controller.verbs.boardToolRead('get_workflow', { project: MOCK_PROJECT_2_ID, workflow: 'mock-workflow-hardening' }),
      MOCK_PROJECT_2_ID,
    );
    expect(running?.members.map((member) => member.place)).toEqual(['done', 'working', 'working', 'todo', 'todo', 'todo']);
    const draft = parseWorkflowDetail(
      await controller.verbs.boardToolRead('get_workflow', { project: MOCK_PROJECT_2_ID, workflow: 'mock-workflow-gift-cards' }),
      MOCK_PROJECT_2_ID,
    );
    expect(draft?.state).toBe('draft');
    expect(draft?.members.every((member) => member.place === 'planned' && member.displayId === null)).toBe(true);
  });

  it('pauses with no result, which the rows then show, and refuses a second pause in the desktop words', async () => {
    await expect(
      controller.verbs.boardToolWrite('pause_workflow', { project: MOCK_PROJECT_2_ID, workflow: 'mock-workflow-hardening' }),
    ).resolves.toBeNull();
    const rows = await boardRows(MOCK_PROJECT_2_ID);
    expect(rowById(rows, 'mock-task-wf-retry').workflow?.state).toBe('paused');
    expect(rowById(rows, 'mock-task-wf-retry').workflow?.lock_reason).toBeNull();
    await expect(
      controller.verbs.boardToolWrite('pause_workflow', { project: MOCK_PROJECT_2_ID, workflow: 'mock-workflow-hardening' }),
    ).rejects.toThrow(new CapabilityError('board-tool-write', '"Checkout hardening" is paused, so there is nothing to pause.'));
  });

  it('resumes a paused workflow and refuses to resume a running one', async () => {
    await expect(
      controller.verbs.boardToolWrite('resume_workflow', { project: MOCK_PROJECT_2_ID, workflow: 'mock-workflow-pricing' }),
    ).resolves.toBeNull();
    await expect(
      controller.verbs.boardToolWrite('resume_workflow', { project: MOCK_PROJECT_2_ID, workflow: 'mock-workflow-pricing' }),
    ).rejects.toBeInstanceOf(CapabilityError);
  });
});
