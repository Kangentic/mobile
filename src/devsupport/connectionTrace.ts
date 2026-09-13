/**
 * A build-time-gated timeline of the connection lifecycle, for measuring
 * TWO things on a RELEASE build: the background-to-foreground reconnect,
 * and the cold-launch path from bundle entry through the trust anchor and
 * device identity reads to the first dial.
 *
 * The reconnect question it answers is "which window owns the wait":
 * AppState 'active' to the socket opening (a backoff remainder), to the
 * session establishing (the handshake), to the first board snapshot
 * (bootstrap). Those are three different fixes, and a dev client cannot
 * separate them (see performance-claims-are-measured.md). Read it with
 * `adb logcat -s ReactNativeJS` filtered on `connection-trace`.
 *
 * Gated exactly like the retention probe: `EXPO_PUBLIC_*` is inlined at
 * bundle time, so in a build that was not dispatched with the flag on every
 * function here returns on its first line and nothing is ever logged. Never
 * on in a store build. Read that precisely: the BODIES go dead, not the call
 * sites. A caller's argument object is built before the call, so
 * `traceConnection('close', { code, stateBefore })` still allocates. That is
 * a few primitive fields on paths that run once per socket close, board
 * snapshot, AppState transition or process-startup step - never per frame
 * or per render - so it is left alone deliberately. Keep it that way: do
 * not add a call site to a hot loop on the assumption the gate erases it.
 *
 * What it logs, deliberately: event names, transport states, relay close
 * codes, counts, coarse boolean state (`paired`, `cached`, `established`,
 * the keepalive flag) and millisecond deltas. Never content, never an
 * identifier. Sentry's console breadcrumbs are off (crash-reporting-scope.md),
 * so nothing here rides a crash report either way.
 *
 * A leaf module by design, and that is now load bearing TWICE over. It
 * imports nothing from the app, so src/channel/ can call it without creating
 * an import cycle; and it is the FIRST import in the bundle (see index.js),
 * so its own module evaluation is the cold-launch clock origin - which is why
 * the origin capture below is a bare module-scope statement rather than
 * something a caller triggers.
 *
 * DO NOT ADD AN IMPORT TO THIS FILE. Because it now hoists above
 * `react-native-get-random-values` in src/lib/cryptoPolyfills.ts, any import
 * added here that transitively reaches @kangentic/protocol or @noble/* would
 * evaluate crypto code before the Hermes polyfills install, and keygen throws
 * at cold launch - the exact failure cryptoPolyfills.ts's header exists to
 * prevent. tests/unit/bundleEntryOrder.test.ts pins both halves: this file's
 * import-freedom, and its position in index.js.
 */
const traceEnabled = process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE === '1';

export type ConnectionTraceField = string | number | boolean | null;

/**
 * React Native's native startup timing, narrowed from
 * `performance.rnStartupTiming`. Not part of RN's public TS types (it lives
 * under `react-native/src/private/webapis/performance/`), and every field
 * is individually nullable: `startTime`/`endTime` exist only if the native
 * host called `ReactMarker.setAppStartTime`. Nothing in this app's dependency
 * tree does - READ, not measured, from
 * `react-native/src/private/webapis/performance/ReactNativeStartupTiming.js`,
 * whose own comment for `startTime` names that marker as the source, plus a
 * grep for `setAppStartTime` across react-native, expo and expo-modules-core
 * that returns no caller. Still read the `startup-origin` log line to confirm
 * on a given host rather than trusting this note.
 *
 * All four fields are on React Native's MONOTONIC clock
 * (SystemClock.uptimeMillis() on Android, std::chrono::steady_clock in the
 * shared C++ timing code) - never Date.now()'s wall clock. Never subtract
 * one of these from a Date.now() value; see startupPerformanceNowMs below for
 * the one place a conversion is allowed.
 */
interface ReactNativeStartupTimingLike {
  startTime?: number;
  initializeRuntimeStart?: number;
  executeJavaScriptBundleEntryPointStart?: number;
  endTime?: number;
}

function readGlobalPerformance(): unknown {
  return (globalThis as { performance?: unknown }).performance;
}

function readRnStartupTiming(): ReactNativeStartupTimingLike | null {
  const performanceApi = readGlobalPerformance();
  if (performanceApi === null || typeof performanceApi !== 'object') return null;
  const rnStartupTiming = (performanceApi as { rnStartupTiming?: unknown }).rnStartupTiming;
  if (rnStartupTiming === null || typeof rnStartupTiming !== 'object') return null;
  return rnStartupTiming as ReactNativeStartupTimingLike;
}

function readPerformanceNowMs(): number | null {
  const performanceApi = readGlobalPerformance();
  if (performanceApi === null || typeof performanceApi !== 'object') return null;
  const now = (performanceApi as { now?: unknown }).now;
  if (typeof now !== 'function') return null;
  const result: unknown = (now as () => unknown).call(performanceApi);
  return typeof result === 'number' ? result : null;
}

/**
 * Captured once, at module evaluation. This module is the bundle's first
 * import (see index.js), so this instant IS the cold-launch clock origin.
 * `startupPerformanceNowMs` is the SAME instant on the monotonic clock, co-captured
 * so a native `rnStartupTiming` mark (also monotonic) can be converted into
 * "ms before this origin" without ever subtracting a monotonic value from a
 * Date.now() value - see emitStartupOriginOnce below.
 *
 * Guarded by `traceEnabled` so a store build calls neither `Date.now()` nor
 * `performance.now()` here: the ternary short-circuits before either runs.
 */
const startupOriginMs = traceEnabled ? Date.now() : 0;
const startupPerformanceNowMs = traceEnabled ? readPerformanceNowMs() : null;

let foregroundedAtMs: number | null = traceEnabled ? startupOriginMs : null;

/**
 * A one-way latch, flipped by the first markConnectionTraceForeground() and
 * never cleared. Deliberately a flag rather than the equivalent-looking
 * `foregroundedAtMs === startupOriginMs`, which overloads a timestamp as
 * state: a warm foreground landing in the same millisecond as module
 * evaluation writes back the value it is compared against, so that spelling
 * would keep reading "cold" after a foreground it was supposed to notice.
 * The latch asks the question directly - has a warm foreground happened yet -
 * independent of where the clock origin currently sits.
 *
 * What the latch does NOT change, because it is not a defect: a mid-launch
 * AppState 'active' (observed on 2 of the 5 cold runs measured for this, see
 * docs/developer-guide.md) flips it, so a later open on that same launch
 * reports cold=false. That transition is a real foreground and both spellings
 * report it identically. The thing worth knowing there is that the delta
 * origin moved, which markConnectionTraceForeground now announces with its
 * own `origin-rebased` line rather than leaving it to be inferred.
 */
let warmForegroundSeen = false;

let startupOriginLogged = false;

/** True only in a build dispatched with the trace flag on. */
export function connectionTraceEnabled(): boolean {
  return traceEnabled;
}

/**
 * True until the first AppState 'active' transition re-bases the origin via
 * markConnectionTraceForeground - i.e. true for the whole cold-launch path,
 * false once a warm foreground has occurred. Lets a call site record which
 * kind of open it ran on without threading a flag through every layer
 * between startConnectionLifecycle and here. Outside a trace build this is
 * always false: nothing is logged there, so there is no cold-launch state to
 * report, and a hard false is the same shape as foregroundKickEnabled's hard
 * true below.
 */
export function isColdLaunch(): boolean {
  return traceEnabled && !warmForegroundSeen;
}

/**
 * The A/B switch for the foreground kick (RelayTransport.redialNow), so the
 * before and after can be measured in ONE build on ONE install with the same
 * pairing, which is what performance-claims-are-measured.md asks of a
 * comparison. Only honoured in a trace build: everywhere else the kick is
 * simply on, and this collapses to `true`.
 */
let foregroundKickOn = true;
const kickListeners = new Set<() => void>();

export function foregroundKickEnabled(): boolean {
  return traceEnabled ? foregroundKickOn : true;
}

export function setForegroundKickEnabled(enabled: boolean): void {
  if (!traceEnabled || foregroundKickOn === enabled) return;
  foregroundKickOn = enabled;
  for (const listener of kickListeners) listener();
}

/** For a useSyncExternalStore subscription in the Settings switch. */
export function subscribeForegroundKick(listener: () => void): () => void {
  kickListeners.add(listener);
  return () => {
    kickListeners.delete(listener);
  };
}

/**
 * Marks the reference point every later `+<ms>` is measured from. Called on
 * the AppState 'active' transition, which is the moment the user is waiting
 * from. A cold launch already has an origin (startupOriginMs above); this
 * simply moves it forward on a warm foreground, exactly as before the
 * cold-launch origin existed.
 *
 * It emits `origin-rebased` FIRST, so that line's own `+<ms>` is measured
 * against the origin being retired. Without it, an origin reset is invisible:
 * every later `+<ms>` silently restarts from a new zero, and a reader has to
 * notice an adjacent `app-state-active` line to know it happened. That is not
 * hypothetical - on 2 of the 5 cold runs measured for this
 * (docs/developer-guide.md), Android delivered an 'active' transition
 * asynchronously mid-launch and reset the cold-launch deltas partway through.
 *
 * It carries no fields. This runs on EVERY foreground, not just the first, so
 * anything latch-derived would read the same by construction on all but one
 * of them; the line's whole job is "the origin moved here", and the adjacent
 * `app-state-active` already describes the transition itself.
 */
export function markConnectionTraceForeground(): void {
  if (!traceEnabled) return;
  traceConnection('origin-rebased');
  warmForegroundSeen = true;
  foregroundedAtMs = Date.now();
}

/**
 * Emitted once, lazily, from inside the first traceConnection call, so it
 * is always the first line in the log with no extra call site anywhere.
 * Its `+0ms` is literal - the origin instant, not the instant this line
 * happens to be flushed - so it is rendered through its own formatter
 * rather than traceConnection's normal delta.
 *
 * Fields, raw then derived, so the clock domain and any native fallback can
 * be read straight off the log rather than assumed:
 *  - rnStart / rnInitRuntime / rnRunJs / rnEnd: the four raw
 *    rnStartupTiming fields (monotonic clock; 'n/a' when unavailable).
 *  - perfNow / dateNow: the co-captured instant in each clock - the
 *    conversion anchor.
 *  - initRuntimeBeforeJsEntryMs / runJsBeforeJsEntryMs: derived,
 *    monotonic-only (rnInitRuntime/rnRunJs subtracted from perfNow, never
 *    from dateNow). 'n/a' when the corresponding raw field or perfNow
 *    itself is unavailable.
 * Reading the native-marker state off the log: `rnStart=n/a` means the field
 * is absent entirely, so `ReactMarker.setAppStartTime` was never called - the
 * case on this app's current dependency tree, and the reason the cold-launch
 * numbers lean on an external logcat control. `rnStart` present but equal to
 * `rnInitRuntime` would mean the marker exists but the earliest native mark is
 * still runtime init rather than process fork. Either way there is no in-app
 * signal before the bundle starts evaluating - see docs/developer-guide.md's
 * cold-launch section for what that means for the reported numbers.
 *
 * Wrapped defensively: this runs once per process in a trace build only,
 * and instrumentation must never be the thing that crashes a real launch.
 */
function emitStartupOriginOnce(): void {
  if (startupOriginLogged) return;
  startupOriginLogged = true;
  try {
    const rnStartupTiming = readRnStartupTiming();
    const rnStart = rnStartupTiming?.startTime;
    const rnInitRuntime = rnStartupTiming?.initializeRuntimeStart;
    const rnRunJs = rnStartupTiming?.executeJavaScriptBundleEntryPointStart;
    const rnEnd = rnStartupTiming?.endTime;
    const initRuntimeBeforeJsEntryMs =
      typeof rnInitRuntime === 'number' && startupPerformanceNowMs !== null ? startupPerformanceNowMs - rnInitRuntime : null;
    const runJsBeforeJsEntryMs =
      typeof rnRunJs === 'number' && startupPerformanceNowMs !== null ? startupPerformanceNowMs - rnRunJs : null;
    const fields: Record<string, ConnectionTraceField> = {
      origin: 'js-entry',
      rnStart: rnStart ?? 'n/a',
      rnInitRuntime: rnInitRuntime ?? 'n/a',
      rnRunJs: rnRunJs ?? 'n/a',
      rnEnd: rnEnd ?? 'n/a',
      perfNow: startupPerformanceNowMs ?? 'n/a',
      dateNow: startupOriginMs,
      initRuntimeBeforeJsEntryMs: initRuntimeBeforeJsEntryMs ?? 'n/a',
      runJsBeforeJsEntryMs: runJsBeforeJsEntryMs ?? 'n/a',
    };
    const rendered = Object.entries(fields)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(' ');
    console.log(`[connection-trace] startup-origin +0ms ${rendered}`);
  } catch {
    // Instrumentation must never be the reason a real launch fails; a
    // missing startup-origin line just means the cold-launch report falls
    // back to the logcat control (docs/developer-guide.md).
  }
}

export function traceConnection(event: string, fields?: Record<string, ConnectionTraceField>): void {
  if (!traceEnabled) return;
  emitStartupOriginOnce();
  const sinceForeground = foregroundedAtMs === null ? 'n/a' : `+${Date.now() - foregroundedAtMs}ms`;
  const rendered = fields
    ? Object.entries(fields)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')
    : '';
  console.log(`[connection-trace] ${event} ${sinceForeground} ${rendered}`.trimEnd());
}
