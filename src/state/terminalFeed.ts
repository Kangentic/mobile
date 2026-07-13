import type { Unsubscribe } from '@kangentic/protocol';

/**
 * Per-session raw PTY buffering, deliberately NOT a Zustand store: chunks
 * arrive every ~50ms while an agent streams, and raw ANSI bytes are not
 * renderable React state - pushing each chunk through a store would
 * re-render subscribers on every chunk. Consumers (the conversation
 * live-tail glue and the xterm WebView pane) mount with getBufferedData()
 * and then attach subscribeChunks() for the live tail.
 *
 * Only RETAINED sessions buffer anything: triage subscribes read-stream for
 * every live session (it needs activity), and the terminal payloads riding
 * that subscription for sessions the user is not looking at are dropped
 * here at zero cost. The ring cap bounds a retained session's memory.
 */
const TERMINAL_RING_CAPACITY_BYTES = 128 * 1024;

export interface TerminalFeedEvent {
  /**
   * 'chunk' appends to what the consumer already rendered; 'seed' REPLACES
   * it (a fresh read-stream subscribe superseded the buffer - reset the
   * view, then render the data).
   */
  kind: 'chunk' | 'seed';
  data: string;
}

interface TerminalRing {
  chunks: string[];
  totalBytes: number;
  listeners: Set<(event: TerminalFeedEvent) => void>;
}

const ringsBySessionId = new Map<string, TerminalRing>();

function evictPastCapacity(ring: TerminalRing): void {
  while (ring.totalBytes > TERMINAL_RING_CAPACITY_BYTES && ring.chunks.length > 1) {
    const evicted = ring.chunks.shift();
    if (evicted === undefined) break;
    ring.totalBytes -= evicted.length;
  }
}

export function retainTerminal(sessionId: string): void {
  if (!ringsBySessionId.has(sessionId)) {
    ringsBySessionId.set(sessionId, { chunks: [], totalBytes: 0, listeners: new Set() });
  }
}

export function releaseTerminal(sessionId: string): void {
  ringsBySessionId.delete(sessionId);
}

export function isTerminalRetained(sessionId: string): boolean {
  return ringsBySessionId.has(sessionId);
}

/** Replaces the ring with a fresh scrollback snapshot (a new read-stream subscribe supersedes everything buffered). */
export function seedScrollback(sessionId: string, scrollback: string): void {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring) return;
  ring.chunks = scrollback.length > 0 ? [scrollback] : [];
  ring.totalBytes = scrollback.length;
  evictPastCapacity(ring);
  for (const listener of [...ring.listeners]) listener({ kind: 'seed', data: scrollback });
}

/** No-op unless the session is retained. */
export function appendChunk(sessionId: string, data: string): void {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring || data.length === 0) return;
  ring.chunks.push(data);
  ring.totalBytes += data.length;
  evictPastCapacity(ring);
  for (const listener of [...ring.listeners]) listener({ kind: 'chunk', data });
}

export function getBufferedData(sessionId: string): string {
  const ring = ringsBySessionId.get(sessionId);
  return ring ? ring.chunks.join('') : '';
}

/**
 * Live feed. The listener receives each append as a 'chunk' and each
 * scrollback re-seed as a 'seed' after it lands in the ring; call
 * getBufferedData() first for the backlog.
 */
export function subscribeChunks(sessionId: string, listener: (event: TerminalFeedEvent) => void): Unsubscribe {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring) return () => undefined;
  ring.listeners.add(listener);
  return () => {
    ring.listeners.delete(listener);
  };
}

export function resetTerminalFeed(): void {
  ringsBySessionId.clear();
}
