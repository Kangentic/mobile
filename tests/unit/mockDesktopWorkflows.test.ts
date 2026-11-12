/**
 * The mock desktop's workflows (protocol 0.21.0), driven through a REAL
 * ChannelController over the loopback - the stack `dev:mock` and the shipped
 * demo pairing run. The expectations come from the desktop's contract
 * (workflow-wire.ts, workflow-lock.ts, the workflow board tools), not from
 * reading the mock back:
 *
 *  - a board row carries `workflow`, with a lock sentence only while the
 *    workflow runs and the card is in motion, and for a stopped card the next
 *    column on its route instead;
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

  /**
   * The v0.55.0 desktop's workflow-wire.ts: a card in motion carries the lock
   * sentence and names no column; a stopped one carries no lock and names the
   * next column on its route (`nextOnRoute`), and a hand may take it anywhere
   * but To Do.
   */
  it('locks a running card in motion, and names the next column on its route for a stopped one', async () => {
    const rows = await boardRows(MOCK_PROJECT_2_ID);
    const locked = rowById(rows, 'mock-task-wf-retry').workflow;
    expect(locked?.lock_reason).toBe('#6 is locked while Checkout hardening runs.');
    expect(locked?.gate_target_id).toBeNull();
    const stopped = rowById(rows, 'mock-task-wf-refunds').workflow;
    expect(stopped?.lock_reason).toBeNull();
    expect(stopped?.gate_target_id).toBe('lane2-merge');
  });

  /**
   * The route carries on from wherever a hand put the card (`nextOnRoute` works
   * from any column, on the route or not). Mutation seen failing:
   * `mockNextOnRoute` stepping to the column after the card's ROUTE index
   * instead of its board position fell through to Done from Code Review, which
   * is off this card's route ("expected 'lane2-shipped' to be
   * 'lane2-testing'").
   */
  it('names the next route column from wherever a hand moved the stopped card', async () => {
    await controller.verbs.moveTask({ projectId: MOCK_PROJECT_2_ID, taskId: 'mock-task-wf-refunds', targetSwimlaneId: 'lane2-code-review', targetPosition: 0 });
    expect(rowById(await boardRows(MOCK_PROJECT_2_ID), 'mock-task-wf-refunds').workflow?.gate_target_id).toBe('lane2-testing');

    await controller.verbs.moveTask({ projectId: MOCK_PROJECT_2_ID, taskId: 'mock-task-wf-refunds', targetSwimlaneId: 'lane2-merge', targetPosition: 0 });
    // Nothing on its route after Merge, so Done.
    expect(rowById(await boardRows(MOCK_PROJECT_2_ID), 'mock-task-wf-refunds').workflow?.gate_target_id).toBe('lane2-shipped');
  });

  /**
   * The desktop's `isWorkflowTaskStopped`: a card is never stopped in To Do, so
   * there it carries the lock sentence again and names no column. The Done half
   * is not observable over the wire: a move into Done archives the task and it
   * leaves the board projection.
   * Mutation seen failing: dropping `!isTodoRole(columnRole)` from `stopped`.
   */
  it('locks the stopped card again once a hand moves it into To Do', async () => {
    await controller.verbs.moveTask({ projectId: MOCK_PROJECT_2_ID, taskId: 'mock-task-wf-refunds', targetSwimlaneId: 'lane2-backlog', targetPosition: 0 });
    const workflow = rowById(await boardRows(MOCK_PROJECT_2_ID), 'mock-task-wf-refunds').workflow;
    expect(workflow?.lock_reason).toBe('#7 is locked while Checkout hardening runs.');
    expect(workflow?.gate_target_id).toBeNull();
  });

  /**
   * Only a RUNNING workflow's stopped card names a next column: a paused
   * workflow gates nothing, so the card reads neither lock nor gate.
   * Mutation seen failing: dropping `state === 'running' &&` from `stopped`.
   */
  it('names no next column for a stopped card once its workflow is paused', async () => {
    await controller.verbs.boardToolWrite('pause_workflow', { project: MOCK_PROJECT_2_ID, workflow: 'mock-workflow-hardening' });
    const workflow = rowById(await boardRows(MOCK_PROJECT_2_ID), 'mock-task-wf-refunds').workflow;
    expect(workflow?.state).toBe('paused');
    expect(workflow?.gate_target_id).toBeNull();
    expect(workflow?.lock_reason).toBeNull();
  });

  it('says on every running or paused workflow row that the task cannot pause its automations', async () => {
    const workflowRows = (await boardRows(MOCK_PROJECT_2_ID)).filter((row) => (row.workflow ?? null) !== null);
    expect(workflowRows.length).toBeGreaterThan(0);
    expect(workflowRows.every((row) => row.workflow?.automations_pausable === false)).toBe(true);
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
