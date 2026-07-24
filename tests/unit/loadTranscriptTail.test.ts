import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTranscriptTail } from '@/connection/actions';
import { useTranscriptStore } from '@/state/transcriptStore';

const { readTranscriptWindow } = vi.hoisted(() => ({ readTranscriptWindow: vi.fn() }));

vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection: vi.fn(() => null),
  requireSubscriptions: vi.fn(),
  requireVerbClient: () => ({ readTranscriptWindow }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

function tailWindow(): { revision: number; totalEntries: number; startIndex: number; entries: [] } {
  return { revision: 7, totalEntries: 60, startIndex: 0, entries: [] };
}

afterEach(() => {
  readTranscriptWindow.mockReset();
  useTranscriptStore.getState().reset();
});

/**
 * openSessionScreen fires a tail fetch, and the session screen's
 * needsTailFetch self-heal effect mounts while that request is still in
 * flight and fires a second. Both resolved with the same window and each
 * applied it wholesale, replacing the feed's cell identity twice mid-layout
 * for no gain - one of the things that left the chat lens parked in empty
 * space on open.
 */
describe('loadTranscriptTail request sharing', () => {
  it('shares one in-flight request between concurrent callers', async () => {
    readTranscriptWindow.mockResolvedValue(tailWindow());

    await Promise.all([loadTranscriptTail('session-1'), loadTranscriptTail('session-1')]);

    expect(readTranscriptWindow).toHaveBeenCalledTimes(1);
  });

  it('does not share across different sessions', async () => {
    readTranscriptWindow.mockResolvedValue(tailWindow());

    await Promise.all([loadTranscriptTail('session-1'), loadTranscriptTail('session-2')]);

    expect(readTranscriptWindow).toHaveBeenCalledTimes(2);
  });

  it('fetches again once the shared request has settled', async () => {
    readTranscriptWindow.mockResolvedValue(tailWindow());

    await loadTranscriptTail('session-1');
    await loadTranscriptTail('session-1');

    expect(readTranscriptWindow).toHaveBeenCalledTimes(2);
  });

  /**
   * The self-heal path retries on the next needsTailFetch change, so a failed
   * request must not leave a poisoned entry that swallows every later attempt.
   */
  it('clears the shared request after a failure so the retry refetches', async () => {
    readTranscriptWindow.mockRejectedValueOnce(new Error('not connected'));

    await expect(loadTranscriptTail('session-1')).rejects.toThrow('not connected');

    readTranscriptWindow.mockResolvedValue(tailWindow());
    await loadTranscriptTail('session-1');

    expect(readTranscriptWindow).toHaveBeenCalledTimes(2);
  });
});
