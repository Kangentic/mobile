/**
 * transcriptStore: wholesale-replace pushes preserve object identity for
 * unchanged entries (FlashList row memoization depends on it), non-retained
 * sessions drop payloads, and retention is a small LRU.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptEntryWire, TranscriptEvent } from '@kangentic/protocol';
import { useTranscriptStore } from '@/state/transcriptStore';
import { assistantEntryFixture, userEntryFixture } from './helpers/desktopFixtures';

function transcriptEvent(sessionId: string, entries: TranscriptEntryWire[]): TranscriptEvent {
  return { kind: 'transcript', sessionId, taskId: 'task-1', payload: entries };
}

describe('transcriptStore', () => {
  beforeEach(() => {
    useTranscriptStore.getState().reset();
  });

  it('drops pushes for non-retained sessions', () => {
    useTranscriptStore.getState().applyTranscript(transcriptEvent('sess-1', [userEntryFixture()]));
    expect(useTranscriptStore.getState().bySessionId['sess-1']).toBeUndefined();
  });

  it('stores pushes for retained sessions and bumps localRevision per push', () => {
    const { retainSession, applyTranscript } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyTranscript(transcriptEvent('sess-1', [userEntryFixture()]));
    applyTranscript(transcriptEvent('sess-1', [userEntryFixture(), assistantEntryFixture()]));

    const sessionState = useTranscriptStore.getState().bySessionId['sess-1'];
    expect(sessionState.entries).toHaveLength(2);
    expect(sessionState.localRevision).toBe(2);
  });

  it('preserves object identity for unchanged non-tail entries across a wholesale re-push', () => {
    const { retainSession, applyTranscript } = useTranscriptStore.getState();
    retainSession('sess-1');
    const firstUser = userEntryFixture();
    const firstAssistant = assistantEntryFixture();
    applyTranscript(transcriptEvent('sess-1', [firstUser, firstAssistant]));
    const storedFirstPush = useTranscriptStore.getState().bySessionId['sess-1'].entries;

    // The desktop re-pushes the FULL array with fresh objects; only the tail grew.
    const secondUser = userEntryFixture();
    const grownAssistant = assistantEntryFixture({
      blocks: [
        { type: 'text', text: 'working on it' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
      ],
    });
    applyTranscript(transcriptEvent('sess-1', [secondUser, grownAssistant]));

    const storedSecondPush = useTranscriptStore.getState().bySessionId['sess-1'].entries;
    // Non-tail entry: the ORIGINAL object survives (identity equal, so a
    // memoized row skips re-render).
    expect(storedSecondPush[0]).toBe(storedFirstPush[0]);
    // Tail entry: always the fresh object (its blocks grow under one uuid).
    expect(storedSecondPush[1]).toBe(grownAssistant);
    expect(storedSecondPush[1]).not.toBe(firstAssistant);
  });

  it('evicts the least recently retained session past the cap of 3', () => {
    const { retainSession, applyTranscript } = useTranscriptStore.getState();
    for (const sessionId of ['sess-1', 'sess-2', 'sess-3']) {
      retainSession(sessionId);
      applyTranscript(transcriptEvent(sessionId, [userEntryFixture()]));
    }
    // Re-retaining sess-1 moves it to most-recent; adding sess-4 evicts sess-2.
    retainSession('sess-1');
    retainSession('sess-4');

    const state = useTranscriptStore.getState();
    expect(state.retainedSessionIds).toEqual(['sess-3', 'sess-1', 'sess-4']);
    expect(state.bySessionId['sess-2']).toBeUndefined();
    expect(state.bySessionId['sess-1']).toBeDefined();
  });

  it('releaseSession drops the transcript and retention slot', () => {
    const { retainSession, applyTranscript, releaseSession } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyTranscript(transcriptEvent('sess-1', [userEntryFixture()]));
    releaseSession('sess-1');

    const state = useTranscriptStore.getState();
    expect(state.retainedSessionIds).toEqual([]);
    expect(state.bySessionId['sess-1']).toBeUndefined();
  });
});
