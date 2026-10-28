/**
 * The mock desktop's completed task records (task #130), driven through a
 * REAL ChannelController over the loopback, the stack `dev:mock` and the
 * shipped demo pairing run. The expectations are the desktop's contract
 * (`get_task_report` parses with the protocol's own guard, `find_task` caps its
 * knowledge at three commits and eight paths, an older desktop refuses the
 * report with no code), plus the one rule only the mock can break: a task's
 * report agrees with its own session summary, so the strip and the cards never
 * contradict each other.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { parseTaskReportWire, type SessionSummaryWire } from '@kangentic/protocol';
import { CapabilityError, ChannelController } from '@/channel';
import { createMockDesktop, type CreateMockDesktopOptions, type MockDesktop } from '@/connection/mockDesktop';
import { parseFindTaskKnowledge } from '@/taskReport/findTaskKnowledge';
import { waitUntil } from '../helpers/async';

const STOREFRONT = 'mock-project';
const CHECKOUT = 'mock-project-relay';

let mockDesktop: MockDesktop | null = null;
let controller: ChannelController | null = null;

async function connect(options: CreateMockDesktopOptions = {}): Promise<ChannelController> {
  mockDesktop = createMockDesktop(options);
  controller = new ChannelController({
    identity: mockDesktop.identity,
    desktopStaticPublicKey: mockDesktop.desktopStaticPublicKey,
    relayUrl: 'loopback://task-report-test',
    transport: mockDesktop.phoneTransport,
  });
  await controller.connect();
  await mockDesktop.start();
  const connected = controller;
  await waitUntil(() => connected.session.isEstablished, { label: 'loopback session establishes' });
  return connected;
}

afterEach(() => {
  controller?.dispose();
  mockDesktop?.dispose();
  controller = null;
  mockDesktop = null;
});

async function archivedSummaries(channel: ChannelController, projectId: string): Promise<Record<string, SessionSummaryWire>> {
  const page = await channel.verbs.readBoardArchived(projectId);
  return page.summariesByTaskId;
}

describe('mock desktop task reports', () => {
  it('answers a report for every archived row that parses with the protocol guard', async () => {
    const channel = await connect();
    for (const projectId of [STOREFRONT, CHECKOUT]) {
      for (const suffix of ['archived-1', 'archived-2']) {
        const taskId = `${projectId}-${suffix}`;
        const report = parseTaskReportWire(await channel.verbs.boardToolRead('get_task_report', { project: projectId, taskId }));
        expect(report.taskId).toBe(taskId);
        expect(report.route.length).toBeGreaterThan(0);
      }
    }
  });

  it("agrees with each task's own session summary on lines and files", async () => {
    const channel = await connect();
    for (const projectId of [STOREFRONT, CHECKOUT]) {
      const summaries = await archivedSummaries(channel, projectId);
      const taskId = `${projectId}-archived-1`;
      const summary = summaries[taskId];
      const report = parseTaskReportWire(await channel.verbs.boardToolRead('get_task_report', { project: projectId, taskId }));
      expect(report.changes?.totals).toEqual({ insertions: summary.linesAdded, deletions: summary.linesRemoved, filesChanged: summary.filesChanged });
      const files = report.changes?.files ?? [];
      expect(files.reduce((total, file) => total + file.insertions, 0)).toBe(summary.linesAdded);
      expect(files.reduce((total, file) => total + file.deletions, 0)).toBe(summary.linesRemoved);
      expect(files).toHaveLength(summary.filesChanged);
    }
  });

  it("spans each route inside the task's own start and end, ending when it was archived", async () => {
    const channel = await connect();
    const board = await channel.verbs.readBoardArchived(STOREFRONT);
    for (const task of board.archivedTasks) {
      const report = parseTaskReportWire(await channel.verbs.boardToolRead('get_task_report', { project: STOREFRONT, taskId: task.id }));
      expect(report.endedAt).toBe(task.archived_at);
      const routeMs = report.route.reduce((total, column) => total + column.totalMs, 0);
      expect(Date.parse(report.endedAt ?? '') - Date.parse(report.startedAt ?? '')).toBe(routeMs);
    }
  });

  it('gives the two tasks that ran no agent a route and no commits', async () => {
    const channel = await connect();
    for (const projectId of [STOREFRONT, CHECKOUT]) {
      const report = parseTaskReportWire(
        await channel.verbs.boardToolRead('get_task_report', { project: projectId, taskId: `${projectId}-archived-2` }),
      );
      expect(report.commits).toEqual([]);
      expect(report.changes?.emptyReason).toBe('no-commits');
    }
  });

  it('refuses the report with no code when it plays an older desktop, and still answers find_task', async () => {
    const channel = await connect({ refuseTaskReport: true });
    const taskId = `${STOREFRONT}-archived-1`;
    const refusal = await channel.verbs.boardToolRead('get_task_report', { project: STOREFRONT, taskId }).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CapabilityError);
    expect((refusal as CapabilityError).code).toBeUndefined();

    const knowledge = parseFindTaskKnowledge(await channel.verbs.boardToolRead('find_task', { project: STOREFRONT, id: taskId }), taskId);
    expect(knowledge?.summaryText).not.toBeNull();
    expect(knowledge?.commits).toHaveLength(3);
    expect(knowledge?.commitCount).toBe(4);
    expect(knowledge?.changedFiles).toHaveLength(7);
    expect(knowledge?.changedFileCount).toBe(7);
  });

  it("answers find_task with no knowledge of a summary still pending, as the desktop's index does", async () => {
    const channel = await connect();
    const taskId = `${CHECKOUT}-archived-1`;
    const knowledge = parseFindTaskKnowledge(await channel.verbs.boardToolRead('find_task', { project: CHECKOUT, id: taskId }), taskId);
    expect(knowledge?.summaryText).toBeNull();
    expect(knowledge?.commits).toHaveLength(2);
  });

  /**
   * What the desktop does for a task it has no record of: `get_task_report`
   * refuses ("Task not found", no code, like the older-desktop refusal above
   * but with its own message), and `find_task` answers with no matching row,
   * which the Summary's fallback reads as "nothing known" (an empty report, not
   * another task's). The mock plays both, so asking it for a task it does not
   * hold can never come back as some other archived task's record. A missing
   * parameter is the same miss, not a crash in the mock.
   */
  describe('for a task the desktop has no record of', () => {
    it.each([
      ['an unknown task id', { project: STOREFRONT, taskId: `${STOREFRONT}-archived-9` }],
      ['a task id that belongs to the other project', { project: STOREFRONT, taskId: `${CHECKOUT}-archived-1` }],
      ['an unknown project', { project: 'mock-project-ghost', taskId: `${STOREFRONT}-archived-1` }],
      ['no task id', { project: STOREFRONT }],
      ['no project', { taskId: `${STOREFRONT}-archived-1` }],
    ])('refuses get_task_report as not found for %s', async (_label, params) => {
      const channel = await connect();
      const refusal = await channel.verbs.boardToolRead('get_task_report', params).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(CapabilityError);
      expect((refusal as CapabilityError).verb).toBe('board-tool-read');
      expect((refusal as CapabilityError).message).toMatch(/^Task not found:/);
      expect((refusal as CapabilityError).code).toBeUndefined();
    });

    it.each([
      ['an unknown task id', { project: STOREFRONT, id: `${STOREFRONT}-archived-9` }, `${STOREFRONT}-archived-9`],
      ['a task id that belongs to the other project', { project: STOREFRONT, id: `${CHECKOUT}-archived-1` }, `${CHECKOUT}-archived-1`],
      ['an unknown project', { project: 'mock-project-ghost', id: `${STOREFRONT}-archived-1` }, `${STOREFRONT}-archived-1`],
      ['no id', { project: STOREFRONT }, `${STOREFRONT}-archived-1`],
      ['no project', { id: `${STOREFRONT}-archived-1` }, `${STOREFRONT}-archived-1`],
    ])('answers find_task with no matching row, so no knowledge, for %s', async (_label, params, taskId) => {
      const channel = await connect();
      const result = await channel.verbs.boardToolRead('find_task', params);
      expect(result).toEqual({ tasks: [], backlog: [] });
      expect(parseFindTaskKnowledge(result, taskId)).toBeNull();
    });
  });
});
