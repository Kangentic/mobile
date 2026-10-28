import type { TaskReportCommitWire, TaskReportRouteColumnWire, TaskReportSummaryStateWire } from '@kangentic/protocol';
import type { CompletedTaskFile, CompletedTaskReport } from './completedTaskReport';
import type { HeaderStripModel } from './headerStrip';

/** Files changed shows this many rows, then a Show all that expands the rest in place. */
export const FILES_COLLAPSED_ROWS = 8;

/** The desktop's completed view lists at most this many commits; the card's aside counts the rest. */
export const COMMITS_SHOWN_MAX = 20;

/**
 * One row of the completed task Summary's list.
 *
 * The Summary is a FlashList rather than a ScrollView because Files changed
 * can expand to every file the desktop sent (up to 200), and a `.map()` that
 * long inside a ScrollView is what `ui-conventions.md` rules out. So each file
 * is its own item, and the card around them is split across `filesHeader`,
 * the rows and `filesFooter`. Route and Commits are bounded (one row per
 * column, at most 20 commits), so each stays one item.
 */
export type SummaryItem =
  | { kind: 'loading' }
  | { kind: 'strip'; strip: HeaderStripModel }
  | { kind: 'taskSummary'; summaryState: TaskReportSummaryStateWire | null; lastMessage: string | null }
  | { kind: 'unavailable' }
  | { kind: 'route'; route: TaskReportRouteColumnWire[] }
  | { kind: 'commits'; commits: TaskReportCommitWire[]; commitCount: number }
  | { kind: 'filesHeader'; fileCount: number }
  | { kind: 'fileRow'; file: CompletedTaskFile; index: number }
  /** `filesSent` is how many rows the desktop sent, which Show all expands to; its own count can be higher (it caps the list). */
  | { kind: 'filesFooter'; hiddenCount: number; filesSent: number }
  | { kind: 'usage' };

/** Where the Summary's read stands: in flight, answered (by the report or the fallback), or neither could be read. */
export type SummaryPhase = { phase: 'loading' } | { phase: 'ready'; report: CompletedTaskReport } | { phase: 'unavailable' };

export interface SummaryItemsInput {
  read: SummaryPhase;
  strip: HeaderStripModel;
  /** The agent's last message, for the Task summary card when no summary is written. */
  lastMessage: string | null;
  /** True once the task has a session summary, which is what the Usage row reads. */
  hasUsage: boolean;
  filesExpanded: boolean;
}

/**
 * The Summary's rows, in the desktop's card order: the strip, Task summary,
 * Route, Commits, Files changed, then Usage, which the desktop keeps on a tab
 * of its own. A card with nothing to show is left out.
 *
 * While the read is in flight there is one `loading` row: the desktop renders
 * its strip only once the report has loaded, so no figure appears and then
 * changes. If neither read answers, the strip falls back to the phone's own
 * figures, the Task summary card keeps only the last message, and an
 * `unavailable` row says the record could not be read, so the screen does not
 * pass for a task with no commits.
 */
export function summaryItems({ read, strip, lastMessage, hasUsage, filesExpanded }: SummaryItemsInput): SummaryItem[] {
  if (read.phase === 'loading') return [{ kind: 'loading' }];

  const items: SummaryItem[] = [{ kind: 'strip', strip }];

  if (read.phase === 'unavailable') {
    if (lastMessage !== null) items.push({ kind: 'taskSummary', summaryState: null, lastMessage });
    items.push({ kind: 'unavailable' });
    if (hasUsage) items.push({ kind: 'usage' });
    return items;
  }

  const { report } = read;
  // The last message stands in for a summary only when none is written, as on the desktop.
  const fallbackMessage = report.summaryState?.kind === 'written' ? null : lastMessage;
  if (report.summaryState !== null || fallbackMessage !== null) {
    items.push({ kind: 'taskSummary', summaryState: report.summaryState, lastMessage: fallbackMessage });
  }
  if (report.route.length > 0) items.push({ kind: 'route', route: report.route });
  if (report.commits.length > 0) {
    items.push({ kind: 'commits', commits: report.commits.slice(0, COMMITS_SHOWN_MAX), commitCount: report.commitCount });
  }
  if (report.files.length > 0) {
    const shownFiles = filesExpanded ? report.files : report.files.slice(0, FILES_COLLAPSED_ROWS);
    items.push({ kind: 'filesHeader', fileCount: report.fileCount });
    shownFiles.forEach((file, index) => {
      items.push({ kind: 'fileRow', file, index });
    });
    items.push({ kind: 'filesFooter', hiddenCount: report.files.length - shownFiles.length, filesSent: report.files.length });
  }
  if (hasUsage) items.push({ kind: 'usage' });
  return items;
}

/** A stable key per row: the card kinds are singletons, and a file row keys on its position in the desktop's order. */
export function summaryItemKey(item: SummaryItem): string {
  return item.kind === 'fileRow' ? `file-${item.index}` : item.kind;
}
