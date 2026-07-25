import { afterEach, describe, expect, it, vi } from 'vitest';
import { peekLastTerminalLine } from '@/connection/actions';

const { readStreamSubscribe, refreshStream } = vi.hoisted(() => ({
  readStreamSubscribe: vi.fn(),
  refreshStream: vi.fn(),
}));

vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection: () => ({ subscriptions: { refreshStream } }),
  requireSubscriptions: () => ({ refreshStream }),
  requireVerbClient: () => ({ readStreamSubscribe }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

afterEach(() => {
  readStreamSubscribe.mockReset();
  refreshStream.mockReset();
});

/**
 * This peek is the ONE caller outside a session screen that legitimately
 * needs PTY bytes: the scrollback IS the snippet for a transcript-less agent,
 * and a list-only subscribe returns an empty one.
 *
 * That makes it the one place the ~13MB/hour fix can be undone by accident,
 * and it was: `terminal` omitted means TRUE on the wire, and the desktop
 * REPLACES a session's subscription on every subscribe, so the one-shot left
 * full PTY streaming armed for a feed row that discards every byte.
 */
describe('peekLastTerminalLine PTY discipline', () => {
  it('asks for the bytes explicitly, then puts the subscription back to list-only', async () => {
    readStreamSubscribe.mockResolvedValue({ scrollback: 'building the login redirect fix\r\n' });

    const snippet = await peekLastTerminalLine('session-1', 0);

    expect(snippet).toBe('building the login redirect fix');
    // Explicit, not omitted: omitted means "send them" to the desktop.
    expect(readStreamSubscribe).toHaveBeenCalledWith('session-1', { terminal: true });
    // And immediately re-subscribed at whatever the manager wants, which for
    // a feed row is list-only.
    expect(refreshStream).toHaveBeenCalledWith('session-1');
  });

  it('serves a second caller from the throttle without re-arming the stream at all', async () => {
    readStreamSubscribe.mockResolvedValue({ scrollback: 'still working\r\n' });

    await peekLastTerminalLine('session-2', 60_000);
    await peekLastTerminalLine('session-2', 60_000);

    expect(readStreamSubscribe).toHaveBeenCalledTimes(1);
    expect(refreshStream).toHaveBeenCalledTimes(1);
  });
});
