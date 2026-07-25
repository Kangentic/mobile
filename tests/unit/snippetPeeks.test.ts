import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptEntryWire } from '@kangentic/protocol';
import { peekLastAssistantMessage, peekLastTerminalLine } from '@/connection/actions';
import { useTranscriptStore } from '@/state/transcriptStore';

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
  useTranscriptStore.getState().reset();
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

  /**
   * A session the user has OPENED is retained, and its deltas already stream
   * into transcriptStore live - reading from there is free and always
   * current, unlike the throttled wire fetch below (which can show text up
   * to minFreshnessMs old). If this fast path stopped being taken, the local
   * text would never be read and the mock wire text would leak through
   * instead - the readTranscriptWindow assertion is what catches that.
   */
  it('reads the last assistant message from a retained, up-to-date transcriptStore session with no wire fetch', async () => {
    useTranscriptStore.getState().retainSession('session-retained');
    useTranscriptStore.getState().applyWindow('session-retained', {
      revision: 1,
      totalEntries: 1,
      startIndex: 0,
      entries: [{ kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: 'Local live text.' }] }],
    });
    // If the fast path were skipped, this is what the wire fetch would
    // return instead - a different string so the assertion below actually
    // discriminates which source answered.
    readTranscriptWindow.mockResolvedValue(windowWithAssistantText('Wire text - should not be seen.'));

    await expect(peekLastAssistantMessage('session-retained', 0)).resolves.toBe('Local live text.');
    expect(readTranscriptWindow).not.toHaveBeenCalled();
  });

  /**
   * needsTailFetch marks a retained session whose store fell behind (here, a
   * delta gap past the window end - entries between were never received).
   * The fast path must not trust `entries` in that state even though it is
   * non-empty; a mounted chat screen would self-heal it, but an unmounted
   * feed row has no such screen, so this is the only thing that saves it
   * from pinning stale text on the feed indefinitely.
   */
  it('falls through to the wire fetch when the retained session is flagged needsTailFetch', async () => {
    useTranscriptStore.getState().retainSession('session-gap');
    useTranscriptStore.getState().applyWindow('session-gap', {
      revision: 1,
      totalEntries: 1,
      startIndex: 0,
      entries: [{ kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: 'Stale local text.' }] }],
    });
    useTranscriptStore.getState().applyTranscript({
      kind: 'transcript',
      sessionId: 'session-gap',
      taskId: 'task-1',
      payload: {
        mode: 'delta',
        revision: 2,
        totalEntries: 5,
        // Index 4 is past the window end (startIndex 0 + 1 entry = index 1):
        // a hole the store never filled, which is exactly what sets
        // needsTailFetch while leaving `entries` non-empty.
        upserts: [{ index: 4, entry: { kind: 'assistant', uuid: 'a5', ts: 5, blocks: [{ type: 'text', text: 'unreachable' }] } }],
      },
    });
    expect(useTranscriptStore.getState().bySessionId['session-gap'].needsTailFetch).toBe(true);
    readTranscriptWindow.mockResolvedValue(windowWithAssistantText('Fresh wire text.'));

    await expect(peekLastAssistantMessage('session-gap', 0)).resolves.toBe('Fresh wire text.');
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
