/** Reads in flight, by key. Module-global, so callers namespace their keys (`list:`, `earlier:`). */
const readsInFlight = new Map<string, { rerun: boolean }>();

/**
 * One read per key at a time. A request that arrives while the same read is in
 * flight runs once more after it, so the newest state is always read without
 * stacking a request per board event. Shared by the workflow reads and the
 * Command Terminals' Earlier list.
 */
export async function coalesced(key: string, read: () => Promise<void>): Promise<void> {
  const inFlight = readsInFlight.get(key);
  if (inFlight) {
    inFlight.rerun = true;
    return;
  }
  const marker = { rerun: false };
  readsInFlight.set(key, marker);
  try {
    do {
      marker.rerun = false;
      await read();
    } while (marker.rerun);
  } finally {
    readsInFlight.delete(key);
  }
}
