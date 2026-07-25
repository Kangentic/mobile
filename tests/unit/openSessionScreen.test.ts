/**
 * openSessionScreen / closeSessionScreen: the setStreamWantsTerminal call
 * sites. The component test mocks '@/connection/actions' wholesale, so these
 * two call sites are otherwise untested - deleting either silently regresses
 * the ~13MB/hour of PTY traffic the feed was pulling for sessions nobody had
 * a terminal open on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeSessionScreen, openSessionScreen } from '@/connection/actions';
import { useActivityStore } from '@/state/activityStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { resetTerminalFeed } from '@/state/terminalFeed';

const { readTranscriptWindow, setStreamWantsTerminal, refreshStream, getActiveConnection } = vi.hoisted(() => ({
  readTranscriptWindow: vi.fn(),
  setStreamWantsTerminal: vi.fn(),
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

function stubConnection(): { subscriptions: { setStreamWantsTerminal: typeof setStreamWantsTerminal; refreshStream: typeof refreshStream } } {
  return { subscriptions: { setStreamWantsTerminal, refreshStream } };
}

afterEach(() => {
  readTranscriptWindow.mockReset();
  setStreamWantsTerminal.mockReset();
  refreshStream.mockReset();
  getActiveConnection.mockReset();
  useActivityStore.getState().reset();
  useTranscriptStore.getState().reset();
  resetTerminalFeed();
});

describe('openSessionScreen', () => {
  it('turns the terminal projection on for the opened session', () => {
    getActiveConnection.mockReturnValue(stubConnection());
    // The subscription manager reports whether it actually re-subscribed -
    // true here mirrors the real first-open path.
    setStreamWantsTerminal.mockReturnValue(true);
    readTranscriptWindow.mockResolvedValue(tailWindow());
    useActivityStore.getState().registerSession('session-1', 'task-1', 'project-1');

    openSessionScreen('session-1');

    expect(setStreamWantsTerminal).toHaveBeenCalledWith('session-1', true);
  });

  it('does nothing to the terminal projection while disconnected (no active connection)', () => {
    getActiveConnection.mockReturnValue(null);
    readTranscriptWindow.mockResolvedValue(tailWindow());
    useActivityStore.getState().registerSession('session-1', 'task-1', 'project-1');

    expect(() => openSessionScreen('session-1')).not.toThrow();

    expect(setStreamWantsTerminal).not.toHaveBeenCalled();
  });
});

describe('closeSessionScreen', () => {
  it('turns the terminal projection off for the closed session', () => {
    getActiveConnection.mockReturnValue(stubConnection());
    useActivityStore.getState().registerSession('session-1', 'task-1', 'project-1');

    closeSessionScreen('session-1');

    expect(setStreamWantsTerminal).toHaveBeenCalledWith('session-1', false);
  });
});
