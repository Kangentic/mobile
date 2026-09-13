/**
 * connectionTrace's ON-path (EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE=1), kept in its
 * own file so the flag never coexists with connectionTrace.test.ts's OFF-path
 * assertions in the same module registry.
 *
 * Scope: only the two behaviors connectionTrace.test.ts's own comments name as
 * uncovered - markConnectionTraceForeground's `origin-rebased` line, and the
 * warmForegroundSeen latch isColdLaunch() reads. Everything else ON-path
 * (foregroundKickEnabled's real toggle, traceConnection's normal event
 * rendering, emitStartupOriginOnce's field derivation) is dev-only
 * instrumentation with no correctness consequence for a shipped build and is
 * deliberately left alone, same as the header this file's sibling states.
 *
 * `EXPO_PUBLIC_*` is only inlined by Metro at bundle time; under vitest it is
 * a live `process.env` read, exactly like every OFF-path test in
 * connectionTrace.test.ts (delete/set the var, vi.resetModules(), dynamic
 * import). Setting it to '1' instead of deleting it is the same pattern.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('connectionTrace (trace build, origin-rebased and the cold-launch latch)', () => {
  beforeEach(() => {
    process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE = '1';
  });

  afterEach(() => {
    delete process.env.EXPO_PUBLIC_KANGENTIC_CONNECTION_TRACE;
    vi.resetModules();
    vi.restoreAllMocks();
  });

  /**
   * markConnectionTraceForeground's docstring: "It emits `origin-rebased`
   * FIRST, so that line's own `+<ms>` is measured against the origin being
   * retired." Pin the delta, not just that the line exists: if the
   * implementation moved `foregroundedAtMs` before logging, the line would
   * measure against the NEW origin and always read `+0ms`.
   *
   * Mutation seen failing: swapping the two statements in
   * markConnectionTraceForeground (moving `traceConnection('origin-rebased')`
   * to after `foregroundedAtMs = Date.now();`) collapsed the asserted delta
   * from `+5000ms` to `+0ms` - "expected '+0ms' to be '+5000ms'".
   */
  it('origin-rebased measures its delta against the retiring origin, before the origin moves', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    vi.resetModules();
    const { markConnectionTraceForeground } = await import('@/devsupport/connectionTrace');
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    dateNowSpy.mockReturnValue(6000);
    markConnectionTraceForeground();

    const originRebasedCalls = consoleLogSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[connection-trace] origin-rebased'));

    expect(originRebasedCalls).toEqual(['[connection-trace] origin-rebased +5000ms']);
  });

  /**
   * The docstring: "It carries no fields. This runs on EVERY foreground, not
   * just the first". Two assertions in one test because they are the same
   * mechanism read twice: the exact rendered line already proves "no fields"
   * (an empty `rendered` plus `.trimEnd()`), and a second foreground on the
   * same module instance proves "every foreground", not a one-shot log.
   *
   * Mutation seen failing (the "every foreground" half): adding
   * `if (warmForegroundSeen) return;` to the top of
   * markConnectionTraceForeground left only ONE `origin-rebased` line after
   * two calls - "expected 1 to be 2".
   */
  it('origin-rebased fires again on a second foreground, still with no fields', async () => {
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(1000);
    vi.resetModules();
    const { markConnectionTraceForeground } = await import('@/devsupport/connectionTrace');
    const consoleLogSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    dateNowSpy.mockReturnValue(6000);
    markConnectionTraceForeground();
    dateNowSpy.mockReturnValue(6100);
    markConnectionTraceForeground();

    const originRebasedCalls = consoleLogSpy.mock.calls
      .map((call) => String(call[0]))
      .filter((line) => line.startsWith('[connection-trace] origin-rebased'));

    expect(originRebasedCalls).toEqual(['[connection-trace] origin-rebased +5000ms', '[connection-trace] origin-rebased +100ms']);
  });

  /**
   * The warmForegroundSeen latch, read through isColdLaunch(): true for the
   * whole cold-launch path, flips to false on the first foreground and stays
   * false. This is the ON-path test connectionTrace.test.ts's own comment
   * names as missing ("the warmForegroundSeen latch itself has no ON-path
   * test") - that file's hard-false assertion cannot distinguish the real
   * latch from `return traceEnabled;`, because traceEnabled is already false
   * there.
   *
   * Mutation seen failing: changing `isColdLaunch` to
   * `return traceEnabled;` (dropping the `!warmForegroundSeen` half) made
   * isColdLaunch() keep reading `true` after markConnectionTraceForeground()
   * - "expected true to be false". This is the exact mutation
   * connectionTrace.test.ts's OFF-path test cannot see, since it is already
   * false there for the unrelated reason that traceEnabled is false.
   */
  it('isColdLaunch flips false on the first foreground and stays false on a second', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000);
    vi.resetModules();
    const { isColdLaunch, markConnectionTraceForeground } = await import('@/devsupport/connectionTrace');
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    expect(isColdLaunch()).toBe(true);

    markConnectionTraceForeground();
    expect(isColdLaunch()).toBe(false);

    markConnectionTraceForeground();
    expect(isColdLaunch()).toBe(false);
  });
});
