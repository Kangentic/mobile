/**
 * The mock desktop's `paused_by` (protocol 0.29.0) on a move into Done, driven
 * through a REAL ChannelController over the loopback, the stack the shipped demo
 * pairing and `dev:mock` run.
 *
 * Moving a task into Done suspends a live agent and archives the row. Who paused
 * it must survive that move:
 *
 *  - an idle-paused task keeps `idle` (a suspend that names nobody keeps who
 *    paused first), and
 *  - a task with a live agent reads `system`, the desktop's own pause.
 *
 * The archived row leaves the board snapshot, so it is read back through the
 * `archived` read-board action.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChannelController } from '@/channel';
import { createMockDesktop, MOCK_IDLE_STATIC_SESSION, type MockDesktop } from '@/connection/mockDesktop';
import { waitUntil } from '../helpers/async';

const MOCK_PROJECT_ID = 'mock-project';
const MOCK_PROJECT_2_ID = 'mock-project-relay';
const IDLE_PAUSED_TASK_ID = 'mock-task-paused';
const MOCK_PROJECT_DONE_COLUMN_ID = 'lane-done';
const MOCK_PROJECT_2_DONE_COLUMN_ID = 'lane2-shipped';

let mockDesktop: MockDesktop;
let controller: ChannelController;

beforeEach(async () => {
  mockDesktop = createMockDesktop();
  controller = new ChannelController({
    identity: mockDesktop.identity,
    desktopStaticPublicKey: mockDesktop.desktopStaticPublicKey,
    relayUrl: 'loopback://paused-by-done-move-test',
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

describe('mock desktop paused_by on a move into Done', () => {
  it('keeps `idle` on an idle-paused task moved into Done', async () => {
    const board = await controller.verbs.readBoardSubscribe(MOCK_PROJECT_ID, { view: 'full' });
    const pausedTask = board.tasks.find((task) => task.id === IDLE_PAUSED_TASK_ID);
    // Non-vacuity: the row starts idle-paused, so `idle` below is what the move preserved.
    expect(pausedTask?.paused_by).toBe('idle');

    const moved = await controller.verbs.moveTask({
      projectId: MOCK_PROJECT_ID,
      taskId: IDLE_PAUSED_TASK_ID,
      targetSwimlaneId: MOCK_PROJECT_DONE_COLUMN_ID,
      targetPosition: 0,
    });
    expect(moved.ok).toBe(true);

    const archivedPage = await controller.verbs.readBoardArchived(MOCK_PROJECT_ID, {});
    const archivedTask = archivedPage.archivedTasks.find((task) => task.id === IDLE_PAUSED_TASK_ID);
    expect(archivedTask?.paused_by).toBe('idle');
  });

  it('reads `system` on a task with a live agent moved into Done', async () => {
    const liveTaskId = MOCK_IDLE_STATIC_SESSION.taskId;
    const board = await controller.verbs.readBoardSubscribe(MOCK_PROJECT_2_ID, { view: 'full' });
    const liveTask = board.tasks.find((task) => task.id === liveTaskId);
    // Non-vacuity: a live agent and nobody named as the pauser, so `system` below is the move's doing.
    expect(liveTask?.session_id).not.toBeNull();
    expect(liveTask?.paused_by ?? null).toBeNull();

    const moved = await controller.verbs.moveTask({
      projectId: MOCK_PROJECT_2_ID,
      taskId: liveTaskId,
      targetSwimlaneId: MOCK_PROJECT_2_DONE_COLUMN_ID,
      targetPosition: 0,
    });
    expect(moved.ok).toBe(true);

    const archivedPage = await controller.verbs.readBoardArchived(MOCK_PROJECT_2_ID, {});
    const archivedTask = archivedPage.archivedTasks.find((task) => task.id === liveTaskId);
    expect(archivedTask?.paused_by).toBe('system');
  });
});
