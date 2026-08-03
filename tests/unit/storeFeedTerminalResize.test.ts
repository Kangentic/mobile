/**
 * The terminal-resize -> re-seed path in bindFeedToStores. A resize event
 * whose dims MATCH what the ring already holds must not re-seed: the desktop
 * terminal never reflowed, so the buffered bytes are still laid out
 * correctly, and a re-seed pays a full serialized-frame round trip over the
 * relay to repaint an identical view. Not hypothetical - the desktop's
 * resize() emits pty-resize without a same-dims guard, and a task-detail
 * remount (a desktop project switch away and back) re-sends the detail's
 * unchanged fit. Measured live 2026-08-02: every such switch soft re-inited
 * the phone to a byte-identical 210x48 frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionManager } from '@/channel/sessionManager';
import type { SubscriptionManager } from '@/channel/subscriptionManager';
import { FeedRouter } from '@/channel/feedRouter';
import { bindFeedToStores } from '@/connection/storeFeed';
import { resetTerminalFeed, retainTerminal, setTerminalDimensions } from '@/state/terminalFeed';

const SESSION_ID = 'sess-resize';

/** Well past RESIZE_RESEED_DEBOUNCE_MS (300), so "did not fire" is a verdict, not a race. */
const PAST_DEBOUNCE_MS = 1000;

describe('bindFeedToStores terminal-resize re-seed', () => {
  let deliverMessage: ((message: unknown) => void) | null = null;
  let refreshStream: ReturnType<typeof vi.fn>;
  let unbind: (() => void) | null = null;
  let feed: FeedRouter | null = null;

  const emitTerminalResize = (cols: number, rows: number): void => {
    if (!deliverMessage) throw new Error('feed not wired');
    deliverMessage({
      type: 'event',
      event: { kind: 'terminal-resize', sessionId: SESSION_ID, taskId: 'task-resize', payload: { cols, rows } },
    });
  };

  beforeEach(() => {
    vi.useFakeTimers();
    resetTerminalFeed();
    const fakeSessionManager = {
      onMessage: (listener: (message: unknown) => void) => {
        deliverMessage = listener;
        return () => {
          deliverMessage = null;
        };
      },
    } as unknown as SessionManager;
    refreshStream = vi.fn();
    const fakeSubscriptions = {
      refreshStream,
      refreshBoard: vi.fn(),
      refreshDiff: vi.fn(),
    } as unknown as SubscriptionManager;
    feed = new FeedRouter(fakeSessionManager);
    unbind = bindFeedToStores(feed, fakeSubscriptions);
  });

  afterEach(() => {
    unbind?.();
    feed?.dispose();
    resetTerminalFeed();
    vi.useRealTimers();
  });

  it('re-seeds after the debounce when the grid actually changed', () => {
    retainTerminal(SESSION_ID);
    setTerminalDimensions(SESSION_ID, { cols: 210, rows: 48 });
    emitTerminalResize(306, 14);
    expect(refreshStream).not.toHaveBeenCalled();
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    expect(refreshStream).toHaveBeenCalledTimes(1);
    expect(refreshStream).toHaveBeenCalledWith(SESSION_ID);
  });

  it('does not re-seed when the event repeats the dims the ring already holds', () => {
    retainTerminal(SESSION_ID);
    setTerminalDimensions(SESSION_ID, { cols: 210, rows: 48 });
    emitTerminalResize(210, 48);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    expect(refreshStream).not.toHaveBeenCalled();
  });

  it('re-seeds when the ring has no dims yet - the layout baseline is unknown', () => {
    retainTerminal(SESSION_ID);
    emitTerminalResize(210, 48);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    expect(refreshStream).toHaveBeenCalledTimes(1);
  });

  it('re-seeds once for a bounce that lands back on the original grid - the reflow still happened', () => {
    retainTerminal(SESSION_ID);
    setTerminalDimensions(SESSION_ID, { cols: 210, rows: 48 });
    emitTerminalResize(306, 14);
    emitTerminalResize(210, 48);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    expect(refreshStream).toHaveBeenCalledTimes(1);
  });

  it('never re-seeds a session that is not retained', () => {
    emitTerminalResize(306, 14);
    vi.advanceTimersByTime(PAST_DEBOUNCE_MS);
    expect(refreshStream).not.toHaveBeenCalled();
  });
});
