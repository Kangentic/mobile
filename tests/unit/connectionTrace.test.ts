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
   * times".
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
});
