import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptEntryWire } from '@kangentic/protocol';
import { peekLastAssistantMessage, peekLastTerminalLine } from '@/connection/actions';

// vi.hoisted + vi.mock both hoist above the imports, so the actions
// module always receives these fakes.
const { readTranscriptWindow, readStreamSubscribe } = vi.hoisted(() => ({
  readTranscriptWindow: vi.fn(),
  readStreamSubscribe: vi.fn(),
}));

vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection: vi.fn(() => null),
  requireSubscriptions: vi.fn(),
  requireVerbClient: () => ({ readTranscriptWindow, readStreamSubscribe }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
// @/connection/actions also imports settingsStore, which persists via
// expo-secure-store - fake it so the vitest (node) run has no native module.
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

function windowWithAssistantText(text: string): { entries: TranscriptEntryWire[] } {
  return { entries: [{ kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text }] }] };
}

afterEach(() => {
  vi.useRealTimers();
  readTranscriptWindow.mockReset();
  readStreamSubscribe.mockReset();
});

describe('peekLastAssistantMessage throttling', () => {
  it('serves the record within the freshness window, refetches after it', async () => {
    vi.useFakeTimers({ now: 1_000_000 });
    readTranscriptWindow.mockResolvedValue(windowWithAssistantText('First message.'));

    await expect(peekLastAssistantMessage('session-throttle', 20_000)).resolves.toBe('First message.');
    expect(readTranscriptWindow).toHaveBeenCalledTimes(1);

    readTranscriptWindow.mockResolvedValue(windowWithAssistantText('Second message.'));

    // Inside the window: the stale-but-honest record, no wire fetch.
    await expect(peekLastAssistantMessage('session-throttle', 20_000)).resolves.toBe('First message.');
    expect(readTranscriptWindow).toHaveBeenCalledTimes(1);

    vi.setSystemTime(1_000_000 + 21_000);
    await expect(peekLastAssistantMessage('session-throttle', 20_000)).resolves.toBe('Second message.');
    expect(readTranscriptWindow).toHaveBeenCalledTimes(2);
  });

  it('always refetches when the caller demands freshness (minFreshnessMs 0)', async () => {
    readTranscriptWindow.mockResolvedValue(windowWithAssistantText('Latest.'));

    await peekLastAssistantMessage('session-fresh', 0);
    await peekLastAssistantMessage('session-fresh', 0);

    expect(readTranscriptWindow).toHaveBeenCalledTimes(2);
  });

  it('shares one in-flight fetch between concurrent calls', async () => {
    let resolveWindow: (value: { entries: TranscriptEntryWire[] }) => void = () => undefined;
    readTranscriptWindow.mockReturnValue(
      new Promise((resolve) => {
        resolveWindow = resolve;
      }),
    );

    const firstCall = peekLastAssistantMessage('session-inflight', 0);
    const secondCall = peekLastAssistantMessage('session-inflight', 0);
    resolveWindow(windowWithAssistantText('Shared.'));

    await expect(firstCall).resolves.toBe('Shared.');
    await expect(secondCall).resolves.toBe('Shared.');
    expect(readTranscriptWindow).toHaveBeenCalledTimes(1);
  });
});

describe('peekLastTerminalLine throttling', () => {
  it('throttles per session and returns the cleaned content line', async () => {
    vi.useFakeTimers({ now: 2_000_000 });
    readStreamSubscribe.mockResolvedValue({ scrollback: 'real output line\n│ esc to interrupt │\n' });

    await expect(peekLastTerminalLine('terminal-throttle', 20_000)).resolves.toBe('real output line');
    expect(readStreamSubscribe).toHaveBeenCalledTimes(1);

    // Inside the window: no re-subscribe churn against the desktop.
    await expect(peekLastTerminalLine('terminal-throttle', 20_000)).resolves.toBe('real output line');
    expect(readStreamSubscribe).toHaveBeenCalledTimes(1);

    vi.setSystemTime(2_000_000 + 21_000);
    await peekLastTerminalLine('terminal-throttle', 20_000);
    expect(readStreamSubscribe).toHaveBeenCalledTimes(2);
  });
});
