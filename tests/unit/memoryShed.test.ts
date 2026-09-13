import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useTranscriptStore } from '@/state/transcriptStore';
import {
  appendChunk,
  getBufferedData,
  isTerminalRetained,
  resetTerminalFeed,
  retainTerminal,
  shedUnwatchedTerminalRings,
  subscribeChunks,
} from '@/state/terminalFeed';

/**
 * What the app releases when the OS reports memory pressure.
 *
 * These pin both halves of the contract, and the second half is the one that
 * matters: a shed that drops what the user is LOOKING AT trades a possible
 * out-of-memory kill for a certain blank screen, which is a worse bug than the
 * one it set out to fix.
 */

/**
 * The observability door reaches Sentry and React Native, neither of which
 * loads under vitest, so the subscription is mocked by specifier and the
 * captured listener is driven directly.
 */
const pressureState = vi.hoisted(() => {
  const listeners = new Set<(severity: 'moderate' | 'serious') => void>();
  return { listeners };
});
vi.mock('@/observability/memoryPressure', () => ({
  subscribeToMemoryPressure: (listener: (severity: 'moderate' | 'serious') => void) => {
    pressureState.listeners.add(listener);
    return () => pressureState.listeners.delete(listener);
  },
}));

describe('registerMemoryShedders', () => {
  beforeEach(() => {
    pressureState.listeners.clear();
    resetTerminalFeed();
  });

  function firePressure(severity: 'moderate' | 'serious'): void {
    if (pressureState.listeners.size === 0) throw new Error('no shedder was registered');
    for (const listener of [...pressureState.listeners]) listener(severity);
  }

  /**
   * Android's RUNNING_MODERATE means "beginning to run low" and arrives on an
   * ordinary busy device. Shedding there refetches a transcript the user may be
   * reading, in front of them, repeatedly, on a device that was never in
   * trouble. The Android source originally discarded the level entirely, which
   * made every warning look critical.
   */
  it('does not shed on moderate pressure', async () => {
    const { registerMemoryShedders } = await import('@/state/memoryShed');
    registerMemoryShedders();
    retainTerminal('background');
    appendChunk('background', 'offscreen bytes');

    firePressure('moderate');

    expect(isTerminalRetained('background')).toBe(true);
  });

  it('sheds on serious pressure', async () => {
    const { registerMemoryShedders } = await import('@/state/memoryShed');
    registerMemoryShedders();
    retainTerminal('background');
    appendChunk('background', 'offscreen bytes');

    firePressure('serious');

    expect(isTerminalRetained('background')).toBe(false);
  });
});

describe('shedUnwatchedTerminalRings', () => {
  beforeEach(() => {
    resetTerminalFeed();
  });

  it('drops rings nobody is subscribed to', () => {
    retainTerminal('session-a');
    retainTerminal('session-b');
    appendChunk('session-a', 'scrollback a');
    appendChunk('session-b', 'scrollback b');

    expect(shedUnwatchedTerminalRings()).toBe(2);
    expect(isTerminalRetained('session-a')).toBe(false);
    expect(isTerminalRetained('session-b')).toBe(false);
  });

  it('keeps the ring a mounted pane is watching', () => {
    retainTerminal('watched');
    retainTerminal('background');
    appendChunk('watched', 'visible bytes');
    appendChunk('background', 'offscreen bytes');
    const unsubscribe = subscribeChunks('watched', () => undefined);

    expect(shedUnwatchedTerminalRings()).toBe(1);
    // The whole point: a terminal on screen must not go blank.
    expect(isTerminalRetained('watched')).toBe(true);
    expect(getBufferedData('watched')).toBe('visible bytes');
    expect(isTerminalRetained('background')).toBe(false);

    unsubscribe();
  });

  it('sheds a session once its last listener has gone', () => {
    retainTerminal('was-watched');
    appendChunk('was-watched', 'bytes');
    const unsubscribe = subscribeChunks('was-watched', () => undefined);
    expect(shedUnwatchedTerminalRings()).toBe(0);

    unsubscribe();
    expect(shedUnwatchedTerminalRings()).toBe(1);
  });

  it('is idempotent, because listeners fire on every warning', () => {
    retainTerminal('session-a');
    expect(shedUnwatchedTerminalRings()).toBe(1);
    expect(shedUnwatchedTerminalRings()).toBe(0);
    expect(shedUnwatchedTerminalRings()).toBe(0);
  });
});

describe('transcriptStore.shedBackgroundTranscripts', () => {
  beforeEach(() => {
    useTranscriptStore.getState().reset();
  });

  it('keeps only the most recently retained session, which is the one on screen', () => {
    const store = useTranscriptStore.getState();
    store.retainSession('oldest');
    store.retainSession('middle');
    store.retainSession('newest');
    expect(useTranscriptStore.getState().retainedSessionIds).toEqual(['oldest', 'middle', 'newest']);

    useTranscriptStore.getState().shedBackgroundTranscripts();

    // retainedSessionIds is LRU with the newest LAST, so the survivor is the
    // session the user is currently viewing.
    expect(useTranscriptStore.getState().retainedSessionIds).toEqual(['newest']);
    expect(Object.keys(useTranscriptStore.getState().bySessionId)).not.toContain('oldest');
    expect(Object.keys(useTranscriptStore.getState().bySessionId)).not.toContain('middle');
  });

  it('leaves a single retained session entirely alone', () => {
    useTranscriptStore.getState().retainSession('only');
    useTranscriptStore.getState().shedBackgroundTranscripts();

    expect(useTranscriptStore.getState().retainedSessionIds).toEqual(['only']);
  });

  it('is idempotent and safe with nothing retained', () => {
    expect(() => useTranscriptStore.getState().shedBackgroundTranscripts()).not.toThrow();
    expect(useTranscriptStore.getState().retainedSessionIds).toEqual([]);

    useTranscriptStore.getState().retainSession('a');
    useTranscriptStore.getState().retainSession('b');
    useTranscriptStore.getState().shedBackgroundTranscripts();
    useTranscriptStore.getState().shedBackgroundTranscripts();
    expect(useTranscriptStore.getState().retainedSessionIds).toEqual(['b']);
  });
});
