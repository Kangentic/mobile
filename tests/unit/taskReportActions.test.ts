/**
 * The completed task Summary's read (task #130): `get_task_report` first, the
 * `find_task` fallback on any failure but a lost channel. The verb client is
 * faked at the connection manager, so these pin what is asked, in what order,
 * and what comes back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JsonValue } from '@kangentic/protocol';
import { CapabilityError, CapabilityTimeoutError, ChannelDisconnectedError } from '@/channel';

const boardToolRead = vi.fn<(tool: string, params: JsonValue, options?: { timeoutMs?: number }) => Promise<JsonValue>>();

class FakeNotConnectedError extends Error {
  constructor() {
    super('not connected');
    this.name = 'NotConnectedError';
  }
}

vi.mock('@/connection/connectionManager', () => ({
  requireVerbClient: () => ({ boardToolRead }),
  NotConnectedError: FakeNotConnectedError,
}));

const { fetchCompletedTaskReport, TASK_REPORT_TIMEOUT_MS } = await import('@/connection/taskReportActions');

const PROJECT_ID = '354ea0ee-1111-4222-8333-944445555666';
const TASK_ID = '603d7042-f8aa-4ab8-860f-0f389edf25bb';

const REPORT: JsonValue = {
  taskId: TASK_ID,
  startedAt: '2026-10-26T11:27:10.030Z',
  endedAt: '2026-10-26T14:33:15.358Z',
  route: [],
  commits: [{ sha: '1002e46f7e60ac84c19dff73b561faa35a21c4a7', subject: 'test(review): pin the retry', committedAt: '2026-10-26T14:32:46.000Z' }],
  commitCount: 3,
  changes: {
    files: [{ path: 'tests/ui/helpers.ts', status: 'M', insertions: 113, deletions: 24, binary: false }],
    fileCount: 20,
    totals: { insertions: 1047, deletions: 120, filesChanged: 20 },
    emptyReason: null,
  },
  changesError: null,
  summaryState: { kind: 'written', text: 'Fixed CI failures.' },
};

const FIND_TASK: JsonValue = {
  tasks: [
    {
      id: TASK_ID,
      knowledge: {
        summary: null,
        commits: [],
        commitCount: 0,
        changedFiles: ['tests/ui/helpers.ts'],
        changedFileCount: 20,
      },
    },
  ],
  backlog: [],
};

function answer(tool: string, result: JsonValue | Error): void {
  boardToolRead.mockImplementation(async (askedTool) => {
    if (askedTool === tool) {
      if (result instanceof Error) throw result;
      return result;
    }
    return askedTool === 'find_task' ? FIND_TASK : REPORT;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  boardToolRead.mockImplementation(async (tool) => (tool === 'get_task_report' ? REPORT : FIND_TASK));
});

describe('fetchCompletedTaskReport', () => {
  it("reads the task report, asking the project by id with the report's own timeout", async () => {
    const outcome = await fetchCompletedTaskReport(PROJECT_ID, TASK_ID);
    expect(boardToolRead).toHaveBeenCalledTimes(1);
    expect(boardToolRead).toHaveBeenCalledWith('get_task_report', { project: PROJECT_ID, taskId: TASK_ID }, { timeoutMs: TASK_REPORT_TIMEOUT_MS });
    expect(TASK_REPORT_TIMEOUT_MS).toBe(20_000);
    expect(outcome.kind).toBe('ready');
    if (outcome.kind !== 'ready') return;
    expect(outcome.report.source).toBe('report');
    expect(outcome.report.totals).toEqual({ insertions: 1047, deletions: 120, filesChanged: 20 });
  });

  it('falls back to find_task, asked by the task id, when an older desktop refuses the report', async () => {
    answer('get_task_report', new CapabilityError('board-tool-read', 'Tool not allowed for board-tool-read: get_task_report'));
    const outcome = await fetchCompletedTaskReport(PROJECT_ID, TASK_ID);
    expect(boardToolRead).toHaveBeenLastCalledWith('find_task', { project: PROJECT_ID, id: TASK_ID });
    expect(outcome.kind === 'ready' ? outcome.report.source : null).toBe('knowledge');
    expect(outcome.kind === 'ready' ? outcome.report.files : null).toEqual([{ path: 'tests/ui/helpers.ts' }]);
  });

  it('falls back when the report times out, since a slow index is not the end', async () => {
    answer('get_task_report', new CapabilityTimeoutError('board-tool-read'));
    const outcome = await fetchCompletedTaskReport(PROJECT_ID, TASK_ID);
    expect(boardToolRead.mock.calls.map((call) => call[0])).toEqual(['get_task_report', 'find_task']);
    expect(outcome.kind).toBe('ready');
  });

  it('falls back when the report cannot be read', async () => {
    answer('get_task_report', { taskId: TASK_ID, route: 'not a route' });
    const outcome = await fetchCompletedTaskReport(PROJECT_ID, TASK_ID);
    expect(boardToolRead.mock.calls.map((call) => call[0])).toEqual(['get_task_report', 'find_task']);
    expect(outcome.kind === 'ready' ? outcome.report.source : null).toBe('knowledge');
  });

  it('is unavailable, carrying the last failure, when the fallback is refused too', async () => {
    const fallbackRefusal = new CapabilityError('board-tool-read', 'Tool not allowed for board-tool-read: find_task');
    boardToolRead.mockImplementation(async (tool) => {
      throw tool === 'find_task' ? fallbackRefusal : new CapabilityError('board-tool-read', 'Tool not allowed');
    });
    expect(await fetchCompletedTaskReport(PROJECT_ID, TASK_ID)).toEqual({ kind: 'unavailable', error: fallbackRefusal });
  });

  it.each([
    ['a dropped channel', () => new ChannelDisconnectedError('socket closed')],
    ['no channel at all', () => new FakeNotConnectedError()],
  ])('makes no fallback call after %s, which would fail the same way', async (_label, makeError) => {
    const transportError = makeError();
    answer('get_task_report', transportError);
    const outcome = await fetchCompletedTaskReport(PROJECT_ID, TASK_ID);
    expect(boardToolRead).toHaveBeenCalledTimes(1);
    expect(outcome).toEqual({ kind: 'unavailable', error: transportError });
  });

  it('shares one read between two screens asking for the same task at once', async () => {
    let release: (value: JsonValue) => void = () => undefined;
    boardToolRead.mockImplementationOnce(
      () =>
        new Promise<JsonValue>((resolve) => {
          release = resolve;
        }),
    );
    const first = fetchCompletedTaskReport(PROJECT_ID, TASK_ID);
    const second = fetchCompletedTaskReport(PROJECT_ID, TASK_ID);
    release(REPORT);
    expect(await first).toBe(await second);
    expect(boardToolRead).toHaveBeenCalledTimes(1);
  });

  /**
   * The in-flight map must forget a read once it settles, or a task's Summary
   * could never be re-read (a retry after "unavailable", a reopen after the
   * desktop's report changed). `readsInFlight` is module-level, so each case
   * asks for its own project id: a shared key would let an earlier test's
   * leftover entry answer this one and hide which assertion should fail.
   *
   * Mutation seen failing: removing `readsInFlight.delete(key)` from the
   * `.finally` - the second call returns the settled promise and
   * `boardToolRead` has been called once, not twice.
   */
  it('reads again for a task whose earlier read settled ready', async () => {
    const projectId = 'project-settled-ready';
    const first = await fetchCompletedTaskReport(projectId, TASK_ID);
    expect(first.kind).toBe('ready');
    expect(boardToolRead).toHaveBeenCalledTimes(1);

    const second = await fetchCompletedTaskReport(projectId, TASK_ID);
    expect(boardToolRead).toHaveBeenCalledTimes(2);
    expect(boardToolRead).toHaveBeenLastCalledWith('get_task_report', { project: projectId, taskId: TASK_ID }, { timeoutMs: TASK_REPORT_TIMEOUT_MS });
    expect(second.kind).toBe('ready');
    expect(second).not.toBe(first);
  });

  it.each([
    ['a dropped channel', 'project-settled-dropped', () => new ChannelDisconnectedError('socket closed')],
    ['no channel at all', 'project-settled-not-connected', () => new FakeNotConnectedError()],
  ])('reads again, and can succeed, after a read lost to %s', async (_label, projectId, makeError) => {
    const transportError = makeError();
    boardToolRead.mockImplementationOnce(async () => {
      throw transportError;
    });

    const first = await fetchCompletedTaskReport(projectId, TASK_ID);
    expect(first).toEqual({ kind: 'unavailable', error: transportError });
    expect(boardToolRead).toHaveBeenCalledTimes(1);

    // The channel is back: the default answer serves the second read.
    const second = await fetchCompletedTaskReport(projectId, TASK_ID);
    expect(boardToolRead).toHaveBeenCalledTimes(2);
    expect(second.kind).toBe('ready');
    expect(second.kind === 'ready' ? second.report.source : null).toBe('report');
  });
});
