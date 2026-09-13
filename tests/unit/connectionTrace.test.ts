/**
 * connectionTrace's build gate, in the state every shipped build ships in:
 * EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE unset.
 *
 * `traceEnabled` is captured once at module evaluation time from
 * process.env, so each test clears the env var and resets the module
 * registry before a fresh dynamic import, rather than relying on import
 * order across files to keep the flag unset.
 *
 * The ON-path branches (a real trace build) are deliberately NOT covered
 * here - they are dev-only instrumentation, and are not worth chasing with
 * vi.resetModules() gymnastics unless it stays clean, which it does not for
 * a module-scope const. What matters in production is this file: if the OFF
 * path ever stopped being a hard floor, the whole foreground-reconnect fix
 * (board task #70 - RelayTransport.redialNow, connectionManager's kick and
 * probe) would be silently disabled in every shipped build, with nothing
 * else in the suite positioned to notice.
 */
import { describe, expect, it, vi } from 'vitest';

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
   * warmForegroundSeen latch itself has no ON-path test, per this file's
   * header. What protects the latch is that it is a one-way boolean rather
   * than the clock-equality check it replaced, which is auditable by reading
   * it; the behaviour it guards is a log field in a dev-only build.
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
