/**
 * openSessionScreen / closeSessionScreen: the terminal retention that IS the
 * "wants live PTY bytes" fact, and the re-subscribes that carry it to the
 * desktop. The component test mocks '@/connection/actions' wholesale, so these
 * call sites are otherwise untested - deleting the close half silently
 * regresses the ~13MB/hour of PTY traffic the feed pulled for sessions nobody
 * had a terminal open on, and losing the open half is a black terminal.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSessionScreen, openSessionScreen } from '@/connection/actions';
import { useActivityStore } from '@/state/activityStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import {
  appendChunk,
  getBufferedData,
  isTerminalRetained,
  resetTerminalFeed,
  seedScrollback,
  setTerminalDimensions,
} from '@/state/terminalFeed';

const { readTranscriptWindow, refreshStream, getActiveConnection } = vi.hoisted(() => ({
  readTranscriptWindow: vi.fn(),
  refreshStream: vi.fn(),
  getActiveConnection: vi.fn(),
}));

vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection: () => getActiveConnection(),
  requireSubscriptions: vi.fn(),
  requireVerbClient: () => ({ readTranscriptWindow }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

function tailWindow(): { revision: number; totalEntries: number; startIndex: number; entries: [] } {
  return { revision: 1, totalEntries: 0, startIndex: 0, entries: [] };
}

function stubConnection(): { subscriptions: { refreshStream: typeof refreshStream } } {
  return { subscriptions: { refreshStream } };
}

function openScreen(sessionId: string): void {
  readTranscriptWindow.mockResolvedValue(tailWindow());
  useActivityStore.getState().registerSession(sessionId, 'task-1', 'project-1');
  openSessionScreen(sessionId);
}

afterEach(() => {
  readTranscriptWindow.mockReset();
  refreshStream.mockReset();
  getActiveConnection.mockReset();
  useActivityStore.getState().reset();
  useTranscriptStore.getState().reset();
  resetTerminalFeed();
});

describe('openSessionScreen', () => {
  it('holds the terminal and asks for one fresh frame carrying it', () => {
    getActiveConnection.mockReturnValue(stubConnection());

    openScreen('session-1');

    // The retention is what every SubscriptionManager reads as the want.
    expect(isTerminalRetained('session-1')).toBe(true);
    // One re-subscribe: it IS the fresh-scrollback fetch, now with the
    // terminal. A second would seed the WebView twice.
    expect(refreshStream).toHaveBeenCalledTimes(1);
    expect(refreshStream).toHaveBeenCalledWith('session-1');
  });

  /**
   * The cold-launch notification tap: the screen opens before any connection
   * exists. This case used to assert that NOTHING was recorded - the bug
   * itself: the want lived on the connection's SubscriptionManager, the open
   * reached it through `connection?.`, and the connection that came up next
   * subscribed the session list-only, so the terminal stayed black. The
   * retention now records the want with no connection at all, and the next
   * manager reads it on its first subscribe (asserted end to end in
   * connectionManagerTerminalWant.test.ts).
   */
  it('records the want with no connection, for the next connection to read', () => {
    getActiveConnection.mockReturnValue(null);

    expect(() => openScreen('session-1')).not.toThrow();

    expect(isTerminalRetained('session-1')).toBe(true);
  });
});

describe('closeSessionScreen', () => {
  it('releases the terminal and drops the desktop back to list-only when the last screen closes', () => {
    getActiveConnection.mockReturnValue(stubConnection());
    openScreen('session-1');
    refreshStream.mockClear();

    closeSessionScreen('session-1');

    expect(isTerminalRetained('session-1')).toBe(false);
    // The re-subscribe reads the released retention: terminal: false.
    expect(refreshStream).toHaveBeenCalledWith('session-1');
  });

  /**
   * Two screens on one session: one buried under a sheet or a diff, then a
   * notification tap for the same task. Dismissing either used to DELETE the
   * shared ring and switch the desktop to list-only, leaving the survivor's
   * mirror with no bytes and nothing to repaint from until it remounted.
   *
   * The seed and the grid land between the opens and the close, as they do
   * live (each open's re-subscribe is answered with one), so a write path
   * that rebuilt the ring instead of updating it would reset the count too.
   *
   * Mutations that redden this: make releaseTerminal delete the ring
   * regardless of the count; make seedScrollback replace the ring with a
   * fresh one holding a count of 1.
   */
  it('keeps a second screen on the same session live when the first one closes', () => {
    getActiveConnection.mockReturnValue(stubConnection());
    openScreen('session-1');
    openScreen('session-1');
    seedScrollback('session-1', 'seeded frame ');
    setTerminalDimensions('session-1', { cols: 210, rows: 48 });
    appendChunk('session-1', 'live frame');
    refreshStream.mockClear();

    closeSessionScreen('session-1');

    expect(isTerminalRetained('session-1')).toBe(true);
    expect(getBufferedData('session-1')).toBe('seeded frame live frame');
    expect(refreshStream).not.toHaveBeenCalled();

    closeSessionScreen('session-1');

    expect(isTerminalRetained('session-1')).toBe(false);
    expect(refreshStream).toHaveBeenCalledWith('session-1');
  });
});
