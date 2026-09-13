import * as Sentry from '@sentry/react-native';
import { AppState, type NativeEventSubscription } from 'react-native';
import { addAndroidMemoryPressureListener } from '../../modules/memory-pressure';
import { isCrashReportingInitialized } from './crashReporting';
import { MEMORY_PRESSURE_BREADCRUMB_CATEGORY } from './scrubEvent';

/**
 * Memory pressure: see it, and let the rest of the app act on it.
 *
 * WHY THIS EXISTS. iOS delivers `UIApplicationDidReceiveMemoryWarning` before
 * jetsam kills a foreground app, and this app ignored it completely - it
 * neither recorded the warning nor released anything. That is the blind spot
 * behind Sentry MOBILE-8, a foreground `WatchdogTermination` that no evidence
 * could be brought to bear on: sentry-cocoa's own
 * `SentrySystemEventBreadcrumbs` observes keyboard, screenshot, battery,
 * orientation, timezone and time-change notifications, and NOT the memory
 * warning, so on iOS there is simply no record that pressure did or did not
 * occur. Nothing was missing from the report; the signal was never collected.
 *
 * WHY A BREADCRUMB, AND NOT A TAG OR CONTEXT. A watchdog termination is
 * inferred on the NEXT launch, so the only scope data that can reach it is
 * whatever the previous session persisted. Breadcrumbs are that data, and the
 * path is verified end to end in sentry-cocoa 8.58.0 rather than assumed:
 * `RNSentry.addBreadcrumb` writes to the real `SentryScope`; scope observers
 * include `SentryWatchdogTerminationScopeObserver`, which forwards to a
 * processor that serializes and appends to disk IMMEDIATELY (no batching, so a
 * fast kill cannot lose it); and `SentryWatchdogTerminationTracker` builds its
 * event with `event.serializedBreadcrumbs = [fileManager
 * readPreviousBreadcrumbs]` after explicitly clearing the current scope's. So
 * the next such event self-identifies: a trail carrying memory warnings is an
 * out-of-memory kill, and one without is a hang or a user force-quit.
 *
 * NO USER CONTENT LEAVES HERE, and no third capture call is added. The
 * breadcrumb is a bare signal plus a count;
 * `.claude/rules/crash-reporting-scope.md`'s "exactly two capture calls"
 * invariant is about captured EVENTS and is untouched. `captureMessage` on
 * pressure was considered and rejected: it would be a third capture call, and
 * a device under real pressure would fire it repeatedly into a 5,000
 * events/month budget.
 *
 * TWO SOURCES, ONE SIGNAL. React Native's `RCTAppState.mm` observes the iOS
 * notification and emits `memoryWarning`, but the Android `AppStateModule`
 * never emits that event at all: Android's equivalent is
 * `ComponentCallbacks2.onTrimMemory`, which React Native does not surface. So
 * Android comes from the local Expo module in `modules/memory-pressure`, which
 * registers the callback on the APPLICATION context and forwards only the
 * levels that actually mean pressure (`TRIM_MEMORY_UI_HIDDEN` arrives on every
 * backgrounding and is excluded - see that module for why forwarding it would
 * poison this breadcrumb rather than enrich it).
 *
 * The two never both fire: the module is Android-only and `AppState`'s event is
 * iOS-only in practice, so a single episode cannot be counted twice. Everything
 * below this point is platform-neutral and does not know which source spoke.
 */

/**
 * The shortest gap between two recorded breadcrumbs.
 *
 * iOS can deliver warnings in a burst, and the persisted breadcrumb file
 * rotates every `maxBreadcrumbs` (20 for this app). Uncoalesced, a burst would
 * evict the `ui.lifecycle` trail that says where the user was - the
 * instrumentation would degrade the very diagnostic it exists to produce.
 *
 * Coalesced on the LEADING edge, which matters more than it looks: a trailing
 * summary would be the obvious design and is wrong here, because the episode
 * this is built to describe can end with the process being killed, and a
 * breadcrumb still waiting on a timer at that moment is a breadcrumb that
 * never existed. The first warning of an episode is recorded at once; the
 * count it carries is cumulative for the launch, so a suppressed burst is
 * still legible in the next breadcrumb that does get through.
 */
export const MEMORY_PRESSURE_COALESCE_MS = 10_000;

/**
 * How urgent the OS says the shortage is.
 *
 * Android reports gradations and iOS reports one bare notification, so this is
 * the smallest vocabulary that does not throw away the Android detail or
 * invent iOS detail that does not exist:
 *
 * - `moderate` is Android's `TRIM_MEMORY_RUNNING_MODERATE`, which means "the
 *   device is BEGINNING to run low". It is advisory and can arrive on an
 *   ordinary busy device.
 * - `serious` is everything else forwarded, and it is what iOS's single
 *   `memoryWarning` maps to. iOS only sends that notification when the app is
 *   genuinely close to being killed, so treating it as anything milder would
 *   understate the one platform the MOBILE-8 report came from.
 *
 * WHY THIS EXISTS AT ALL. The Android source was added carrying the trim level
 * and the JS boundary then discarded it, so a mild `RUNNING_MODERATE` triggered
 * exactly the same aggressive shed as a critical one. That is invisible on iOS,
 * which has no gradations, and on Android it means dropping transcripts and
 * terminal rings on a device that is merely busy - the user then watches
 * content they were reading get refetched. Consumers choose per severity now.
 */
export type MemoryPressureSeverity = 'moderate' | 'serious';

export type MemoryPressureListener = (severity: MemoryPressureSeverity) => void;

const listeners = new Set<MemoryPressureListener>();
let appStateSubscription: NativeEventSubscription | null = null;
let removeAndroidListener: (() => void) | null = null;
let warningCountThisLaunch = 0;
let lastRecordedAtMs: number | null = null;

/**
 * Registers a reaction to memory pressure.
 *
 * Exists so that directories which may not import the Sentry SDK at all
 * (`src/connection/`, `src/channel/`, and the rest of the ban list in
 * `.claude/rules/crash-reporting-scope.md`) can still shed memory when the OS
 * asks. They depend on this plain callback, never on the reporting half.
 *
 * Listeners fire on EVERY warning, not only the ones that get a breadcrumb:
 * the coalescing above is about not flooding a 20-entry breadcrumb buffer, and
 * has nothing to do with how often it is worth releasing memory. A listener
 * must therefore be idempotent and cheap - one that has nothing left to
 * release should do nothing rather than rebuild anything.
 *
 * Every listener receives the severity and decides for itself, rather than
 * this module filtering. The right threshold depends on what the reaction
 * COSTS: dropping a cached snippet warm is free and worth doing early, while
 * dropping a transcript the user may scroll back to is not.
 */
export function subscribeToMemoryPressure(listener: MemoryPressureListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * `TRIM_MEMORY_RUNNING_MODERATE` is 5. Everything else the native module
 * forwards (RUNNING_LOW 10, RUNNING_CRITICAL 15, MODERATE 60, COMPLETE 80) is
 * a real shortage. The constant is spelled here rather than imported because
 * the module's own filter is the thing that decides what arrives at all, and
 * duplicating its whole table would let the two drift apart silently; this only
 * needs to know where "advisory" ends.
 */
const TRIM_MEMORY_RUNNING_MODERATE = 5;

function severityForTrimLevel(level: number): MemoryPressureSeverity {
  return level === TRIM_MEMORY_RUNNING_MODERATE ? 'moderate' : 'serious';
}

function recordBreadcrumb(nowMs: number): void {
  if (!isCrashReportingInitialized()) return;
  if (lastRecordedAtMs !== null && nowMs - lastRecordedAtMs < MEMORY_PRESSURE_COALESCE_MS) return;
  lastRecordedAtMs = nowMs;
  Sentry.addBreadcrumb({
    category: MEMORY_PRESSURE_BREADCRUMB_CATEGORY,
    type: 'system',
    level: 'warning',
    message: 'os memory warning',
    // A count and nothing else. Not a byte figure: there is no JS-reachable
    // way to read the process footprint on iOS, and a fabricated one would be
    // worse than none.
    data: { count: warningCountThisLaunch },
  });
}

/**
 * The breadcrumb counts EVERY pressure signal, moderate included, and carries
 * no severity of its own. Two reasons: the payload is a bare count by design
 * (`.claude/rules/crash-reporting-scope.md` enumerates it that way, and adding
 * a field would be a disclosure change), and for the diagnostic question the
 * breadcrumb exists to answer - was this launch under memory pressure before
 * the OS killed it - a moderate warning is evidence too.
 */
function handleMemoryWarning(severity: MemoryPressureSeverity): void {
  warningCountThisLaunch += 1;
  recordBreadcrumb(Date.now());
  for (const listener of [...listeners]) {
    try {
      listener(severity);
    } catch {
      // A listener that throws must not stop the others from shedding, and
      // must not cascade into the reporting path either.
    }
  }
}

/**
 * Arms the listener. Called from `index.js` at bundle entry, immediately after
 * `initializeCrashReporting()`.
 *
 * As early as possible on purpose: the MOBILE-8 episode fit inside about 23
 * seconds of launch, so a listener that only armed once a screen mounted could
 * miss the whole thing. After crash reporting because the breadcrumb needs the
 * SDK up - but note this does NOT no-op without a DSN, unlike its neighbour.
 * The shedding half is a robustness feature that a build from source (which
 * has no DSN and reports nothing) should still get.
 */
export function initializeMemoryPressure(): void {
  if (appStateSubscription !== null) return;
  // iOS sends this only when the app is close to being killed, so it is always
  // 'serious'. There is no milder iOS notification to map.
  appStateSubscription = AppState.addEventListener('memoryWarning', () => handleMemoryWarning('serious'));
  // Android's half. A no-op unsubscribe where the native module is absent, so
  // this needs no platform branch and no guard in the teardown below.
  removeAndroidListener = addAndroidMemoryPressureListener((level) => handleMemoryWarning(severityForTrimLevel(level)));
}

/**
 * Tears both sources down. Exists for tests: nothing in the app calls it,
 * because the listener is armed at bundle entry and should outlive every screen.
 */
export function shutdownMemoryPressure(): void {
  appStateSubscription?.remove();
  appStateSubscription = null;
  removeAndroidListener?.();
  removeAndroidListener = null;
}
