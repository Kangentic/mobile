/**
 * The completed task's header strip and the report it reads (task #130),
 * against the desktop's `CompletedHeaderStrip.tsx` rules: a missing or zero
 * figure hides its cell, Changes prefers git's totals, and the status reads
 * "Exited (n)" only for a known non-zero exit.
 */
import { describe, expect, it } from 'vitest';
import type { SessionSummaryWire, TaskReportWire } from '@kangentic/protocol';
import { reportFromTaskKnowledge, reportFromTaskReportWire } from '@/taskReport/completedTaskReport';
import { formatMonthDayTime } from '@/taskReport/format';
import { headerStripModel, type HeaderStripModel, type StripTask } from '@/taskReport/headerStrip';

const NOW = new Date('2026-10-27T12:00:00.000Z');

function summaryFixture(overrides: Partial<SessionSummaryWire> = {}): SessionSummaryWire {
  return {
    sessionId: 'session-905',
    totalCostUsd: 43.42,
    totalInputTokens: 104_900_000,
    totalOutputTokens: 336_300,
    modelDisplayName: 'Sonnet 5.5',
    durationMs: 11_150_924,
    toolCallCount: 528,
    compactionCount: 0,
    linesAdded: 1000,
    linesRemoved: 114,
    filesChanged: 20,
    taskCreatedAt: '2026-10-26T10:00:00.000Z',
    startedAt: '2026-10-26T11:30:00.000Z',
    exitedAt: '2026-10-26T14:30:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

function reportFixture(overrides: Partial<TaskReportWire> = {}): TaskReportWire {
  return {
    taskId: 'task-905',
    startedAt: '2026-10-26T11:27:10.030Z',
    endedAt: '2026-10-26T14:33:15.358Z',
    route: [],
    commits: [],
    commitCount: 0,
    changes: { files: [], fileCount: 20, totals: { insertions: 1047, deletions: 120, filesChanged: 20 }, emptyReason: null },
    changesError: null,
    summaryState: { kind: 'pending' },
    ...overrides,
  };
}

const TASK: StripTask = {
  archived_at: '2026-10-26T14:40:00.000Z',
  pr_number: 656,
  pr_url: 'https://github.com/Kangentic/kangentic/pull/656',
  pr_state: 'merged',
};

function cellValues(strip: HeaderStripModel): Record<string, string> {
  const values: Record<string, string> = {};
  for (const cell of [...strip.spanCells, ...strip.figureCells]) {
    values[cell.key] = cell.kind === 'changes' ? `${cell.added} ${cell.removed}` : cell.value;
  }
  return values;
}

describe('headerStripModel', () => {
  it("reads #905's figures the way the desktop prints them", () => {
    const strip = headerStripModel(reportFromTaskReportWire(reportFixture()), summaryFixture(), TASK, NOW);
    const values = cellValues(strip);
    expect(values.elapsed).toBe('3h 6m');
    expect(values.agentRuntime).toBe('3h 5m');
    expect(values.changes).toBe('+1k -120');
    expect(values.cost).toBe('$43.42');
    expect(strip.figureCells.map((cell) => cell.key)).toEqual(['elapsed', 'agentRuntime', 'changes', 'cost']);
    expect(strip.spanCells.map((cell) => cell.key)).toEqual(['started', 'ended']);
  });

  it("prefers git's totals for Changes, and falls back to the session's lines without them", () => {
    const withTotals = cellValues(headerStripModel(reportFromTaskReportWire(reportFixture()), summaryFixture(), TASK, NOW));
    expect(withTotals.changes).toBe('+1k -120');
    const noTotals = reportFixture({ changes: { files: [], fileCount: 0, totals: null, emptyReason: 'not-in-clone' } });
    expect(cellValues(headerStripModel(reportFromTaskReportWire(noTotals), summaryFixture(), TASK, NOW)).changes).toBe('+1k -114');
    expect(cellValues(headerStripModel(null, summaryFixture(), TASK, NOW)).changes).toBe('+1k -114');
  });

  it('says the exact counts out loud, since the desktop keeps them in a tooltip', () => {
    const strip = headerStripModel(reportFromTaskReportWire(reportFixture()), summaryFixture(), TASK, NOW);
    const changes = strip.figureCells.find((cell) => cell.key === 'changes');
    expect(changes?.accessibilityLabel).toBe('Changes: 1,047 lines added, 120 lines removed, 20 files changed');
  });

  it("takes the span from the report, else the session's start and the archive time", () => {
    const fromReport = headerStripModel(reportFromTaskReportWire(reportFixture()), summaryFixture(), TASK, NOW);
    const fromFallback = headerStripModel(reportFromTaskKnowledge(null), summaryFixture(), TASK, NOW);
    // 11:27:10 to 14:33:15 from the report; 11:30 to 14:40 from the session and the archive.
    expect(cellValues(fromReport).elapsed).toBe('3h 6m');
    expect(cellValues(fromFallback).elapsed).toBe('3h 10m');
  });

  it('hides Agent runtime and Cost at zero, and every agent figure when no agent ran', () => {
    const idle = headerStripModel(null, summaryFixture({ durationMs: 0, totalCostUsd: 0 }), TASK, NOW);
    expect(idle.figureCells.map((cell) => cell.key)).toEqual(['elapsed', 'changes']);
    const noAgentReport = reportFixture({
      startedAt: '2026-07-19T08:58:00.000Z',
      endedAt: '2026-07-19T09:15:00.000Z',
      changes: { files: [], fileCount: 0, totals: null, emptyReason: 'no-commits' },
    });
    const noAgent = headerStripModel(reportFromTaskReportWire(noAgentReport), null, { ...TASK, pr_number: null }, NOW);
    expect(noAgent.spanCells.map((cell) => cell.key)).toEqual(['started', 'ended']);
    expect(noAgent.figureCells.map((cell) => cell.key)).toEqual(['elapsed']);
    expect(cellValues(noAgent).elapsed).toBe('17m');
    expect(noAgent.pullRequest).toBeNull();
    expect(noAgent.status).toEqual({ kind: 'completed', label: 'Completed' });
  });

  it('hides Started and Elapsed when no start is known, rather than showing a dash', () => {
    const strip = headerStripModel(reportFromTaskKnowledge(null), null, TASK, NOW);
    expect(strip.spanCells.map((cell) => cell.key)).toEqual(['ended']);
    expect(strip.figureCells.map((cell) => cell.key)).not.toContain('elapsed');
  });

  it('reads "Exited (n)" only for a known non-zero exit code', () => {
    expect(headerStripModel(null, summaryFixture({ exitCode: 1 }), TASK, NOW).status).toEqual({ kind: 'exited', label: 'Exited (1)' });
    expect(headerStripModel(null, summaryFixture({ exitCode: 0 }), TASK, NOW).status.kind).toBe('completed');
    expect(headerStripModel(null, summaryFixture({ exitCode: null }), TASK, NOW).status.kind).toBe('completed');
  });

  it('shows the PR with its state word and opens only an https URL', () => {
    const merged = headerStripModel(null, summaryFixture(), TASK, NOW).pullRequest;
    expect(merged).toEqual({
      number: 656,
      url: 'https://github.com/Kangentic/kangentic/pull/656',
      stateWord: 'Merged',
      accessibilityLabel: 'Open pull request #656 (merged)',
    });
    const insecure = headerStripModel(null, summaryFixture(), { ...TASK, pr_url: 'http://example.com/pull/656', pr_state: null }, NOW).pullRequest;
    expect(insecure).toEqual({ number: 656, url: null, stateWord: null, accessibilityLabel: 'Pull request #656' });
    expect(headerStripModel(null, summaryFixture(), { ...TASK, pr_state: 'reopened' }, NOW).pullRequest?.stateWord).toBeNull();
  });

  it.each([
    ['open', 'Open', 'Open pull request #656 (open)'],
    ['draft', 'Draft', 'Open pull request #656 (draft)'],
    ['closed', 'Closed', 'Open pull request #656 (closed)'],
  ])('reads a pull request in state %s as "%s", with the lowercase state in its label', (prState, stateWord, accessibilityLabel) => {
    const pullRequest = headerStripModel(null, summaryFixture(), { ...TASK, pr_state: prState }, NOW).pullRequest;
    expect(pullRequest).toEqual({ number: 656, url: 'https://github.com/Kangentic/kangentic/pull/656', stateWord, accessibilityLabel });
  });

  it('hides Elapsed, and only Elapsed, when the report ends before it starts', () => {
    // The end is 3h 6m before the start: a clock step or a bad record, never a negative duration to print.
    const backwards = reportFixture({ startedAt: '2026-10-26T14:33:15.358Z', endedAt: '2026-10-26T11:27:10.030Z' });
    const strip = headerStripModel(reportFromTaskReportWire(backwards), summaryFixture(), TASK, NOW);
    expect(strip.spanCells.map((cell) => cell.key)).toEqual(['started', 'ended']);
    expect(strip.figureCells.map((cell) => cell.key)).toEqual(['agentRuntime', 'changes', 'cost']);
  });

  it.each([
    [1, '1 file changed'],
    [2, '2 files changed'],
    [0, '0 files changed'],
  ])('says %i files changed as "%s"', (filesChanged, filesPhrase) => {
    const report = reportFixture({
      changes: { files: [], fileCount: filesChanged, totals: { insertions: 5, deletions: 2, filesChanged }, emptyReason: null },
    });
    const strip = headerStripModel(reportFromTaskReportWire(report), summaryFixture(), TASK, NOW);
    const changes = strip.figureCells.find((cell) => cell.key === 'changes');
    expect(changes?.accessibilityLabel).toBe(`Changes: 5 lines added, 2 lines removed, ${filesPhrase}`);
  });

  it('ends the span at the archive time when the report knows its start but not its end', () => {
    const stillOpen = reportFixture({ endedAt: null });
    const strip = headerStripModel(reportFromTaskReportWire(stillOpen), summaryFixture(), TASK, NOW);
    expect(strip.spanCells.map((cell) => cell.key)).toEqual(['started', 'ended']);
    expect(cellValues(strip).ended).toBe(formatMonthDayTime(TASK.archived_at, NOW));
    // The report's 11:27:10 start (not the session's 11:30, which would read 3h 10m) to the 14:40 archive.
    expect(cellValues(strip).elapsed).toBe('3h 12m');
  });
});

describe('reportFromTaskKnowledge', () => {
  it('reads a missing summary as pending, since find_task cannot tell it from off', () => {
    const report = reportFromTaskKnowledge({ summaryText: null, commits: [], commitCount: 0, changedFiles: ['src/a.ts'], changedFileCount: 9 });
    expect(report.summaryState).toEqual({ kind: 'pending' });
    expect(report.files).toEqual([{ path: 'src/a.ts' }]);
    expect(report.fileCount).toBe(9);
    expect(report.route).toEqual([]);
  });

  it('says nothing about the summary when the desktop knew nothing at all', () => {
    expect(reportFromTaskKnowledge(null).summaryState).toBeNull();
  });
});

describe('reportFromTaskReportWire', () => {
  it('reads commits and files the index or git could not supply as none', () => {
    const report = reportFromTaskReportWire(reportFixture({ commits: null, commitCount: null, changes: null, changesError: 'git failed' }));
    expect(report.commits).toEqual([]);
    expect(report.commitCount).toBe(0);
    expect(report.files).toEqual([]);
    expect(report.totals).toBeNull();
  });
});
