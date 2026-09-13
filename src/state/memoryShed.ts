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
 * Scope, stated plainly: this is a robustness measure, not a proven cure for
 * Sentry MOBILE-8. A fast allocation spike can be killed with one warning and
 * no useful window, or with none at all. What it reliably does is stop the app
 * ignoring a signal it was previously deaf to.
 */
export function registerMemoryShedders(): () => void {
  return subscribeToMemoryPressure(() => {
    useTranscriptStore.getState().shedBackgroundTranscripts();
    shedUnwatchedTerminalRings();
  });
}
