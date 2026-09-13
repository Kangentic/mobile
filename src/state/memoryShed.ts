import { subscribeToMemoryPressure } from '@/observability/memoryPressure';
import { useBoardStore } from './boardStore';
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
 * SHEDS ON `serious` OR `backgrounded`, and skips `moderate`. The threshold is
 * chosen so the user never watches content they are reading get refetched:
 *
 * - `backgrounded` (Android `TRIM_MEMORY_UI_HIDDEN` / `TRIM_MEMORY_BACKGROUND`)
 *   is the safest possible moment to shed, because the app is off screen, and
 *   from Android 14 it is the ONLY signal the system still delivers. Android's
 *   own guidance for these two is to aggressively release whatever can be
 *   reconstructed when the user returns, which is exactly this module's
 *   contract.
 * - `moderate` means "beginning to run low" while the app is in the FOREGROUND
 *   and reaches only pre-Android-14 devices. Shedding there would drop a
 *   transcript mid-scroll on a device that was merely busy. "Reconstructible"
 *   is a statement about correctness, not about the experience of watching it
 *   happen.
 * - `serious` is a real shortage, foreground or not, and is what iOS's single
 *   memory warning maps to. Shedding beats being killed.
 *
 * Scope, stated plainly: this is a robustness measure, not a proven cure for
 * Sentry MOBILE-8. A fast allocation spike can be killed with one warning and
 * no useful window, or with none at all. What it reliably does is stop the app
 * ignoring a signal it was previously deaf to.
 */
export function registerMemoryShedders(): () => void {
  return subscribeToMemoryPressure((severity) => {
    if (severity === 'moderate') return;
    useTranscriptStore.getState().shedBackgroundTranscripts();
    shedUnwatchedTerminalRings();
    // The archive is the largest reconstructible thing held: rows carry full
    // task descriptions, which measure ~7 KB on average against real boards.
    useBoardStore.getState().shedArchivedPages();
  });
}
