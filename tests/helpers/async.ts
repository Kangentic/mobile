/**
 * Shared async helpers for the vitest tier.
 *
 * These existed as two near-identical private copies across the channel tests,
 * and the copies had drifted in the one way that matters: sessionManager's
 * polled forever with no timeout. That is not a style problem. A predicate that
 * stops becoming true - which is exactly what a mutation to the code under test
 * does - fails as a 5s "test timed out" with no indication of what was being
 * waited for, instead of naming the condition. Mutation-testing a regression
 * test is project policy, so the failure mode of a wait helper is load-bearing.
 *
 * For a NEW test, prefer vitest's built-in `vi.waitFor(() => expect(...))`,
 * which reports the failing assertion itself (see connectionManager.test.ts).
 * Reach for `waitUntil` when the condition is a plain boolean rather than an
 * assertion, or when the surrounding test drives fake timers and needs the
 * poll to run on real ones.
 */

/**
 * Polls a boolean predicate on REAL timers until it holds.
 *
 * Deliberately real-timer based: the channel tests await a handshake's own
 * microtask/await chain (openConnection's several awaits, LoopbackTransport's
 * queued delivery), which resolves the ordinary way and must not fight a fake
 * clock it was never meant to interact with. Callers that engage
 * `vi.useFakeTimers()` do so only after their waits have settled.
 */
export async function waitUntil(
  predicate: () => boolean,
  options: { timeoutMs?: number; label?: string } = {},
): Promise<void> {
  const { timeoutMs = 2000, label } = options;
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`waitUntil timed out after ${timeoutMs}ms${label ? `: ${label}` : ''}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Yields for one macrotask turn, which drains the whole microtask queue.
 *
 * LoopbackTransport delivers frames inside `queueMicrotask`, so this is what
 * makes a NEGATIVE assertion ("nothing arrived") a real assertion rather than
 * a race: after one turn, anything that was going to be delivered has been.
 * Polling cannot express that - a `waitUntil` on "nothing happened" can only
 * ever time out.
 */
export function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
