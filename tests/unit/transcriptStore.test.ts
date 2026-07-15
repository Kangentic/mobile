/**
 * transcriptStore: windowed transcript state (protocol v2). Windows load
 * via applyWindow (newest first, older pages prepend), live deltas upsert
 * into or append after the window, resets and gaps flag a tail re-fetch,
 * identity is preserved for unchanged entries (FlashList row memoization
 * depends on it), non-retained sessions drop payloads, and retention is a
 * small LRU.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { TranscriptEventPayload, TranscriptUpsertWire, TranscriptWindowResponsePayload } from '@kangentic/protocol';
import { selectHasMoreHistory, useTranscriptStore } from '@/state/transcriptStore';
import { assistantEntryFixture, userEntryFixture } from '@/devsupport/desktopFixtures';

function deltaEvent(sessionId: string, revision: number, totalEntries: number, upserts: TranscriptUpsertWire[]): { kind: 'transcript'; sessionId: string; taskId: string; payload: TranscriptEventPayload } {
  return { kind: 'transcript', sessionId, taskId: 'task-1', payload: { mode: 'delta', revision, totalEntries, upserts } };
}

function windowPayload(revision: number, totalEntries: number, startIndex: number, entries: TranscriptWindowResponsePayload['entries']): TranscriptWindowResponsePayload {
  return { revision, totalEntries, startIndex, entries };
}

describe('transcriptStore', () => {
  beforeEach(() => {
    useTranscriptStore.getState().reset();
  });

  it('drops deltas and windows for non-retained sessions', () => {
    useTranscriptStore.getState().applyTranscript(deltaEvent('sess-1', 1, 1, [{ index: 0, entry: userEntryFixture() }]));
    useTranscriptStore.getState().applyWindow('sess-1', windowPayload(1, 1, 0, [userEntryFixture()]));
    expect(useTranscriptStore.getState().bySessionId['sess-1']).toBeUndefined();
  });

  it('applyWindow seeds the window and clears needsTailFetch', () => {
    const { retainSession, applyWindow } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyWindow('sess-1', windowPayload(3, 120, 118, [userEntryFixture({ uuid: 'u-118' }), assistantEntryFixture({ uuid: 'a-119' })]));

    const session = useTranscriptStore.getState().bySessionId['sess-1'];
    expect(session.entries.map((entry) => entry.uuid)).toEqual(['u-118', 'a-119']);
    expect(session.startIndex).toBe(118);
    expect(session.totalEntries).toBe(120);
    expect(session.revision).toBe(3);
    expect(session.needsTailFetch).toBe(false);
    expect(selectHasMoreHistory(useTranscriptStore.getState(), 'sess-1')).toBe(true);
  });

  it('a delta before any window only flags a tail fetch', () => {
    const { retainSession, applyTranscript } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyTranscript(deltaEvent('sess-1', 5, 40, [{ index: 39, entry: userEntryFixture() }]));

    const session = useTranscriptStore.getState().bySessionId['sess-1'];
    expect(session.entries).toHaveLength(0);
    expect(session.needsTailFetch).toBe(true);
  });

  it('appends contiguous delta upserts past the window end and bumps tailRevision', () => {
    const { retainSession, applyWindow, applyTranscript } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyWindow('sess-1', windowPayload(1, 2, 0, [userEntryFixture({ uuid: 'u-0' }), assistantEntryFixture({ uuid: 'a-1' })]));
    const before = useTranscriptStore.getState().bySessionId['sess-1'];

    applyTranscript(deltaEvent('sess-1', 2, 3, [{ index: 2, entry: userEntryFixture({ uuid: 'u-2' }) }]));

    const session = useTranscriptStore.getState().bySessionId['sess-1'];
    expect(session.entries.map((entry) => entry.uuid)).toEqual(['u-0', 'a-1', 'u-2']);
    expect(session.totalEntries).toBe(3);
    expect(session.tailRevision).toBe(before.tailRevision + 1);
    // Untouched entries keep object identity for row memoization.
    expect(session.entries[0]).toBe(before.entries[0]);
  });

  it('replaces a mutating tail entry in place (streaming turn) and preserves identity for content-identical upserts', () => {
    const { retainSession, applyWindow, applyTranscript } = useTranscriptStore.getState();
    retainSession('sess-1');
    const original = assistantEntryFixture({ uuid: 'a-1' });
    applyWindow('sess-1', windowPayload(1, 2, 0, [userEntryFixture({ uuid: 'u-0' }), original]));

    const grown = assistantEntryFixture({
      uuid: 'a-1',
      blocks: [
        { type: 'text', text: 'working on it' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
      ],
    });
    applyTranscript(deltaEvent('sess-1', 2, 2, [{ index: 1, entry: grown }]));

    const session = useTranscriptStore.getState().bySessionId['sess-1'];
    expect(session.entries[1]).toBe(grown);

    // A byte-identical re-send keeps the previous object.
    applyTranscript(deltaEvent('sess-1', 3, 2, [{ index: 1, entry: JSON.parse(JSON.stringify(grown)) }]));
    expect(useTranscriptStore.getState().bySessionId['sess-1'].entries[1]).toBe(grown);
  });

  it('ignores stale deltas whose revision is behind the window', () => {
    const { retainSession, applyWindow, applyTranscript } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyWindow('sess-1', windowPayload(5, 1, 0, [userEntryFixture({ uuid: 'u-0' })]));
    applyTranscript(deltaEvent('sess-1', 4, 9, [{ index: 1, entry: userEntryFixture({ uuid: 'stale' }) }]));

    const session = useTranscriptStore.getState().bySessionId['sess-1'];
    expect(session.entries.map((entry) => entry.uuid)).toEqual(['u-0']);
    expect(session.revision).toBe(5);
  });

  it('a gap past the window end keeps the window intact and flags a tail fetch', () => {
    const { retainSession, applyWindow, applyTranscript } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyWindow('sess-1', windowPayload(1, 1, 0, [userEntryFixture({ uuid: 'u-0' })]));

    applyTranscript(deltaEvent('sess-1', 2, 5, [{ index: 4, entry: userEntryFixture({ uuid: 'u-4' }) }]));

    const session = useTranscriptStore.getState().bySessionId['sess-1'];
    expect(session.entries.map((entry) => entry.uuid)).toEqual(['u-0']);
    expect(session.needsTailFetch).toBe(true);
  });

  it('a reset drops the window and flags a tail fetch', () => {
    const { retainSession, applyWindow, applyTranscript } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyWindow('sess-1', windowPayload(1, 2, 0, [userEntryFixture({ uuid: 'u-0' }), assistantEntryFixture({ uuid: 'a-1' })]));

    applyTranscript({ kind: 'transcript', sessionId: 'sess-1', taskId: 'task-1', payload: { mode: 'reset', revision: 2, totalEntries: 1 } });

    const session = useTranscriptStore.getState().bySessionId['sess-1'];
    expect(session.entries).toHaveLength(0);
    expect(session.needsTailFetch).toBe(true);
    expect(session.revision).toBe(2);
  });

  it('prepends an older contiguous page without touching tailRevision', () => {
    const { retainSession, applyWindow } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyWindow('sess-1', windowPayload(4, 10, 8, [userEntryFixture({ uuid: 'u-8' }), userEntryFixture({ uuid: 'u-9' })]));
    const before = useTranscriptStore.getState().bySessionId['sess-1'];

    applyWindow('sess-1', windowPayload(4, 10, 6, [userEntryFixture({ uuid: 'u-6' }), userEntryFixture({ uuid: 'u-7' })]));

    const session = useTranscriptStore.getState().bySessionId['sess-1'];
    expect(session.entries.map((entry) => entry.uuid)).toEqual(['u-6', 'u-7', 'u-8', 'u-9']);
    expect(session.startIndex).toBe(6);
    expect(session.tailRevision).toBe(before.tailRevision);
    expect(session.entries[2]).toBe(before.entries[0]);
  });

  it('evicts the least recently retained session past the cap of 3', () => {
    const { retainSession, applyWindow } = useTranscriptStore.getState();
    for (const sessionId of ['sess-1', 'sess-2', 'sess-3']) {
      retainSession(sessionId);
      applyWindow(sessionId, windowPayload(1, 1, 0, [userEntryFixture()]));
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
    const { retainSession, applyWindow, releaseSession } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyWindow('sess-1', windowPayload(1, 1, 0, [userEntryFixture()]));
    releaseSession('sess-1');

    const state = useTranscriptStore.getState();
    expect(state.retainedSessionIds).toEqual([]);
    expect(state.bySessionId['sess-1']).toBeUndefined();
  });
});
