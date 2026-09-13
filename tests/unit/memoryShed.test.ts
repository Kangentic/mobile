import { beforeEach, describe, expect, it } from 'vitest';
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
