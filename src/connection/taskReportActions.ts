import { parseTaskReportWire } from '@kangentic/protocol';
import { ChannelDisconnectedError } from '@/channel';
import { reportFromTaskKnowledge, reportFromTaskReportWire, type CompletedTaskReport } from '@/taskReport/completedTaskReport';
import { parseFindTaskKnowledge } from '@/taskReport/findTaskKnowledge';
import { NotConnectedError, requireVerbClient } from './connectionManager';

/**
 * `get_task_report`'s own timeout. The desktop's `readTaskReport` can wait up
 * to 8 s for its index (`INDEX_WAIT_MS`) before it reads git, which the
 * default 10 s capability timeout leaves almost no room for. A timeout here is
 * not the end either: the read falls back to `find_task`, which does no index
 * wait.
 *
 * Measured against a running desktop over the local dev relay (emulator,
 * 2026-10-27, one read each): 742 ms for a task with 437 changed files, 597 ms
 * for one with 4, 200 ms for one with no commits. The index was already warm;
 * the cold-start wait this headroom is for was not measured. The 20 s itself
 * is read out of the desktop's source (the 8 s wait plus a git read), not
 * measured.
 */
export const TASK_REPORT_TIMEOUT_MS = 20_000;

export type CompletedTaskReportOutcome =
  | { kind: 'ready'; report: CompletedTaskReport }
  /** Neither read answered. `error` is the last failure, for the handled-error door. */
  | { kind: 'unavailable'; error: unknown };

/** No channel, or it dropped mid-read: a second request would fail the same way. */
function isTransportLoss(error: unknown): boolean {
  return error instanceof NotConnectedError || error instanceof ChannelDisconnectedError;
}

const readsInFlight = new Map<string, Promise<CompletedTaskReportOutcome>>();

/**
 * A completed task's report for its Summary.
 *
 * Asks for `get_task_report` (protocol 0.24.0) first. Any failure other than a
 * lost channel falls back to `find_task`: a desktop older than 0.24.0 refuses
 * the tool as not allowed (with no refusal code, so every refusal counts), a
 * slow index can outlast the timeout, and a report this phone cannot read is
 * no better than none. `find_task` names up to three commits and eight paths,
 * and nothing about the route or the span.
 *
 * `project` must be the project's id: the bridge resolves it by id only, never
 * by name. `find_task` is asked by the task's id, because it ignores a
 * `displayId` that is not a JSON number. Two screens opening the same task
 * share one read.
 */
export function fetchCompletedTaskReport(projectId: string, taskId: string): Promise<CompletedTaskReportOutcome> {
  const key = `${projectId}:${taskId}`;
  const inFlight = readsInFlight.get(key);
  if (inFlight !== undefined) return inFlight;
  const read = readCompletedTaskReport(projectId, taskId).finally(() => {
    readsInFlight.delete(key);
  });
  readsInFlight.set(key, read);
  return read;
}

async function readCompletedTaskReport(projectId: string, taskId: string): Promise<CompletedTaskReportOutcome> {
  try {
    const result = await requireVerbClient().boardToolRead(
      'get_task_report',
      { project: projectId, taskId },
      { timeoutMs: TASK_REPORT_TIMEOUT_MS },
    );
    return { kind: 'ready', report: reportFromTaskReportWire(parseTaskReportWire(result)) };
  } catch (reportError) {
    if (isTransportLoss(reportError)) return { kind: 'unavailable', error: reportError };
  }
  try {
    const result = await requireVerbClient().boardToolRead('find_task', { project: projectId, id: taskId });
    return { kind: 'ready', report: reportFromTaskKnowledge(parseFindTaskKnowledge(result, taskId)) };
  } catch (fallbackError) {
    return { kind: 'unavailable', error: fallbackError };
  }
}
