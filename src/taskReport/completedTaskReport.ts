import type {
  DiffFileWire,
  TaskReportChangesWire,
  TaskReportCommitWire,
  TaskReportRouteColumnWire,
  TaskReportSummaryStateWire,
  TaskReportWire,
} from '@kangentic/protocol';
import type { TaskKnowledgeView } from './findTaskKnowledge';

/**
 * One changed file as the Files changed card draws it. A task report reads git
 * and carries status and line counts; the `find_task` fallback names the path
 * only, so everything past the path is optional.
 */
export type CompletedTaskFile = Pick<DiffFileWire, 'path'> & Partial<Pick<DiffFileWire, 'status' | 'insertions' | 'deletions' | 'binary'>>;

/**
 * The completed task Summary's data, whichever source supplied it. The cards
 * read only this, so `get_task_report` and the older `find_task` fallback
 * render through one path.
 */
export interface CompletedTaskReport {
  source: 'report' | 'knowledge';
  /** The desktop's span: first move into a working column (or first session start) to the last move into Done. Null from the fallback. */
  startedAt: string | null;
  endedAt: string | null;
  /** Working columns in board order. Empty from the fallback. */
  route: TaskReportRouteColumnWire[];
  /** Newest first, capped by the desktop; `commitCount` is the full count. */
  commits: TaskReportCommitWire[];
  commitCount: number;
  /** Biggest change first, capped by the desktop; `fileCount` is the full count. */
  files: CompletedTaskFile[];
  fileCount: number;
  /** Git's totals for the whole change, when one span of history holds it. */
  totals: TaskReportChangesWire['totals'];
  /** Null when the desktop could not say anything about the summary (`find_task` found no knowledge). */
  summaryState: TaskReportSummaryStateWire | null;
}

export function reportFromTaskReportWire(wire: TaskReportWire): CompletedTaskReport {
  const commits = wire.commits ?? [];
  const files = wire.changes?.files ?? [];
  return {
    source: 'report',
    startedAt: wire.startedAt,
    endedAt: wire.endedAt,
    route: wire.route,
    commits,
    commitCount: Math.max(wire.commitCount ?? 0, commits.length),
    files,
    fileCount: Math.max(wire.changes?.fileCount ?? 0, files.length),
    totals: wire.changes?.totals ?? null,
    summaryState: wire.summaryState,
  };
}

/**
 * The fallback's report. `find_task` cannot tell "pending" from "switched off",
 * so a missing summary reads as pending, and it has no route, span or git
 * figures. Null knowledge (the desktop's index is off or could not be read)
 * leaves every card empty rather than guessing.
 */
export function reportFromTaskKnowledge(knowledge: TaskKnowledgeView | null): CompletedTaskReport {
  let summaryState: TaskReportSummaryStateWire | null = null;
  if (knowledge !== null) {
    summaryState = knowledge.summaryText !== null ? { kind: 'written', text: knowledge.summaryText } : { kind: 'pending' };
  }
  return {
    source: 'knowledge',
    startedAt: null,
    endedAt: null,
    route: [],
    commits: knowledge?.commits ?? [],
    commitCount: knowledge?.commitCount ?? 0,
    files: (knowledge?.changedFiles ?? []).map((path) => ({ path })),
    fileCount: knowledge?.changedFileCount ?? 0,
    totals: null,
    summaryState,
  };
}
