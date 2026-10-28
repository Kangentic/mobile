/**
 * The mock desktop's column automations switch (protocol 0.22.0), driven
 * through a REAL ChannelController over the loopback - the stack `dev:mock`
 * and the shipped demo pairing run. The expectations come from the desktop's
 * contract (payloads.ts `automations_disabled`, task-commands.ts
 * `handleUpdateTask`), not from reading the mock back:
 *
 *  - every row carries a boolean, and one storefront-web card starts held, so
 *    `dev:mock` shows both states;
 *  - `update_task`'s camelCase `automationsDisabled` flips it, and the change
 *    reaches the next read;
 *  - a workflow task takes it too (protocol 0.25.0, kangentic #923, payloads.ts
 *    `automations_pausable`, workflow-wire.ts): a held card loses its lock and
 *    its gate, and every workflow row says the desktop honours the hold;
 *  - a value that is not a boolean is refused before anything moves.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BoardTaskWire } from '@kangentic/protocol';
import { CapabilityError, ChannelController } from '@/channel';
import { createMockDesktop, type MockDesktop } from '@/connection/mockDesktop';
import { waitUntil } from '../helpers/async';

const MOCK_PROJECT_ID = 'mock-project';
const MOCK_PROJECT_2_ID = 'mock-project-relay';
const HELD_TASK_ID = 'mock-task-merge-1';
const ORDINARY_TASK_ID = 'mock-task-merge-2';
/** #6, in Executing while Checkout hardening runs: locked until held. */
const WORKFLOW_TASK_ID = 'mock-task-wf-retry';
/** #8, in To Do: the workflow card that starts held. */
const HELD_WORKFLOW_TASK_ID = 'mock-task-wf-soak';

let mockDesktop: MockDesktop;
let controller: ChannelController;

beforeEach(async () => {
  mockDesktop = createMockDesktop();
  controller = new ChannelController({
    identity: mockDesktop.identity,
    desktopStaticPublicKey: mockDesktop.desktopStaticPublicKey,
    relayUrl: 'loopback://automations-test',
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

async function automationsDisabledOf(projectId: string, taskId: string): Promise<boolean | null | undefined> {
  const row = (await boardRows(projectId)).find((candidate) => candidate.id === taskId);
  if (!row) throw new Error(`no row ${taskId}`);
  return row.automations_disabled;
}

async function refusalOf(write: Promise<unknown>): Promise<CapabilityError> {
  try {
    await write;
  } catch (error) {
    if (error instanceof CapabilityError) return error;
    throw error;
  }
  throw new Error('expected the desktop to refuse');
}

describe('mock desktop automations switch', () => {
  it('sends a boolean on every row, with one held card on storefront-web', async () => {
    const rows = [...(await boardRows(MOCK_PROJECT_ID)), ...(await boardRows(MOCK_PROJECT_2_ID))];
    expect(rows.every((row) => typeof row.automations_disabled === 'boolean')).toBe(true);
    expect(await automationsDisabledOf(MOCK_PROJECT_ID, HELD_TASK_ID)).toBe(true);
    expect(await automationsDisabledOf(MOCK_PROJECT_ID, ORDINARY_TASK_ID)).toBe(false);
  });

  it('holds and releases a task through update_task, and the next read carries it', async () => {
    await controller.verbs.boardToolWrite('update_task', { project: MOCK_PROJECT_ID, taskId: ORDINARY_TASK_ID, automationsDisabled: true });
    expect(await automationsDisabledOf(MOCK_PROJECT_ID, ORDINARY_TASK_ID)).toBe(true);

    await controller.verbs.boardToolWrite('update_task', { project: MOCK_PROJECT_ID, taskId: HELD_TASK_ID, automationsDisabled: false });
    expect(await automationsDisabledOf(MOCK_PROJECT_ID, HELD_TASK_ID)).toBe(false);
  });

  it('says on every workflow row that this desktop honours the hold', async () => {
    const workflowRows = (await boardRows(MOCK_PROJECT_2_ID)).filter((row) => (row.workflow ?? null) !== null);
    expect(workflowRows.length).toBeGreaterThan(0);
    expect(workflowRows.every((row) => row.workflow?.automations_pausable === true)).toBe(true);
  });

  it('starts one checkout-api workflow card held, with no lock', async () => {
    const row = (await boardRows(MOCK_PROJECT_2_ID)).find((candidate) => candidate.id === HELD_WORKFLOW_TASK_ID);
    expect(row?.automations_disabled).toBe(true);
    expect(row?.workflow?.state).toBe('running');
    expect(row?.workflow?.lock_reason).toBeNull();
    expect(row?.workflow?.gate_target_id).toBeNull();
  });

  /**
   * The desktop's workflow-wire.ts: a held card of a running workflow is the
   * person's to move, so its lock sentence goes, and comes back on release.
   * Mutation seen failing: dropping `!held` from mockWorkflowWire's lock_reason
   * kept the sentence on the held row.
   */
  it('holds a workflow task, which drops its lock, and releases it, which brings the lock back', async () => {
    const lockOf = async (): Promise<string | null | undefined> =>
      (await boardRows(MOCK_PROJECT_2_ID)).find((candidate) => candidate.id === WORKFLOW_TASK_ID)?.workflow?.lock_reason;
    expect(await lockOf()).toBe('#6 is locked while Checkout hardening runs.');

    await controller.verbs.boardToolWrite('update_task', { project: MOCK_PROJECT_2_ID, taskId: WORKFLOW_TASK_ID, automationsDisabled: true });
    expect(await automationsDisabledOf(MOCK_PROJECT_2_ID, WORKFLOW_TASK_ID)).toBe(true);
    expect(await lockOf()).toBeNull();

    await controller.verbs.boardToolWrite('update_task', { project: MOCK_PROJECT_2_ID, taskId: WORKFLOW_TASK_ID, automationsDisabled: false });
    expect(await automationsDisabledOf(MOCK_PROJECT_2_ID, WORKFLOW_TASK_ID)).toBe(false);
    expect(await lockOf()).toBe('#6 is locked while Checkout hardening runs.');
  });

  /** workflow-view-service.ts `humanGateExit`: no gate for a held card, which a hand may move anywhere but To Do. */
  it('drops the human gate from a held card waiting in one', async () => {
    const gateOf = async (): Promise<string | null | undefined> =>
      (await boardRows(MOCK_PROJECT_2_ID)).find((candidate) => candidate.id === 'mock-task-wf-refunds')?.workflow?.gate_target_id;
    expect(await gateOf()).toBe('lane2-merge');

    await controller.verbs.boardToolWrite('update_task', { project: MOCK_PROJECT_2_ID, taskId: 'mock-task-wf-refunds', automationsDisabled: true });
    expect(await gateOf()).toBeNull();
  });

  it('refuses a value that is not a boolean, so a truthy string cannot hold a task', async () => {
    const refusal = await refusalOf(
      controller.verbs.boardToolWrite('update_task', { project: MOCK_PROJECT_ID, taskId: ORDINARY_TASK_ID, automationsDisabled: 'yes' }),
    );
    expect(refusal.message).toBe('automationsDisabled must be true or false.');
    expect(await automationsDisabledOf(MOCK_PROJECT_ID, ORDINARY_TASK_ID)).toBe(false);
  });

  // The desktop's handleUpdateTask validates the param before it looks the task
  // up, so a bad value is named as a bad value even for a task id that is not
  // on any board. Looking the task up first would answer 'No such task' instead.
  it('refuses a value that is not a boolean before it looks the task up', async () => {
    const refusal = await refusalOf(
      controller.verbs.boardToolWrite('update_task', { project: MOCK_PROJECT_ID, taskId: 'mock-task-does-not-exist', automationsDisabled: 'yes' }),
    );
    expect(refusal.message).toBe('automationsDisabled must be true or false.');
  });

  // An explicit null reads as omitted on the desktop: a no-op, not a refusal.
  it('accepts a null automationsDisabled as omitted and leaves the row as it was', async () => {
    await controller.verbs.boardToolWrite('update_task', { project: MOCK_PROJECT_ID, taskId: HELD_TASK_ID, automationsDisabled: null });
    expect(await automationsDisabledOf(MOCK_PROJECT_ID, HELD_TASK_ID)).toBe(true);
  });
});
