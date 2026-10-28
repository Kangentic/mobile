/**
 * The completed task Summary's rows (task #130): the desktop's card order, a
 * card left out when it has nothing to show, Files changed held to eight rows
 * until Show all, and the two states that are not a report.
 */
import { describe, expect, it } from 'vitest';
import type { TaskReportSummaryStateWire } from '@kangentic/protocol';
import type { CompletedTaskFile, CompletedTaskReport } from '@/taskReport/completedTaskReport';
import type { HeaderStripModel } from '@/taskReport/headerStrip';
import { COMMITS_SHOWN_MAX, FILES_COLLAPSED_ROWS, summaryItemKey, summaryItems, type SummaryItemsInput } from '@/taskReport/summaryItems';

const STRIP: HeaderStripModel = { spanCells: [], figureCells: [], pullRequest: null, status: { kind: 'completed', label: 'Completed' } };

function files(count: number): CompletedTaskFile[] {
  return Array.from({ length: count }, (_, index) => ({ path: `src/file${index}.ts`, status: 'M', insertions: 1, deletions: 0, binary: false }));
}

function commits(count: number): CompletedTaskReport['commits'] {
  return Array.from({ length: count }, (_, index) => ({ sha: `sha${index}`, subject: `commit ${index}`, committedAt: '2026-10-26T14:32:46.000Z' }));
}

function reportFixture(overrides: Partial<CompletedTaskReport> = {}): CompletedTaskReport {
  return {
    source: 'report',
    startedAt: '2026-10-26T11:27:10.030Z',
    endedAt: '2026-10-26T14:33:15.358Z',
    route: [
      { swimlaneId: 'lane-executing', name: 'Executing', color: '#3b82f6', icon: 'square-terminal', role: null, totalMs: 60_000, visits: [], visitCount: 1 },
    ],
    commits: [{ sha: '1002e46f7e60ac84c19dff73b561faa35a21c4a7', subject: 'test(review): pin the retry', committedAt: '2026-10-26T14:32:46.000Z' }],
    commitCount: 1,
    files: files(3),
    fileCount: 3,
    totals: null,
    summaryState: { kind: 'written', text: 'Fixed CI failures.' },
    ...overrides,
  };
}

function input(overrides: Partial<SummaryItemsInput> = {}): SummaryItemsInput {
  return {
    read: { phase: 'ready', report: reportFixture() },
    strip: STRIP,
    lastMessage: 'Shipped.',
    hasUsage: true,
    filesExpanded: false,
    ...overrides,
  };
}

function kinds(itemsInput: SummaryItemsInput): string[] {
  return summaryItems(itemsInput).map((item) => item.kind);
}

describe('summaryItems', () => {
  it("keeps the desktop's card order, Usage last", () => {
    expect(kinds(input())).toEqual(['strip', 'taskSummary', 'route', 'commits', 'filesHeader', 'fileRow', 'fileRow', 'fileRow', 'filesFooter', 'usage']);
  });

  it('shows one loading row and no figures while the read is in flight', () => {
    expect(kinds(input({ read: { phase: 'loading' } }))).toEqual(['loading']);
  });

  it('leaves out a card with nothing to show', () => {
    const empty = reportFixture({ route: [], commits: [], commitCount: 0, files: [], fileCount: 0 });
    expect(kinds(input({ read: { phase: 'ready', report: empty }, hasUsage: false }))).toEqual(['strip', 'taskSummary']);
  });

  it('holds Files changed to eight rows until Show all, then shows every row the desktop sent', () => {
    const many = reportFixture({ files: files(20), fileCount: 24 });
    const collapsed = summaryItems(input({ read: { phase: 'ready', report: many } }));
    expect(collapsed.filter((item) => item.kind === 'fileRow')).toHaveLength(FILES_COLLAPSED_ROWS);
    expect(collapsed.find((item) => item.kind === 'filesFooter')).toEqual({ kind: 'filesFooter', hiddenCount: 12, filesSent: 20 });
    expect(collapsed.find((item) => item.kind === 'filesHeader')).toEqual({ kind: 'filesHeader', fileCount: 24 });

    const expanded = summaryItems(input({ read: { phase: 'ready', report: many }, filesExpanded: true }));
    expect(expanded.filter((item) => item.kind === 'fileRow')).toHaveLength(20);
    expect(expanded.find((item) => item.kind === 'filesFooter')).toEqual({ kind: 'filesFooter', hiddenCount: 0, filesSent: 20 });
  });

  it('shows exactly eight files in full, with a Show all footer that hides none', () => {
    const eight = reportFixture({ files: files(8), fileCount: 8 });
    const items = summaryItems(input({ read: { phase: 'ready', report: eight } }));
    expect(items.filter((item) => item.kind === 'fileRow')).toHaveLength(8);
    expect(items.find((item) => item.kind === 'filesFooter')).toEqual({ kind: 'filesFooter', hiddenCount: 0, filesSent: 8 });
  });

  it("lists at most the desktop view's twenty commits and keeps the full count", () => {
    const item = summaryItems(input({ read: { phase: 'ready', report: reportFixture({ commits: commits(30), commitCount: 34 }) } })).find(
      (candidate) => candidate.kind === 'commits',
    );
    expect(item?.kind === 'commits' ? item.commits : []).toHaveLength(COMMITS_SHOWN_MAX);
    expect(item?.kind === 'commits' ? item.commitCount : 0).toBe(34);
  });

  it('lists all of exactly twenty commits and keeps the count', () => {
    const twenty = commits(20);
    const item = summaryItems(input({ read: { phase: 'ready', report: reportFixture({ commits: twenty, commitCount: 20 }) } })).find(
      (candidate) => candidate.kind === 'commits',
    );
    expect(item?.kind === 'commits' ? item.commits : []).toEqual(twenty);
    expect(item?.kind === 'commits' ? item.commitCount : 0).toBe(20);
  });

  it('shows the last message only in place of a summary that is not written', () => {
    const written = summaryItems(input()).find((item) => item.kind === 'taskSummary');
    expect(written).toEqual({ kind: 'taskSummary', summaryState: { kind: 'written', text: 'Fixed CI failures.' }, lastMessage: null });

    const pendingState: TaskReportSummaryStateWire = { kind: 'pending' };
    const pending = summaryItems(input({ read: { phase: 'ready', report: reportFixture({ summaryState: pendingState }) } })).find(
      (item) => item.kind === 'taskSummary',
    );
    expect(pending).toEqual({ kind: 'taskSummary', summaryState: pendingState, lastMessage: 'Shipped.' });
  });

  it('leaves the Task summary card out when nothing is known about the summary and there is no last message', () => {
    const unknown = reportFixture({ summaryState: null });
    expect(kinds(input({ read: { phase: 'ready', report: unknown }, lastMessage: null }))).not.toContain('taskSummary');
    expect(kinds(input({ read: { phase: 'ready', report: unknown } }))).toContain('taskSummary');
  });

  it("says the record could not be read when neither read answered, keeping the strip, the last message and Usage", () => {
    expect(kinds(input({ read: { phase: 'unavailable' } }))).toEqual(['strip', 'taskSummary', 'unavailable', 'usage']);
    expect(kinds(input({ read: { phase: 'unavailable' }, lastMessage: null, hasUsage: false }))).toEqual(['strip', 'unavailable']);
  });

  it('keys every row uniquely', () => {
    const items = summaryItems(input({ read: { phase: 'ready', report: reportFixture({ files: files(20) }) }, filesExpanded: true }));
    const keys = items.map(summaryItemKey);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
