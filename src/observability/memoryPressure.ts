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

export type MemoryPressureListener = () => void;

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
 */
export function subscribeToMemoryPressure(listener: MemoryPressureListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
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

function handleMemoryWarning(): void {
  warningCountThisLaunch += 1;
  recordBreadcrumb(Date.now());
  for (const listener of [...listeners]) {
    try {
      listener();
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
  appStateSubscription = AppState.addEventListener('memoryWarning', handleMemoryWarning);
  // Android's half. A no-op unsubscribe where the native module is absent, so
  // this needs no platform branch and no guard in the teardown below.
  removeAndroidListener = addAndroidMemoryPressureListener(() => handleMemoryWarning());
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
