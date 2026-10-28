import type { BoardTaskWire, SessionSummaryWire } from '@kangentic/protocol';
import { httpsUrlOrNull } from '@/lib/httpsUrl';
import type { CompletedTaskReport } from './completedTaskReport';
import { formatCost, formatMonthDayTime, formatSpan, formatTokenCount } from './format';

/**
 * The completed task view's header strip, ported from the desktop's
 * `CompletedHeaderStrip.tsx`: which figures show and what they read. A value
 * that is missing or zero hides its cell; nothing ever renders a dash.
 *
 * The desktop hangs exact figures on tooltips. Touch has none, so those become
 * the accessibility labels, and the span the desktop puts in Elapsed's tooltip
 * stays visible as the Started and Ended cells (the desktop hides those two
 * below 640 px, which is every phone).
 */

export interface StripTextCell {
  key: 'started' | 'ended' | 'elapsed' | 'agentRuntime' | 'cost';
  kind: 'text';
  label: string;
  value: string;
  accessibilityLabel: string;
}

/** Changes reads "+X -Y", in the diff colors. The desktop drops its file count below 860 px; the Files card shows it. */
export interface StripChangesCell {
  key: 'changes';
  kind: 'changes';
  label: string;
  added: string;
  removed: string;
  accessibilityLabel: string;
}

export type StripCell = StripTextCell | StripChangesCell;

export interface StripPullRequest {
  number: number;
  /** The https URL to open, or null when there is none to open safely. */
  url: string | null;
  /** "Open", "Draft", "Merged" or "Closed"; null for a state the desktop gives no word. */
  stateWord: string | null;
  accessibilityLabel: string;
}

export interface StripStatus {
  kind: 'completed' | 'exited';
  label: string;
}

export interface HeaderStripModel {
  /** Started and Ended, each only when known. */
  spanCells: StripTextCell[];
  /** Elapsed, Agent runtime, Changes and Cost, each only when it has a value. */
  figureCells: StripCell[];
  pullRequest: StripPullRequest | null;
  status: StripStatus;
}

export type StripTask = Pick<BoardTaskWire, 'archived_at' | 'pr_number' | 'pr_url' | 'pr_state'>;

/** The desktop's `prStatePresentation(...).label`, capitalized as its CSS shows it. */
const PR_STATE_WORDS: ReadonlyMap<string, string> = new Map([
  ['open', 'Open'],
  ['draft', 'Draft'],
  ['merged', 'Merged'],
  ['closed', 'Closed'],
]);

function parsedTime(value: string | null): number {
  return value === null ? Number.NaN : Date.parse(value);
}

function exactCount(count: number): string {
  return count.toLocaleString('en-US');
}

/**
 * The strip for a completed task.
 *
 * - **Started** is the report's span start, else the session's start. **Ended**
 *   is the report's span end, else when the task was archived. The fallback
 *   values are what the phone had before the task report existed.
 * - **Changes** prefers git's totals for the whole change, then the session's
 *   own line counts, as the desktop does.
 * - **Status** reads "Exited (n)" only for a known, non-zero exit code;
 *   everything else, a task that ran no agent included, reads "Completed".
 *
 * `report` is null when neither the report nor the fallback could be read.
 */
export function headerStripModel(
  report: CompletedTaskReport | null,
  summary: SessionSummaryWire | null,
  task: StripTask,
  now: Date = new Date(),
): HeaderStripModel {
  const startedAt = report?.startedAt ?? summary?.startedAt ?? null;
  const endedAt = report?.endedAt ?? task.archived_at;

  const spanCells: StripTextCell[] = [];
  const startedValue = formatMonthDayTime(startedAt, now);
  if (startedValue.length > 0) {
    spanCells.push({ key: 'started', kind: 'text', label: 'Started', value: startedValue, accessibilityLabel: `Started ${startedValue}` });
  }
  const endedValue = formatMonthDayTime(endedAt, now);
  if (endedValue.length > 0) {
    spanCells.push({ key: 'ended', kind: 'text', label: 'Ended', value: endedValue, accessibilityLabel: `Ended ${endedValue}` });
  }

  const figureCells: StripCell[] = [];
  const elapsedMs = parsedTime(endedAt) - parsedTime(startedAt);
  if (Number.isFinite(elapsedMs) && elapsedMs >= 0) {
    const value = formatSpan(elapsedMs);
    figureCells.push({ key: 'elapsed', kind: 'text', label: 'Elapsed', value, accessibilityLabel: `Elapsed ${value}` });
  }
  if (summary !== null && summary.durationMs > 0) {
    const value = formatSpan(summary.durationMs);
    figureCells.push({ key: 'agentRuntime', kind: 'text', label: 'Agent runtime', value, accessibilityLabel: `Agent runtime ${value}` });
  }

  const totals = report?.totals ?? null;
  const linesAdded = totals !== null ? totals.insertions : (summary?.linesAdded ?? 0);
  const linesRemoved = totals !== null ? totals.deletions : (summary?.linesRemoved ?? 0);
  const filesChanged = totals !== null ? totals.filesChanged : (summary?.filesChanged ?? 0);
  if (linesAdded > 0 || linesRemoved > 0 || filesChanged > 0) {
    const fileWord = filesChanged === 1 ? 'file' : 'files';
    figureCells.push({
      key: 'changes',
      kind: 'changes',
      label: 'Changes',
      added: `+${formatTokenCount(linesAdded)}`,
      removed: `-${formatTokenCount(linesRemoved)}`,
      accessibilityLabel: `Changes: ${exactCount(linesAdded)} lines added, ${exactCount(linesRemoved)} lines removed, ${exactCount(filesChanged)} ${fileWord} changed`,
    });
  }
  if (summary !== null && summary.totalCostUsd > 0) {
    const value = formatCost(summary.totalCostUsd);
    figureCells.push({ key: 'cost', kind: 'text', label: 'Cost', value, accessibilityLabel: `Cost ${value}` });
  }

  let pullRequest: StripPullRequest | null = null;
  if (task.pr_number !== null) {
    const stateWord = task.pr_state === null ? null : (PR_STATE_WORDS.get(task.pr_state) ?? null);
    const url = httpsUrlOrNull(task.pr_url);
    const stateSuffix = stateWord === null ? '' : ` (${stateWord.toLowerCase()})`;
    pullRequest = {
      number: task.pr_number,
      url,
      stateWord,
      accessibilityLabel: `${url === null ? 'Pull request' : 'Open pull request'} #${task.pr_number}${stateSuffix}`,
    };
  }

  const exitCode = summary?.exitCode ?? null;
  const status: StripStatus =
    exitCode !== null && exitCode !== 0 ? { kind: 'exited', label: `Exited (${exitCode})` } : { kind: 'completed', label: 'Completed' };

  return { spanCells, figureCells, pullRequest, status };
}
