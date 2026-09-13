/**
 * A build-time-gated timeline of the connection lifecycle, for measuring the
 * background-to-foreground reconnect on a RELEASE build.
 *
 * The question it answers is "which window owns the wait": AppState 'active'
 * to the socket opening (a backoff remainder), to the session establishing
 * (the handshake), to the first board snapshot (bootstrap). Those are three
 * different fixes, and a dev client cannot separate them (see
 * performance-claims-are-measured.md). Read it with
 * `adb logcat -s ReactNativeJS` filtered on `connection-trace`.
 *
 * Gated exactly like the retention probe: `EXPO_PUBLIC_*` is inlined at
 * bundle time, so in a build that was not dispatched with the flag on every
 * function here returns on its first line and nothing is ever logged. Never
 * on in a store build. Read that precisely: the BODIES go dead, not the call
 * sites. A caller's argument object is built before the call, so
 * `traceConnection('close', { code, stateBefore })` still allocates. That is
 * a few primitive fields on paths that run once per socket close, board
 * snapshot or AppState transition - never per frame or per render - so it is
 * left alone deliberately. Keep it that way: do not add a call site to a
 * hot loop on the assumption the gate erases it.
 *
 * What it logs, deliberately: event names, transport states, relay close
 * codes, counts and millisecond deltas. Never content, never an identifier.
 * Sentry's console breadcrumbs are off (crash-reporting-scope.md), so nothing
 * here rides a crash report either way.
 *
 * A leaf module by design: it imports nothing from the app, so
 * src/channel/ can call it without creating an import cycle.
 */
const traceEnabled = process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE === '1';

export type ConnectionTraceField = string | number | boolean | null;

let foregroundedAtMs: number | null = null;

/** True only in a build dispatched with the trace flag on. */
export function connectionTraceEnabled(): boolean {
  return traceEnabled;
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
 * from.
 */
export function markConnectionTraceForeground(): void {
  if (!traceEnabled) return;
  foregroundedAtMs = Date.now();
}

export function traceConnection(event: string, fields?: Record<string, ConnectionTraceField>): void {
  if (!traceEnabled) return;
  const sinceForeground = foregroundedAtMs === null ? 'n/a' : `+${Date.now() - foregroundedAtMs}ms`;
  const rendered = fields
    ? Object.entries(fields)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(' ')
    : '';
  console.log(`[connection-trace] ${event} ${sinceForeground} ${rendered}`.trimEnd());
}
