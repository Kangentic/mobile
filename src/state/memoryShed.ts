import { subscribeToMemoryPressure } from '@/observability/memoryPressure';
import { useTranscriptStore } from './transcriptStore';
import { shedUnwatchedTerminalRings } from './terminalFeed';

/**
 * What the app releases when the OS says it is short of memory.
 *
 * The stores own their own shedding policy (`shedBackgroundTranscripts`,
 * `shedUnwatchedTerminalRings`); this module only says WHEN. It lives in
 * `src/state/` rather than in `src/observability/` so the reporting layer does
 * not acquire a dependency on application state, and rather than in
 * `src/connection/` because that directory may not import the observability
 * door at all (`.claude/rules/crash-reporting-scope.md`).
 *
 * Everything shed here is reconstructible from the desktop - a transcript
 * window refetches on mount, a terminal ring re-seeds on the next read-stream
 * subscribe - so the cost is a round trip, never content and never user input.
 * Both are idempotent, which matters because listeners fire on every warning
 * rather than only on the ones that get a breadcrumb.
 *
 * SERIOUS PRESSURE ONLY, and the threshold is the point. Android's
 * `TRIM_MEMORY_RUNNING_MODERATE` means "beginning to run low" and arrives on an
 * ordinary busy device; shedding there would drop a transcript the user is
 * about to scroll back through and refetch it in front of them, repeatedly, on
 * a device that was never actually in trouble. "Reconstructible" is a statement
 * about correctness, not about the experience of watching it happen. iOS has no
 * moderate level - its single notification means the app is close to being
 * killed - so nothing is lost there by drawing the line here.
 *
 * Scope, stated plainly: this is a robustness measure, not a proven cure for
 * Sentry MOBILE-8. A fast allocation spike can be killed with one warning and
 * no useful window, or with none at all. What it reliably does is stop the app
 * ignoring a signal it was previously deaf to.
 */
export function registerMemoryShedders(): () => void {
  return subscribeToMemoryPressure((severity) => {
    if (severity !== 'serious') return;
    useTranscriptStore.getState().shedBackgroundTranscripts();
    shedUnwatchedTerminalRings();
  });
}
