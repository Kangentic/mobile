/**
 * Runs every step in order, even when one rejects, then rejects with the first
 * failure.
 *
 * For a wipe, whose steps do not depend on each other and whose worst outcome is
 * stopping part way. Awaiting deletes one after another leaves everything after a
 * failure behind, and a best-effort caller swallows the rejection, so nothing
 * says it happened. expo-secure-store made that reachable at 58: its iOS delete
 * now rejects on a Keychain failure, where 57 ignored them all.
 */
export async function attemptAll(steps: readonly (() => Promise<unknown>)[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw failures[0];
}
