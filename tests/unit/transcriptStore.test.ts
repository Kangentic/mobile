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
import { selectChatLens, selectHasMoreHistory, useTranscriptStore } from '@/state/transcriptStore';
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

  it('replaces a mutating tail entry in place, and preserves identity for stable mid-window upserts', () => {
    const { retainSession, applyWindow, applyTranscript } = useTranscriptStore.getState();
    retainSession('sess-1');
    const midEntry = assistantEntryFixture({ uuid: 'a-1' });
    const tailEntry = assistantEntryFixture({ uuid: 'a-2' });
    applyWindow('sess-1', windowPayload(1, 3, 0, [userEntryFixture({ uuid: 'u-0' }), midEntry, tailEntry]));

    // The streaming tail (index 2) grows token by token. It is replaced in place
    // with the new object: we intentionally skip the O(entry-size) content
    // compare on the tail (it changes by definition every delta), so a re-send
    // of the tail does NOT preserve identity - that saves the per-delta stringify
    // and only costs one row re-render.
    const grownTail = assistantEntryFixture({
      uuid: 'a-2',
      blocks: [
        { type: 'text', text: 'working on it' },
        { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
      ],
    });
    applyTranscript(deltaEvent('sess-1', 2, 3, [{ index: 2, entry: grownTail }]));
    expect(useTranscriptStore.getState().bySessionId['sess-1'].entries[2]).toBe(grownTail);

    // A stable mid-window entry (index 1) re-sent byte-identical keeps its object
    // identity so memoized rows skip re-render.
    applyTranscript(deltaEvent('sess-1', 3, 3, [{ index: 1, entry: JSON.parse(JSON.stringify(midEntry)) }]));
    expect(useTranscriptStore.getState().bySessionId['sess-1'].entries[1]).toBe(midEntry);
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

  /**
   * A reset leaves `hasWindow: false` alongside a REAL revision (2, not the
   * old -1 "no window" sentinel) - exactly the case `hasWindow` exists to
   * distinguish from that sentinel. A delta that lands after the reset must
   * still be treated as "no window yet" (recording only that a fetch is
   * needed), because the window really was dropped. If the no-window check
   * regressed from `!previous.hasWindow` back to `previous.revision === -1`,
   * a post-reset revision no longer reads as -1, so this delta would fall
   * through into the upsert path and fabricate a window (entries, hasWindow
   * true) from a session that never actually got one back from the wire.
   */
  it('a delta arriving after a reset still only flags a tail fetch, even though the reset revision is not -1', () => {
    const { retainSession, applyWindow, applyTranscript } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyWindow('sess-1', windowPayload(1, 2, 0, [userEntryFixture({ uuid: 'u-0' }), assistantEntryFixture({ uuid: 'a-1' })]));
    applyTranscript({ kind: 'transcript', sessionId: 'sess-1', taskId: 'task-1', payload: { mode: 'reset', revision: 5, totalEntries: 0 } });

    applyTranscript(deltaEvent('sess-1', 6, 1, [{ index: 0, entry: userEntryFixture({ uuid: 'post-reset' }) }]));

    const session = useTranscriptStore.getState().bySessionId['sess-1'];
    expect(session.hasWindow).toBe(false);
    expect(session.entries).toHaveLength(0);
    expect(session.needsTailFetch).toBe(true);
    // The no-window branch does not adopt the delta's revision either -
    // only a real window fetch (applyWindow) does that.
    expect(session.revision).toBe(5);
  });

  /**
   * The analogous case in applyWindow's older-page check: a post-reset
   * refetch can legitimately land at the SAME revision the reset itself
   * carried (nothing changed in between), with an empty window ending at
   * startIndex 0 - the one shape where a reset's revision and its
   * `previous.hasWindow: false` diverge from the old `revision === -1`
   * reading of "has no window". If `isOlderPage`'s guard regressed from
   * `previous.hasWindow` to a revision-sentinel check, this reads as an
   * older-page PREPEND onto a window that never existed, which skips the
   * wholesale-replace branch and leaves hasWindow/needsTailFetch exactly as
   * the reset left them - the screen would stay stuck thinking it still
   * needs a tail fetch forever, despite a window having just landed.
   */
  it('a post-reset window fetch at the reset\'s own revision replaces the window wholesale, not an older-page prepend', () => {
    const { retainSession, applyTranscript, applyWindow } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyTranscript({ kind: 'transcript', sessionId: 'sess-1', taskId: 'task-1', payload: { mode: 'reset', revision: 5, totalEntries: 0 } });

    applyWindow('sess-1', windowPayload(5, 0, 0, []));

    const session = useTranscriptStore.getState().bySessionId['sess-1'];
    expect(session.hasWindow).toBe(true);
    expect(session.needsTailFetch).toBe(false);
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

/**
 * The Chat lens has TWO readers - ChatPane renders it, SessionScreen gates the
 * terminal's clean-feed parser on it - and they must never disagree, because
 * the reading view is derived from that parser's output.
 */
describe('selectChatLens', () => {
  beforeEach(() => {
    useTranscriptStore.getState().reset();
  });

  it('loads until a window has actually landed', () => {
    const { retainSession } = useTranscriptStore.getState();
    retainSession('sess-1');
    expect(selectChatLens(useTranscriptStore.getState(), 'sess-1')).toBe('loading');
  });

  /**
   * THE REGRESSION. SessionScreen used to call any store entry reporting
   * `totalEntries === 0` the fallback, while ChatPane waited for `hasWindow`.
   * In that gap the terminal was told to run its clean feed while the pane
   * still showed "Loading conversation...", which re-keys TerminalPane's init
   * and re-initialises the WebView for nothing.
   */
  it('does not call an unlanded window the reading-view fallback', () => {
    useTranscriptStore.setState({
      bySessionId: {
        'sess-1': { hasWindow: false, entries: [], startIndex: 0, totalEntries: 0, revision: -1, tailRevision: 0, needsTailFetch: true },
      },
      retainedSessionIds: ['sess-1'],
    });
    expect(selectChatLens(useTranscriptStore.getState(), 'sess-1')).toBe('loading');
  });

  it('picks the reading view for a landed but empty transcript', () => {
    const { retainSession, applyWindow } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyWindow('sess-1', windowPayload(1, 0, 0, []));
    expect(selectChatLens(useTranscriptStore.getState(), 'sess-1')).toBe('reading-view');
  });

  it('picks the conversation feed once the window carries entries', () => {
    const { retainSession, applyWindow } = useTranscriptStore.getState();
    retainSession('sess-1');
    applyWindow('sess-1', windowPayload(1, 1, 0, [userEntryFixture()]));
    expect(selectChatLens(useTranscriptStore.getState(), 'sess-1')).toBe('conversation');
  });

  it('routes a task with no session to the conversation feed, which owns that empty state', () => {
    expect(selectChatLens(useTranscriptStore.getState(), null)).toBe('conversation');
  });
});
