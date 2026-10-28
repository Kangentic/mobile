import { isRecord, type JsonValue, type TaskReportCommitWire } from '@kangentic/protocol';

/**
 * What a finished task's `find_task` row knows about it: the fallback source
 * for the completed task Summary when a desktop older than protocol 0.24.0
 * refuses `get_task_report`.
 *
 * The protocol types every board tool's `result` as `JsonValue` (the bridge
 * forwards the desktop command's data as it is), and the desktop's
 * `TaskKnowledge` is not a protocol type, so this narrows JSON into the
 * Summary's own shape the way `src/workflow/workflowView.ts` does. Lenient: a
 * commit or path it cannot read costs that row only.
 *
 * The desktop caps the lists (3 commits, 8 paths, most changed first) and
 * carries the full counts beside them. A path has no status and no line
 * counts here; only the task report reads git.
 */
export interface TaskKnowledgeView {
  /** The written task summary, or null when none is written (pending or switched off: `find_task` cannot say which). */
  summaryText: string | null;
  commits: TaskReportCommitWire[];
  commitCount: number;
  changedFiles: string[];
  changedFileCount: number;
}

function parseCommit(value: JsonValue): TaskReportCommitWire | null {
  if (!isRecord(value)) return null;
  if (typeof value.sha !== 'string' || typeof value.subject !== 'string' || typeof value.committedAt !== 'string') return null;
  return { sha: value.sha, subject: value.subject, committedAt: value.committedAt };
}

/**
 * `find_task`'s result is `{ tasks: [...], backlog: [...] }`; this reads the
 * `knowledge` of the row whose `id` is `taskId`. Null when that row is absent,
 * when its `knowledge` is null (the desktop's index is off, its read failed, or
 * the match fell past the desktop's knowledge cap), or when the result is not
 * that shape at all, which includes the mock desktop's `{ note }` answer.
 */
export function parseFindTaskKnowledge(value: JsonValue, taskId: string): TaskKnowledgeView | null {
  if (!isRecord(value) || !Array.isArray(value.tasks)) return null;
  const row = value.tasks.find((candidate) => isRecord(candidate) && candidate.id === taskId);
  if (row === undefined || !isRecord(row) || !isRecord(row.knowledge)) return null;
  const knowledge = row.knowledge;

  const summaryText =
    isRecord(knowledge.summary) && typeof knowledge.summary.text === 'string' && knowledge.summary.text.trim().length > 0
      ? knowledge.summary.text
      : null;
  const commits = Array.isArray(knowledge.commits)
    ? knowledge.commits.map(parseCommit).filter((commit): commit is TaskReportCommitWire => commit !== null)
    : [];
  const changedFiles = Array.isArray(knowledge.changedFiles)
    ? knowledge.changedFiles.filter((path): path is string => typeof path === 'string' && path.length > 0)
    : [];

  return {
    summaryText,
    commits,
    commitCount: typeof knowledge.commitCount === 'number' ? Math.max(knowledge.commitCount, commits.length) : commits.length,
    changedFiles,
    changedFileCount:
      typeof knowledge.changedFileCount === 'number' ? Math.max(knowledge.changedFileCount, changedFiles.length) : changedFiles.length,
  };
}
