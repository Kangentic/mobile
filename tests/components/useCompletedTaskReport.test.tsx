import { act, renderHook } from '@testing-library/react-native';
import type { CompletedTaskReportOutcome } from '@/connection/taskReportActions';
import { useCompletedTaskReport } from '@/screens/completed/useCompletedTaskReport';
import { useChannelStore } from '@/state/channelStore';
import { reportFromTaskKnowledge, type CompletedTaskReport } from '@/taskReport/completedTaskReport';
import type { SummaryPhase } from '@/taskReport/summaryItems';

const mockFetchCompletedTaskReport = jest.fn<Promise<CompletedTaskReportOutcome>, [string, string]>();
jest.mock('@/connection/taskReportActions', () => ({
  fetchCompletedTaskReport: (projectId: string, taskId: string) => mockFetchCompletedTaskReport(projectId, taskId),
}));

const mockReportHandledError = jest.fn();
jest.mock('@/observability/crashReporting', () => ({
  reportHandledError: (site: string, error: unknown) => mockReportHandledError(site, error),
}));

/**
 * The hook's lifecycle, read through the hook alone (the screen's own wiring
 * is covered in CompletedTaskScreen.test.tsx). It reads once the channel is
 * up and keeps each answer tagged with the `projectId:taskId` it was read for,
 * so what it hands back is only ever an answer for the CURRENT ids. The
 * answers here are told apart by their summary text, and asserted by identity,
 * so a report returned for the wrong task cannot pass as the right one.
 */

interface ReportIds {
  projectId: string | null;
  taskId: string | null;
}

interface Deferred<Value> {
  promise: Promise<Value>;
  resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: (value: Value) => void = () => undefined;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function knowledgeReport(summaryText: string): CompletedTaskReport {
  return reportFromTaskKnowledge({ summaryText, commits: [], commitCount: 0, changedFiles: [], changedFileCount: 0 });
}

function readyOutcome(report: CompletedTaskReport): CompletedTaskReportOutcome {
  return { kind: 'ready', report };
}

/** The report a `ready` answer carries; throws for any other phase so a wrong phase fails loudly. */
function reportOf(phase: SummaryPhase): CompletedTaskReport {
  if (phase.phase !== 'ready') throw new Error(`expected a ready answer, got ${phase.phase}`);
  return phase.report;
}

const TASK_A: ReportIds = { projectId: 'project-1', taskId: 'task-A' };
const TASK_B: ReportIds = { projectId: 'project-1', taskId: 'task-B' };

async function renderReport(initialIds: ReportIds) {
  return renderHook((ids: ReportIds) => useCompletedTaskReport(ids.projectId, ids.taskId), { initialProps: initialIds });
}

async function setEstablished(established: boolean): Promise<void> {
  await act(async () => {
    useChannelStore.setState({ established });
  });
}

describe('useCompletedTaskReport', () => {
  let warnSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetchCompletedTaskReport.mockReset();
    useChannelStore.setState({ established: true });
    // __DEV__ is true under Jest, and an unavailable read logs a warning; silence it and keep it assertable.
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  /**
   * The bug this pins: the hook once kept a `landed` boolean and an untagged
   * answer, so after one task's report landed, new ids kept showing that
   * report and were never read at all.
   */
  it('reads again for new ids and shows loading, never the previous task\'s report, until that read lands', async () => {
    const reportA = knowledgeReport('Report for A');
    const reportB = knowledgeReport('Report for B');
    const readB = deferred<CompletedTaskReportOutcome>();
    mockFetchCompletedTaskReport.mockResolvedValueOnce(readyOutcome(reportA)).mockReturnValueOnce(readB.promise);

    const { result, rerender } = await renderReport(TASK_A);
    await act(async () => {});
    expect(reportOf(result.current)).toBe(reportA);

    await rerender(TASK_B);

    // Before B's read answers: loading, not A's report.
    expect(result.current).toEqual({ phase: 'loading' });
    expect(mockFetchCompletedTaskReport).toHaveBeenCalledTimes(2);
    expect(mockFetchCompletedTaskReport).toHaveBeenLastCalledWith('project-1', 'task-B');

    await act(async () => {
      readB.resolve(readyOutcome(reportB));
    });
    expect(reportOf(result.current)).toBe(reportB);
  });

  it('keys the answer by project as well as task', async () => {
    const reportFirstProject = knowledgeReport('First project');
    const reportSecondProject = knowledgeReport('Second project');
    const readSecond = deferred<CompletedTaskReportOutcome>();
    mockFetchCompletedTaskReport.mockResolvedValueOnce(readyOutcome(reportFirstProject)).mockReturnValueOnce(readSecond.promise);

    const { result, rerender } = await renderReport({ projectId: 'project-1', taskId: 'task-A' });
    await act(async () => {});
    expect(reportOf(result.current)).toBe(reportFirstProject);

    await rerender({ projectId: 'project-2', taskId: 'task-A' });
    expect(result.current).toEqual({ phase: 'loading' });
    expect(mockFetchCompletedTaskReport).toHaveBeenLastCalledWith('project-2', 'task-A');

    await act(async () => {
      readSecond.resolve(readyOutcome(reportSecondProject));
    });
    expect(reportOf(result.current)).toBe(reportSecondProject);
  });

  it('reads again when the channel comes back after a read that was unavailable', async () => {
    const refusal = new Error('both refused');
    const recovered = knowledgeReport('Recovered');
    mockFetchCompletedTaskReport.mockResolvedValueOnce({ kind: 'unavailable', error: refusal }).mockResolvedValueOnce(readyOutcome(recovered));

    const { result } = await renderReport(TASK_A);
    await act(async () => {});
    expect(result.current).toEqual({ phase: 'unavailable' });
    expect(mockReportHandledError).toHaveBeenCalledWith('completed-task-report', refusal);
    expect(mockFetchCompletedTaskReport).toHaveBeenCalledTimes(1);

    // Going down reads nothing; coming back up reads again.
    await setEstablished(false);
    expect(mockFetchCompletedTaskReport).toHaveBeenCalledTimes(1);
    await setEstablished(true);
    expect(mockFetchCompletedTaskReport).toHaveBeenCalledTimes(2);
    expect(mockFetchCompletedTaskReport).toHaveBeenLastCalledWith('project-1', 'task-A');
    expect(reportOf(result.current)).toBe(recovered);
  });

  it('does not read again when the channel comes back after a read that landed', async () => {
    const landed = knowledgeReport('Landed');
    mockFetchCompletedTaskReport.mockResolvedValue(readyOutcome(landed));

    const { result } = await renderReport(TASK_A);
    await act(async () => {});
    expect(reportOf(result.current)).toBe(landed);
    expect(mockFetchCompletedTaskReport).toHaveBeenCalledTimes(1);

    await setEstablished(false);
    await setEstablished(true);

    expect(mockFetchCompletedTaskReport).toHaveBeenCalledTimes(1);
    expect(reportOf(result.current)).toBe(landed);
  });

  it('stays loading and reads nothing while the channel is down, then reads once it is up', async () => {
    const report = knowledgeReport('After connecting');
    mockFetchCompletedTaskReport.mockResolvedValue(readyOutcome(report));
    useChannelStore.setState({ established: false });

    const { result } = await renderReport(TASK_A);
    await act(async () => {});
    expect(result.current).toEqual({ phase: 'loading' });
    expect(mockFetchCompletedTaskReport).not.toHaveBeenCalled();

    await setEstablished(true);
    expect(mockFetchCompletedTaskReport).toHaveBeenCalledTimes(1);
    expect(mockFetchCompletedTaskReport).toHaveBeenCalledWith('project-1', 'task-A');
    expect(reportOf(result.current)).toBe(report);
  });

  it.each([
    ['project id', { projectId: null, taskId: 'task-A' }],
    ['task id', { projectId: 'project-1', taskId: null }],
  ] as const)('stays loading and reads nothing without a %s', async (_missing, ids) => {
    mockFetchCompletedTaskReport.mockResolvedValue(readyOutcome(knowledgeReport('Unexpected')));

    const { result } = await renderReport(ids);
    await act(async () => {});

    expect(result.current).toEqual({ phase: 'loading' });
    expect(mockFetchCompletedTaskReport).not.toHaveBeenCalled();
  });

  /**
   * React 18+ no longer warns on a state update after unmount, so a missing
   * cancel guard is silent as a warning. It shows as the side effects that
   * run before the state update: a handled-error report and a dev warning for
   * a screen that is already gone.
   */
  it('drops a read that resolves unavailable after the hook unmounts: nothing reported, nothing logged', async () => {
    const pendingRead = deferred<CompletedTaskReportOutcome>();
    mockFetchCompletedTaskReport.mockReturnValueOnce(pendingRead.promise);

    const { unmount } = await renderReport(TASK_A);
    expect(mockFetchCompletedTaskReport).toHaveBeenCalledTimes(1);
    await unmount();

    await act(async () => {
      pendingRead.resolve({ kind: 'unavailable', error: new Error('answered after unmount') });
    });

    expect(mockReportHandledError).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it('drops a read for the previous ids that resolves unavailable after the ids changed', async () => {
    const staleRead = deferred<CompletedTaskReportOutcome>();
    const reportB = knowledgeReport('Report for B');
    mockFetchCompletedTaskReport.mockReturnValueOnce(staleRead.promise).mockResolvedValueOnce(readyOutcome(reportB));

    const { result, rerender } = await renderReport(TASK_A);
    await rerender(TASK_B);
    await act(async () => {});
    expect(reportOf(result.current)).toBe(reportB);

    await act(async () => {
      staleRead.resolve({ kind: 'unavailable', error: new Error('answered after the ids changed') });
    });

    expect(mockReportHandledError).not.toHaveBeenCalled();
    expect(warnSpy).not.toHaveBeenCalled();
    expect(reportOf(result.current)).toBe(reportB);
  });
});
