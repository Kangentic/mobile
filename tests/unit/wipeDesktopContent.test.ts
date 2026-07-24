import { afterEach, describe, expect, it, vi } from 'vitest';
import { peekLastAssistantMessage, wipeDesktopContent } from '@/connection/actions';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useDiffStore } from '@/state/diffStore';
import { useReadingViewStore } from '@/state/readingViewStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { appendChunk, getBufferedData, retainTerminal } from '@/state/terminalFeed';
import { useSettingsStore } from '@/state/settingsStore';
import type { TranscriptEntryWire } from '@kangentic/protocol';

// vi.hoisted + vi.mock both hoist above the imports, so the actions module
// always receives these fakes (same arrangement as snippetPeeks.test.ts).
const { readTranscriptWindow } = vi.hoisted(() => ({
  readTranscriptWindow: vi.fn(),
}));

vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection: vi.fn(() => null),
  requireSubscriptions: vi.fn(),
  requireVerbClient: () => ({ readTranscriptWindow }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
// wipeDesktopContent also clears settingsStore, which persists via
// expo-secure-store - fake it so the vitest (node) run has no native module.
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

afterEach(() => {
  readTranscriptWindow.mockReset();
  wipeDesktopContent();
});

/**
 * Unpairing revokes trust, and content fetched under that trust must not
 * outlive it: a lost or stolen unlocked phone must not keep showing the
 * just-untrusted desktop's board, transcripts, terminal scrollback, diffs,
 * or cached snippets (docs/security.md's physical-access adversary).
 */
describe('wipeDesktopContent', () => {
  it('clears every store holding the paired desktop content', () => {
    useActivityStore.setState({ bySessionId: { 's-1': { sessionId: 's-1' } } } as never);
    useTranscriptStore.setState({ bySessionId: { 's-1': { entries: [] } } } as never);
    useDiffStore.setState({ byTaskId: { 't-1': { files: [] } } } as never);
    useReadingViewStore.setState({ bySessionId: { 's-1': { lines: ['secret output'] } } } as never);
    useBoardStore.setState({ projects: [{ id: 'p-1', name: 'Secret project' }] } as never);
    retainTerminal('s-1');
    appendChunk('s-1', 'secret scrollback');
    expect(getBufferedData('s-1')).toContain('secret scrollback');

    wipeDesktopContent();

    expect(useActivityStore.getState().bySessionId).toEqual({});
    expect(useTranscriptStore.getState().bySessionId).toEqual({});
    expect(useDiffStore.getState().byTaskId).toEqual({});
    expect(useReadingViewStore.getState().bySessionId).toEqual({});
    expect(useBoardStore.getState().projects).toEqual([]);
    expect(getBufferedData('s-1')).toBe('');
  });

  it('clears the snippet peek caches, so a later pairing never serves the old desktop text', async () => {
    const entry: TranscriptEntryWire = { kind: 'assistant', uuid: 'a1', ts: 1, blocks: [{ type: 'text', text: 'Old desktop secret.' }] };
    readTranscriptWindow.mockResolvedValue({ entries: [entry] });
    await expect(peekLastAssistantMessage('session-1', 20_000)).resolves.toBe('Old desktop secret.');
    expect(readTranscriptWindow).toHaveBeenCalledTimes(1);

    wipeDesktopContent();

    // A cached record would have been served without a wire fetch; after the
    // wipe the peek must go back to the wire.
    readTranscriptWindow.mockResolvedValue({ entries: [{ ...entry, blocks: [{ type: 'text', text: 'New desktop.' }] }] });
    await expect(peekLastAssistantMessage('session-1', 20_000)).resolves.toBe('New desktop.');
    expect(readTranscriptWindow).toHaveBeenCalledTimes(2);
  });

  it('clears preferredSessionLensByTaskId (keyed by the old desktop\'s task IDs) but leaves other settings alone', () => {
    useSettingsStore.setState({
      preferredSessionLensByTaskId: { 'task-1': 'chat' },
      collapsedTriageSection: 'Idle',
      hapticsEnabled: false,
    });

    wipeDesktopContent();

    expect(useSettingsStore.getState().preferredSessionLensByTaskId).toEqual({});
    expect(useSettingsStore.getState().collapsedTriageSection).toBe('Idle');
    expect(useSettingsStore.getState().hapticsEnabled).toBe(false);
  });
});
