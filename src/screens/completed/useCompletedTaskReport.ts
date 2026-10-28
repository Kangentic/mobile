import { useEffect, useRef, useState } from 'react';
import { fetchCompletedTaskReport } from '@/connection/taskReportActions';
import { reportHandledError } from '@/observability/crashReporting';
import { useChannelStore } from '@/state/channelStore';
import type { SummaryPhase } from '@/taskReport/summaryItems';

/** One object, so a render that reads no answer yet hands the Summary's memo the same value. */
const LOADING: SummaryPhase = { phase: 'loading' };

/**
 * A completed task's report, read once the channel is up. It stays `loading`
 * while the phone is still connecting rather than showing a failure it would
 * take back a second later. A read that failed is tried again when the
 * channel next comes up; a read that landed is not repeated.
 *
 * The answer is kept with the task it was read for, so new ids read again and
 * show `loading` until they do, never the previous task's report.
 *
 * When neither the report nor its `find_task` fallback answers, the Summary
 * shows the phone's own figures and says the record could not be read. That
 * looks enough like a task with nothing to report that it goes through the
 * handled-error door, which drops a lost channel by name; a refusal that the
 * fallback recovered from is not reported at all.
 */
export function useCompletedTaskReport(projectId: string | null, taskId: string | null): SummaryPhase {
  const established = useChannelStore((state) => state.established);
  const readKey = projectId !== null && taskId !== null ? `${projectId}:${taskId}` : null;
  const [answer, setAnswer] = useState<{ readKey: string; phase: SummaryPhase } | null>(null);
  const landedKeyRef = useRef<string | null>(null);

  useEffect(() => {
    if (projectId === null || taskId === null || readKey === null || !established) return;
    if (landedKeyRef.current === readKey) return;
    let cancelled = false;
    void fetchCompletedTaskReport(projectId, taskId).then((outcome) => {
      if (cancelled) return;
      if (outcome.kind === 'ready') {
        landedKeyRef.current = readKey;
        setAnswer({ readKey, phase: { phase: 'ready', report: outcome.report } });
        return;
      }
      reportHandledError('completed-task-report', outcome.error);
      if (__DEV__) console.warn('[completed-task] report unavailable:', outcome.error);
      setAnswer({ readKey, phase: { phase: 'unavailable' } });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, taskId, readKey, established]);

  return answer !== null && answer.readKey === readKey ? answer.phase : LOADING;
}
