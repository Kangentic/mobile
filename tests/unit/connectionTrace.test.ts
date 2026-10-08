/**
 * connectionTrace's build gate, in the state every shipped build ships in:
 * EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE unset.
 *
 * `traceEnabled` is captured once at module evaluation time from
 * process.env, so each test clears the env var and resets the module
 * registry before a fresh dynamic import, rather than relying on import
 * order across files to keep the flag unset.
 *
 * The ON-path branches (a real trace build) are mostly NOT covered here -
 * they are dev-only instrumentation with no correctness consequence for a
 * shipped build. What matters in production is this file: if the OFF path
 * ever stopped being a hard floor, the whole foreground-reconnect fix (board
 * task #70 - RelayTransport.redialNow, connectionManager's kick and probe)
 * would be silently disabled in every shipped build, with nothing else in
 * the suite positioned to notice.
 *
 * Two ON-path behaviors ARE covered, in their own file
 * (tests/unit/connectionTraceOnPath.test.ts) rather than here, so the trace
 * flag never coexists with this file's OFF-path assumption in the same
 * module registry: markConnectionTraceForeground's `origin-rebased` line,
 * and the warmForegroundSeen latch isColdLaunch() reads. The
 * `vi.resetModules()` pattern below turned out to work fine for that; see
 * that file for why it was worth doing there and not everywhere.
 *
 * A third ON-path surface IS covered here, in the second describe at the
 * bottom: the two MOBILE-3 probe switches' setters, getters and shared
 * listener set. Unlike the two behaviors above it has a correctness
 * consequence, because the Settings switches and connectionManager read it, so
 * the hard-true OFF-path tests alone left every ON-path half unpinned. That
 * describe sets the trace flag in its own beforeEach and clears it in its own
 * afterEach, so the flag never reaches the OFF-path tests above it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('connectionTrace (non-trace build)', () => {
  /**
   * Mutation seen failing: changing `connectionTraceEnabled` to
   * `return true;` made this read `true` instead of `false`.
   */
  it('connectionTraceEnabled is false when the trace flag is unset', async () => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE;
    vi.resetModules();
    const { connectionTraceEnabled } = await import('@/devsupport/connectionTrace');

    expect(connectionTraceEnabled()).toBe(false);
  });

  /**
   * The assertion that matters most in this file: foregroundKickEnabled() is
   * a hard TRUE in a non-trace build, and setForegroundKickEnabled(false)
   * cannot move it. Two independent gates protect this today (the ternary
   * inside foregroundKickEnabled, and the `!traceEnabled ||` early return
   * inside setForegroundKickEnabled), so removing either ALONE still leaves
   * this green - that is defense in depth, not a hole in the test. Removing
   * BOTH is what turns it red, the same shape as the "stale ceiling timer"
   * test in connectionManagerKeepalive.test.ts.
   *
   * Mutation seen failing: collapsing `foregroundKickEnabled` to
   * `return foregroundKickOn;` and dropping the `!traceEnabled ||` clause
   * from `setForegroundKickEnabled`'s guard made `foregroundKickEnabled()`
   * read `false` after `setForegroundKickEnabled(false)` -
   * "expected false to be true".
   */
  it('foregroundKickEnabled defaults to true when the trace flag is unset, and setForegroundKickEnabled cannot turn it off', async () => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE;
    vi.resetModules();
    const { foregroundKickEnabled, setForegroundKickEnabled } = await import('@/devsupport/connectionTrace');

    expect(foregroundKickEnabled()).toBe(true);

    setForegroundKickEnabled(false);

    expect(foregroundKickEnabled()).toBe(true);
  });

  /**
   * The two MOBILE-3 probe switches, under the same bar as the kick above. If
   * either could read false in a store build, it would ship with a keepalive
   * bound turned off: the JS ceiling, or the native stop alarm that is the
   * only bound left when JS is not running.
   *
   * Two gates guard each switch, as for the kick, so only removing both turns
   * a test red. That is defense in depth, not a hole in the test.
   *
   * Mutation seen failing: collapsing each getter to return its bare flag and
   * dropping `!traceEnabled ||` from each setter made both tests read "expected
   * false to be true".
   */
  it('keepaliveCeilingEnabled is a hard true when the trace flag is unset', async () => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE;
    vi.resetModules();
    const { keepaliveCeilingEnabled, setKeepaliveCeilingEnabled } = await import('@/devsupport/connectionTrace');

    expect(keepaliveCeilingEnabled()).toBe(true);

    setKeepaliveCeilingEnabled(false);

    expect(keepaliveCeilingEnabled()).toBe(true);
  });

  it('nativeStopAlarmEnabled is a hard true when the trace flag is unset', async () => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE;
    vi.resetModules();
    const { nativeStopAlarmEnabled, setNativeStopAlarmEnabled } = await import('@/devsupport/connectionTrace');

    expect(nativeStopAlarmEnabled()).toBe(true);

    setNativeStopAlarmEnabled(false);

    expect(nativeStopAlarmEnabled()).toBe(true);
  });

  /**
   * Task #109's two switches, under the same bar. Either reading false in a
   * store build would ship a fix turned off: the phone dropping every desktop
   * frame sealed before a rekey reached it, or the foreground probe tearing
   * down a socket that is visibly carrying traffic.
   *
   * Mutation seen failing: collapsing each getter to return its bare flag and
   * dropping `!traceEnabled ||` from each setter made both read "expected
   * false to be true".
   */
  it('retiredReceiveStreamsEnabled and frameLivenessEnabled are a hard true when the trace flag is unset', async () => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE;
    vi.resetModules();
    const { frameLivenessEnabled, retiredReceiveStreamsEnabled, setFrameLivenessEnabled, setRetiredReceiveStreamsEnabled } =
      await import('@/devsupport/connectionTrace');

    expect(retiredReceiveStreamsEnabled()).toBe(true);
    expect(frameLivenessEnabled()).toBe(true);

    setRetiredReceiveStreamsEnabled(false);
    setFrameLivenessEnabled(false);

    expect(retiredReceiveStreamsEnabled()).toBe(true);
    expect(frameLivenessEnabled()).toBe(true);
  });

  /**
   * Mutation seen failing: deleting `if (!traceEnabled) return;` from
   * traceConnection made it call console.log even in a non-trace build -
   * "expected "log" to not be called at all, but actually been called 2
   * times". Also covers the lazy one-shot `startup-origin` line
   * (emitStartupOriginOnce, called from inside traceConnection): it sits
   * behind the same early return, so a call that never logs `probe-start`
   * or `probe-failed` never logs `startup-origin` either.
   */
  it('traceConnection logs nothing when the trace flag is unset', async () => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE;
    vi.resetModules();
    const { traceConnection } = await import('@/devsupport/connectionTrace');
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    try {
      traceConnection('probe-start');
      traceConnection('probe-failed', { ms: 12, timedOut: true, stale: false });

      expect(consoleLogSpy).not.toHaveBeenCalled();
    } finally {
      consoleLogSpy.mockRestore();
    }
  });

  /**
   * Guards the module-scope cold-launch origin capture. `startupOriginMs`
   * and `startupPerfNowMs` are meant to be inert in a non-trace build, so
   * neither clock should be read at all merely by importing the module -
   * this is what a shipped store build actually does on every cold launch.
   *
   * BOTH clocks are asserted, because the docstring claims both: spying only
   * Date.now left `startupPerformanceNowMs = traceEnabled ? ... : null` free
   * to become an unconditional call with the test still green.
   *
   * Mutation seen failing: changing
   * `const startupOriginMs = traceEnabled ? Date.now() : 0;` to
   * `const startupOriginMs = Date.now();` made this fail - "expected "now"
   * to not be called at all, but actually been called 1 times". Separately,
   * changing
   * `const startupPerformanceNowMs = traceEnabled ? readPerformanceNowMs() : null;`
   * to `const startupPerformanceNowMs = readPerformanceNowMs();` made the
   * performance.now assertion fail the same way, and left the Date.now one
   * green - which is the hole this second spy closes.
   */
  it('reads neither clock at module evaluation when the trace flag is unset', async () => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE;
    vi.resetModules();
    const dateNowSpy = vi.spyOn(Date, 'now');
    const performanceNowSpy = vi.spyOn(globalThis.performance, 'now');

    try {
      await import('@/devsupport/connectionTrace');

      expect(dateNowSpy).not.toHaveBeenCalled();
      expect(performanceNowSpy).not.toHaveBeenCalled();
    } finally {
      dateNowSpy.mockRestore();
      performanceNowSpy.mockRestore();
    }
  });

  /**
   * isColdLaunch() is a hard FALSE in a non-trace build, the same shape as
   * foregroundKickEnabled's hard TRUE above.
   *
   * Scope, stated so it is not mistaken for more than it is: this pins ONLY
   * the non-trace hard-false. It cannot distinguish the real implementation
   * from `return traceEnabled;`, because that is already false here - the
   * warmForegroundSeen latch's ON-path behaviour is instead pinned in
   * tests/unit/connectionTraceOnPath.test.ts, which mutates `isColdLaunch` to
   * exactly `return traceEnabled;` and watches it fail.
   *
   * Mutation seen failing: changing `isColdLaunch` to `return true;` made
   * this read `true` instead of `false`.
   */
  it('isColdLaunch is false when the trace flag is unset', async () => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE;
    vi.resetModules();
    const { isColdLaunch } = await import('@/devsupport/connectionTrace');

    expect(isColdLaunch()).toBe(false);
  });
});

/**
 * The two MOBILE-3 probe switches in a real trace build
 * (EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE=1), where they are live. The describe
 * above only ever sees the hard-true floor, which holds whether or not the
 * switches work at all: a setter that assigned nothing, or a subscribe that
 * never registered, passes every one of those. These pin the other half.
 *
 * `traceEnabled` is read once at module evaluation, so each test sets the flag,
 * resets the module registry, and imports fresh. The flag is cleared in
 * afterEach so it cannot leak into a test that expects the OFF path.
 */
describe('connectionTrace (trace build, MOBILE-3 probe switches)', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE = '1';
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE;
    vi.resetModules();
  });

  async function importTraceBuild(): Promise<typeof import('@/devsupport/connectionTrace')> {
    vi.resetModules();
    return import('@/devsupport/connectionTrace');
  }

  /**
   * Both switches default to on, so the first assertion pairs are the
   * "nothing moved yet" baseline that makes the flip below mean something.
   *
   * Mutation seen failing: changing `keepaliveCeilingOn = enabled;` in
   * setKeepaliveCeilingEnabled to `keepaliveCeilingOn = keepaliveCeilingOn;`
   * left the getter reading `true` after `setKeepaliveCeilingEnabled(false)` -
   * "expected true to be false". The "only its own" half is separate: changing
   * that line to `keepaliveCeilingOn = nativeStopAlarmOn = enabled;` moves the
   * ceiling correctly and then fails on the other switch - "expected false to
   * be true" at `expect(nativeStopAlarmEnabled()).toBe(true)`.
   */
  it('setKeepaliveCeilingEnabled moves keepaliveCeilingEnabled and leaves nativeStopAlarmEnabled alone', async () => {
    const { keepaliveCeilingEnabled, nativeStopAlarmEnabled, setKeepaliveCeilingEnabled } = await importTraceBuild();

    expect(keepaliveCeilingEnabled()).toBe(true);
    expect(nativeStopAlarmEnabled()).toBe(true);

    setKeepaliveCeilingEnabled(false);

    expect(keepaliveCeilingEnabled()).toBe(false);
    expect(nativeStopAlarmEnabled()).toBe(true);

    setKeepaliveCeilingEnabled(true);

    expect(keepaliveCeilingEnabled()).toBe(true);
  });

  /**
   * The mirror of the test above, because each setter is its own copy of the
   * same four lines and a mistake in one says nothing about the other.
   *
   * Mutation seen failing: changing `nativeStopAlarmOn = enabled;` in
   * setNativeStopAlarmEnabled to `nativeStopAlarmOn = nativeStopAlarmOn;` left
   * the getter reading `true` after `setNativeStopAlarmEnabled(false)` -
   * "expected true to be false".
   */
  it('setNativeStopAlarmEnabled moves nativeStopAlarmEnabled and leaves keepaliveCeilingEnabled alone', async () => {
    const { keepaliveCeilingEnabled, nativeStopAlarmEnabled, setNativeStopAlarmEnabled } = await importTraceBuild();

    expect(keepaliveCeilingEnabled()).toBe(true);
    expect(nativeStopAlarmEnabled()).toBe(true);

    setNativeStopAlarmEnabled(false);

    expect(nativeStopAlarmEnabled()).toBe(false);
    expect(keepaliveCeilingEnabled()).toBe(true);

    setNativeStopAlarmEnabled(true);

    expect(nativeStopAlarmEnabled()).toBe(true);
  });

  /**
   * One listener set serves both switches, because the Settings screen
   * subscribes both rows through subscribeKeepaliveProbe. So a single listener
   * has to hear a real change from EACH setter, and each setter has its own
   * notify loop that can be dropped independently.
   *
   * Mutation seen failing: dropping the `for (const listener of
   * keepaliveProbeListeners) listener();` line from setNativeStopAlarmEnabled
   * alone left the ceiling's notification intact and failed the second
   * assertion - "expected "vi.fn()" to be called 2 times, but got 1 times".
   * Dropping `keepaliveProbeListeners.add(listener);` from the subscribe fails
   * the first one - "expected "vi.fn()" to be called 1 times, but got 0 times".
   */
  it('notifies a subscribed listener on a real change from either setter', async () => {
    const { setKeepaliveCeilingEnabled, setNativeStopAlarmEnabled, subscribeKeepaliveProbe } = await importTraceBuild();
    const listener = vi.fn();
    subscribeKeepaliveProbe(listener);

    setKeepaliveCeilingEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);

    setNativeStopAlarmEnabled(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  /**
   * A listener is a React re-render, so a set to the value already held must
   * stay silent. Each setter is driven twice with the SAME value after a real
   * change, and once up front at the default, so both the "already the default"
   * and "already flipped" shapes of the guard are covered.
   *
   * Mutation seen failing: changing setKeepaliveCeilingEnabled's guard from
   * `if (!traceEnabled || keepaliveCeilingOn === enabled) return;` to
   * `if (!traceEnabled) return;` notified on the default-valued set -
   * "expected "vi.fn()" to not be called at all, but actually been called 1
   * times". Making setNativeStopAlarmEnabled drop its assignment instead (so
   * its guard never sees a held value) fails the repeat set - "expected
   * "vi.fn()" to be called 2 times, but got 3 times".
   */
  it('does not notify on a same-value set', async () => {
    const { setKeepaliveCeilingEnabled, setNativeStopAlarmEnabled, subscribeKeepaliveProbe } = await importTraceBuild();
    const listener = vi.fn();
    subscribeKeepaliveProbe(listener);

    setKeepaliveCeilingEnabled(true);
    setNativeStopAlarmEnabled(true);
    expect(listener).not.toHaveBeenCalled();

    setKeepaliveCeilingEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);
    setKeepaliveCeilingEnabled(false);
    expect(listener).toHaveBeenCalledTimes(1);

    setNativeStopAlarmEnabled(false);
    expect(listener).toHaveBeenCalledTimes(2);
    setNativeStopAlarmEnabled(false);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  /**
   * Task #109's pair, in a trace build: each setter moves only its own
   * getter, notifies the shared listener on a real change, and stays silent on
   * a same-value set (a listener is a React re-render).
   *
   * Mutation seen failing: changing `frameLivenessOn = enabled;` to
   * `frameLivenessOn = retiredReceiveStreamsOn = enabled;` moved the wrong
   * switch, and dropping the notify loop from setRetiredReceiveStreamsEnabled
   * left the listener uncalled.
   */
  it('the bridge-latency setters move only their own getter and notify once per real change', async () => {
    const {
      frameLivenessEnabled,
      retiredReceiveStreamsEnabled,
      setFrameLivenessEnabled,
      setRetiredReceiveStreamsEnabled,
      subscribeBridgeLatencyProbe,
    } = await importTraceBuild();
    const listener = vi.fn();
    const unsubscribe = subscribeBridgeLatencyProbe(listener);

    setRetiredReceiveStreamsEnabled(true);
    setFrameLivenessEnabled(true);
    expect(listener).not.toHaveBeenCalled();

    setRetiredReceiveStreamsEnabled(false);
    expect(retiredReceiveStreamsEnabled()).toBe(false);
    expect(frameLivenessEnabled()).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);

    setFrameLivenessEnabled(false);
    expect(frameLivenessEnabled()).toBe(false);
    expect(retiredReceiveStreamsEnabled()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(2);

    setFrameLivenessEnabled(false);
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    setRetiredReceiveStreamsEnabled(true);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  /**
   * The unsubscribe is asserted AFTER a notification was proven to arrive. A
   * test that only checked silence after unsubscribing would also pass for a
   * listener that was never registered, which is a different bug. A second
   * listener stays subscribed throughout, so an unsubscribe that removed more
   * than its own listener is caught too.
   *
   * Mutation seen failing: replacing `keepaliveProbeListeners.delete(listener);`
   * in the returned unsubscribe with `void listener;` kept notifying the
   * removed listener - "expected "vi.fn()" to be called 1 times, but got 3
   * times" on `unsubscribedListener`.
   */
  it('stops notifying a listener once it unsubscribes, and only that listener', async () => {
    const { setKeepaliveCeilingEnabled, setNativeStopAlarmEnabled, subscribeKeepaliveProbe } = await importTraceBuild();
    const unsubscribedListener = vi.fn();
    const remainingListener = vi.fn();
    const unsubscribe = subscribeKeepaliveProbe(unsubscribedListener);
    subscribeKeepaliveProbe(remainingListener);

    setKeepaliveCeilingEnabled(false);
    expect(unsubscribedListener).toHaveBeenCalledTimes(1);
    expect(remainingListener).toHaveBeenCalledTimes(1);

    unsubscribe();
    setKeepaliveCeilingEnabled(true);
    setNativeStopAlarmEnabled(false);

    expect(unsubscribedListener).toHaveBeenCalledTimes(1);
    expect(remainingListener).toHaveBeenCalledTimes(3);
  });
});
