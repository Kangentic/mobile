import type { TerminalDimensionsWire, Unsubscribe } from '@kangentic/protocol';
import { hasVisibleContent } from '@/terminal/liveTail';

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

export type TerminalFeedEvent =
  /**
   * 'chunk' appends to what the consumer already rendered; 'seed' REPLACES
   * it (a fresh read-stream subscribe superseded the buffer - reset the
   * view, then render the data).
   */
  | { kind: 'chunk' | 'seed'; data: string }
  /** The desktop PTY's grid changed (or was first learned); the bytes that follow are laid out for it. */
  | { kind: 'dims'; cols: number; rows: number };

interface TerminalRing {
  chunks: string[];
  totalBytes: number;
  /** The PTY grid the buffered bytes are laid out for; null until the desktop reports one (or never, pre-0.4.0). */
  dims: TerminalDimensionsWire | null;
  /**
   * Whether a read-stream snapshot has landed in this ring since it was
   * retained. Live chunks can arrive BEFORE the snapshot that answers the
   * subscribe (the desktop pushes output the moment the subscription exists
   * and serialises the scrollback a beat later), and a frame built from those
   * chunks alone is replaced the moment the seed lands - see hasSeed.
   */
  seeded: boolean;
  /**
   * How many mounted session screens hold this ring (see retainTerminal).
   * Always at least 1 while the ring exists: the ring is created by the first
   * retain and deleted by the last release.
   */
  retainCount: number;
}

const ringsBySessionId = new Map<string, TerminalRing>();

type TerminalFeedListener = (event: TerminalFeedEvent) => void;

/**
 * Listeners live OUTSIDE the ring, and deliberately outlive it.
 *
 * Retention owns the BUFFER; a subscriber owns its LISTENER. Keeping the two
 * together made subscribe order load-bearing, and React runs child effects
 * before parent effects in the same commit: on a session swap the pane
 * resubscribed to the successor before SessionScreen's effect had retained
 * its ring, subscribeChunks silently returned a no-op, and every later byte
 * landed in a ring with zero listeners. The terminal stayed black until an
 * unrelated re-render (a theme or clean-feed flip) happened to re-run the
 * effect, which is why it read as "can happen" rather than "always".
 *
 * With the sets keyed on sessionId instead, attaching before the ring exists
 * is ordinary: the seed that arrives once the ring is retained reaches the
 * listener that was already waiting for it.
 */
const listenersBySessionId = new Map<string, Set<TerminalFeedListener>>();

/** Copies the set before iterating: a listener may unsubscribe from inside its own callback. */
function emit(sessionId: string, event: TerminalFeedEvent): void {
  const listeners = listenersBySessionId.get(sessionId);
  if (!listeners) return;
  for (const listener of [...listeners]) listener(event);
}

function evictPastCapacity(ring: TerminalRing): void {
  while (ring.totalBytes > TERMINAL_RING_CAPACITY_BYTES && ring.chunks.length > 1) {
    const evicted = ring.chunks.shift();
    if (evicted === undefined) break;
    ring.totalBytes -= evicted.length;
  }
}

/**
 * One mounted session screen's hold on a session's terminal. REFERENCE
 * COUNTED, because two screens can be mounted on one session (a screen buried
 * under a sheet or a diff, then a notification tap for the same task): the
 * first retain creates the ring, every later one only counts.
 *
 * Retention is also the "wants live PTY bytes" fact every SubscriptionManager
 * reads at subscribe time (isTerminalRetained, injected as isTerminalWanted).
 * That is why it lives here, in module state that outlives every connection:
 * the flag used to live on the manager, which is rebuilt per connection, so a
 * session screen that stayed mounted across a rebuild was re-subscribed
 * list-only and its mirror froze or went black.
 */
export function retainTerminal(sessionId: string): void {
  const ring = ringsBySessionId.get(sessionId);
  if (ring) {
    ring.retainCount += 1;
    return;
  }
  ringsBySessionId.set(sessionId, { chunks: [], totalBytes: 0, dims: null, seeded: false, retainCount: 1 });
}

/**
 * Releases one hold. Only the LAST release drops the buffered bytes, and only
 * it returns true - the caller's cue to tell the desktop to stop sending PTY
 * bytes. A release for a session with no ring (resetTerminalFeed wiped it
 * under a mounted screen) is a no-op that returns false. Subscribers keep
 * their listeners either way - see listenersBySessionId.
 */
export function releaseTerminal(sessionId: string): boolean {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring) return false;
  ring.retainCount -= 1;
  if (ring.retainCount > 0) return false;
  ringsBySessionId.delete(sessionId);
  return true;
}

/**
 * True while at least one mounted session screen holds the session: the
 * ring exists, and the desktop is asked for live PTY bytes on every subscribe.
 */
export function isTerminalRetained(sessionId: string): boolean {
  return ringsBySessionId.has(sessionId);
}

/** Replaces the ring with a fresh scrollback snapshot (a new read-stream subscribe supersedes everything buffered). */
export function seedScrollback(sessionId: string, scrollback: string): void {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring) return;
  ring.chunks = scrollback.length > 0 ? [scrollback] : [];
  ring.totalBytes = scrollback.length;
  ring.seeded = true;
  evictPastCapacity(ring);
  emit(sessionId, { kind: 'seed', data: scrollback });
}

/**
 * True once a read-stream snapshot has landed in this session's ring (empty
 * or not) since it was retained. The terminal pane's hold rule waits for it
 * before re-initialising over a painted frame: every retained ring is
 * subscribed and gets a seed a round trip later (openSessionScreen retains
 * and refreshes in that order), and an init built from the live chunks that
 * beat it is torn down and rebuilt when it lands - a reset to blank and a
 * second replay, exposed on screen once the swap veil has let go. Measured
 * live on a column move: the seed's re-init landed 0.4-0.6 s after the
 * chunk-built frame and showed a black grid for about a second.
 */
export function hasSeed(sessionId: string): boolean {
  return ringsBySessionId.get(sessionId)?.seeded === true;
}

/** No-op unless the session is retained. */
export function appendChunk(sessionId: string, data: string): void {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring || data.length === 0) return;
  ring.chunks.push(data);
  ring.totalBytes += data.length;
  evictPastCapacity(ring);
  emit(sessionId, { kind: 'chunk', data });
}

export function getBufferedData(sessionId: string): string {
  const ring = ringsBySessionId.get(sessionId);
  return ring ? ring.chunks.join('') : '';
}

/**
 * True when re-initialising the WebView from this session would paint
 * visible glyphs: the ring exists and its bytes carry printable content once
 * every escape sequence is stripped. False for a successor whose first
 * snapshot has not landed, AND for one whose seed is escape-only (a fresh
 * PTY's alternate-screen switch), where an init would paint an EMPTY grid
 * over a perfectly good last frame. A known grid alone does not count: dims
 * land before the seed, and an init on dims alone is exactly that blank.
 */
export function hasPaintableFrame(sessionId: string): boolean {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring || ring.chunks.length === 0) return false;
  return hasVisibleContent(ring.chunks.join(''));
}

/**
 * Records the authoritative PTY grid (snapshot's ptyDimensions or a
 * terminal-resize event) and notifies listeners on change. No-op unless
 * the session is retained, like every other write here.
 */
export function setTerminalDimensions(sessionId: string, dims: TerminalDimensionsWire | null): void {
  const ring = ringsBySessionId.get(sessionId);
  if (!ring) return;
  if (dims === null) {
    ring.dims = null;
    return;
  }
  if (ring.dims && ring.dims.cols === dims.cols && ring.dims.rows === dims.rows) return;
  ring.dims = { cols: dims.cols, rows: dims.rows };
  emit(sessionId, { kind: 'dims', cols: dims.cols, rows: dims.rows });
}

/** The PTY grid the buffered bytes are laid out for, or null when unknown (pre-0.4.0 desktop, or not yet reported). */
export function getTerminalDimensions(sessionId: string): TerminalDimensionsWire | null {
  const ring = ringsBySessionId.get(sessionId);
  return ring?.dims ? { ...ring.dims } : null;
}

/**
 * Live feed. The listener receives each append as a 'chunk' and each
 * scrollback re-seed as a 'seed' after it lands in the ring; call
 * getBufferedData() first for the backlog.
 *
 * Attaching to a session that is not retained YET is fine and deliberate: the
 * listener simply hears nothing until a ring exists, then receives that ring's
 * first seed. Nothing here depends on the caller's effect running after the
 * screen's retain.
 */
export function subscribeChunks(sessionId: string, listener: TerminalFeedListener): Unsubscribe {
  let listeners = listenersBySessionId.get(sessionId);
  if (!listeners) {
    listeners = new Set();
    listenersBySessionId.set(sessionId, listeners);
  }
  listeners.add(listener);
  return () => {
    const currentListeners = listenersBySessionId.get(sessionId);
    if (!currentListeners) return;
    currentListeners.delete(listener);
    // Drop the empty set rather than leaving one per session ever watched.
    if (currentListeners.size === 0) listenersBySessionId.delete(sessionId);
  };
}

export interface TerminalFeedStats {
  sessionId: string;
  chunks: number;
  totalBytes: number;
  dims: TerminalDimensionsWire | null;
  seeded: boolean;
  /** Mounted session screens holding the ring; a count that never returns to zero is a leak (the desktop keeps streaming). */
  retainCount: number;
  listeners: number;
}

/**
 * Per-retained-session ring stats, for the dev inspect bridge. Enumerates
 * RINGS, so the list stays "what is buffered"; a listener attached to a
 * session with no ring is reported by getUnbufferedListenerSessionIds().
 */
export function getTerminalFeedStats(): TerminalFeedStats[] {
  return [...ringsBySessionId.entries()].map(([sessionId, ring]) => ({
    sessionId,
    chunks: ring.chunks.length,
    totalBytes: ring.totalBytes,
    dims: ring.dims ? { ...ring.dims } : null,
    seeded: ring.seeded,
    retainCount: ring.retainCount,
    listeners: listenersBySessionId.get(sessionId)?.size ?? 0,
  }));
}

/**
 * Sessions with a live listener but no ring - normal and brief mid-swap (the
 * pane has rebound to the successor, the screen has not retained it yet), and
 * a leak if one persists. For the dev inspect bridge.
 */
export function getUnbufferedListenerSessionIds(): string[] {
  return [...listenersBySessionId.keys()].filter((sessionId) => !ringsBySessionId.has(sessionId));
}

/**
 * Drops buffered PTY bytes for every session nobody holds or watches, and
 * returns how many rings went. Called on an OS memory warning
 * (`src/observability/memoryPressure.ts`).
 *
 * A RETAINED ring is never shed. It used to be, whenever no listener was
 * attached, on the theory that the desktop re-seeds it on the next subscribe -
 * but a DELETED ring is never re-seeded (seedScrollback no-ops on a missing
 * ring) and stops reading as retained, so the screen's want for terminal
 * bytes went with it. And a mounted pane has no listener for routine windows:
 * before its WebView reports ready, and across recoverWebView after the OS
 * killed the renderer. Android 14+ delivers TRIM_MEMORY_UI_HIDDEN on every app
 * switch and memoryShed classes it as 'backgrounded', so a shed landing in one
 * of those windows was ordinary, and it left a terminal black until the
 * screen remounted.
 *
 * INERT IN PRODUCTION, and said so rather than hidden: every ring is created
 * by retainTerminal and deleted by the last releaseTerminal, so every ring
 * that exists is retained and this always returns 0. Re-aiming it (at rings
 * held only by screens buried in the navigation stack, say) is a separate
 * decision. Idempotent, as every memory-pressure listener must be.
 */
export function shedUnwatchedTerminalRings(): number {
  let shedCount = 0;
  for (const [sessionId, ring] of [...ringsBySessionId.entries()]) {
    if (ring.retainCount > 0) continue;
    const listeners = listenersBySessionId.get(sessionId);
    if (listeners !== undefined && listeners.size > 0) continue;
    ringsBySessionId.delete(sessionId);
    shedCount += 1;
  }
  return shedCount;
}

export function resetTerminalFeed(): void {
  ringsBySessionId.clear();
  listenersBySessionId.clear();
}
