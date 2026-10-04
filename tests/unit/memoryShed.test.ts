import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TranscriptEventPayload, TranscriptUpsertWire, TranscriptWindowResponsePayload } from '@kangentic/protocol';
import { ARCHIVED_PROJECT_CAP, useBoardStore } from '@/state/boardStore';
import { selectTranscriptForSession, useTranscriptStore } from '@/state/transcriptStore';
import { boardTaskFixture, userEntryFixture } from '@/devsupport/desktopFixtures';
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
type Severity = 'backgrounded' | 'moderate' | 'serious';

const pressureState = vi.hoisted(() => {
  const listeners = new Set<(severity: Severity) => void>();
  return { listeners };
});
vi.mock('@/observability/memoryPressure', () => ({
  subscribeToMemoryPressure: (listener: (severity: Severity) => void) => {
    pressureState.listeners.add(listener);
    return () => pressureState.listeners.delete(listener);
  },
}));

function windowPayload(
  revision: number,
  totalEntries: number,
  startIndex: number,
  entries: TranscriptWindowResponsePayload['entries'],
): TranscriptWindowResponsePayload {
  return { revision, totalEntries, startIndex, entries };
}

function deltaEvent(
  sessionId: string,
  revision: number,
  totalEntries: number,
  upserts: TranscriptUpsertWire[],
): { kind: 'transcript'; sessionId: string; taskId: string; payload: TranscriptEventPayload } {
  return { kind: 'transcript', sessionId, taskId: 'task-1', payload: { mode: 'delta', revision, totalEntries, upserts } };
}

describe('registerMemoryShedders', () => {
  beforeEach(() => {
    pressureState.listeners.clear();
    resetTerminalFeed();
    useTranscriptStore.getState().reset();
    useBoardStore.getState().reset();
  });

  function firePressure(severity: Severity): void {
    if (pressureState.listeners.size === 0) throw new Error('no shedder was registered');
    for (const listener of [...pressureState.listeners]) listener(severity);
  }

  /** A retained background session with a landed window, for the transcript half of the wiring. */
  function seedTranscriptBackgroundSession(): void {
    const { retainSession, applyWindow } = useTranscriptStore.getState();
    retainSession('memory-shed-background');
    retainSession('memory-shed-onscreen');
    applyWindow('memory-shed-background', windowPayload(1, 1, 0, [userEntryFixture({ uuid: 'bg-entry' })]));
    applyWindow('memory-shed-onscreen', windowPayload(1, 1, 0, [userEntryFixture({ uuid: 'onscreen-entry' })]));
  }

  /** Two fully-loaded project archives, for the board half of the wiring. Neither is on screen or in flight, so a shed keeps only the more recently loaded one. */
  function seedArchivedProjects(): void {
    const projectIds = Array.from({ length: ARCHIVED_PROJECT_CAP }, (_, index) => `memory-shed-project-${index}`);
    for (const projectId of projectIds) {
      useBoardStore.getState().applyArchivedPage(
        { projectId, archivedTasks: [boardTaskFixture({ id: `${projectId}-task`, archived_at: '2026-07-20T00:00:00.000Z' })], archivedTotalCount: 1, summariesByTaskId: {} },
        { append: false },
      );
    }
  }

  /**
   * Android's RUNNING_MODERATE means "beginning to run low" and arrives on an
   * ordinary busy device. Shedding there refetches a transcript the user may be
   * reading, in front of them, repeatedly, on a device that was never in
   * trouble. The Android source originally discarded the level entirely, which
   * made every warning look critical.
   *
   * Covers all three shedders, not just the terminal ring: a memoryShed.ts
   * edit that wired the transcript or board store to fire on 'moderate' would
   * refetch a Done column or a transcript the user is actively looking at.
   */
  it('does not shed on moderate pressure', async () => {
    const { registerMemoryShedders } = await import('@/state/memoryShed');
    registerMemoryShedders();
    retainTerminal('background');
    appendChunk('background', 'offscreen bytes');
    seedTranscriptBackgroundSession();
    seedArchivedProjects();

    firePressure('moderate');

    expect(isTerminalRetained('background')).toBe(true);
    expect(selectTranscriptForSession(useTranscriptStore.getState(), 'memory-shed-background')?.hasWindow).toBe(true);
    expect(Object.keys(useBoardStore.getState().archivedByProjectId)).toHaveLength(ARCHIVED_PROJECT_CAP);
  });

  /**
   * The black-terminal regression, through the real wiring. A mounted session
   * screen's pane has NO chunk listener for routine windows: before its WebView
   * reports ready, and across recoverWebView after the OS killed the renderer.
   * These two cases used to assert the ring WAS shed there - and a deleted ring
   * is never re-seeded and stops reading as retained, so the screen's want for
   * terminal bytes went with it and the mirror stayed black until a remount.
   * Android 14+ sends 'backgrounded' on every app switch, so that was routine.
   *
   * Mutation that reddens both: drop the retained-ring skip from
   * shedUnwatchedTerminalRings.
   */
  it('never sheds a retained terminal ring on serious pressure, listener or not', async () => {
    const { registerMemoryShedders } = await import('@/state/memoryShed');
    registerMemoryShedders();
    retainTerminal('mid-remount');
    appendChunk('mid-remount', 'the frame on screen');

    firePressure('serious');

    expect(isTerminalRetained('mid-remount')).toBe(true);
    expect(getBufferedData('mid-remount')).toBe('the frame on screen');
  });

  it('never sheds a retained terminal ring when backgrounded, the signal Android 14+ sends on every app switch', async () => {
    const { registerMemoryShedders } = await import('@/state/memoryShed');
    registerMemoryShedders();
    retainTerminal('mid-remount');
    appendChunk('mid-remount', 'the frame on screen');

    firePressure('backgrounded');

    expect(isTerminalRetained('mid-remount')).toBe(true);
    expect(getBufferedData('mid-remount')).toBe('the frame on screen');
  });

  /**
   * The wiring itself: `registerMemoryShedders` reaching all THREE stores, not
   * just the terminal ring. Before this, deleting the transcript or board
   * call from `src/state/memoryShed.ts` failed no test at all - the terminal
   * assertions above pass regardless of whether the other two shedders were
   * ever called.
   */
  it('reaches the transcript store on serious pressure, emptying the background window', async () => {
    const { registerMemoryShedders } = await import('@/state/memoryShed');
    registerMemoryShedders();
    seedTranscriptBackgroundSession();

    firePressure('serious');

    const backgroundSession = selectTranscriptForSession(useTranscriptStore.getState(), 'memory-shed-background');
    // Emptied, not deleted: the entry must still exist (revoking retention
    // entirely, the old contract, drops the key from bySessionId outright).
    expect(backgroundSession).not.toBeNull();
    expect(backgroundSession?.hasWindow).toBe(false);
    expect(backgroundSession?.needsTailFetch).toBe(true);
    // The on-screen session (newest-retained) must be untouched.
    const onscreenSession = selectTranscriptForSession(useTranscriptStore.getState(), 'memory-shed-onscreen');
    expect(onscreenSession).not.toBeNull();
    expect(onscreenSession?.hasWindow).toBe(true);
  });

  it('reaches the board store on serious pressure, shedding archived pages down to the one kept project', async () => {
    const { registerMemoryShedders } = await import('@/state/memoryShed');
    registerMemoryShedders();
    seedArchivedProjects();

    firePressure('serious');

    expect(Object.keys(useBoardStore.getState().archivedByProjectId)).toHaveLength(1);
  });

  it('reaches the transcript and board stores when backgrounded too, the only signal Android 14+ sends', async () => {
    const { registerMemoryShedders } = await import('@/state/memoryShed');
    registerMemoryShedders();
    seedTranscriptBackgroundSession();
    seedArchivedProjects();

    firePressure('backgrounded');

    const backgroundSession = selectTranscriptForSession(useTranscriptStore.getState(), 'memory-shed-background');
    expect(backgroundSession).not.toBeNull();
    expect(backgroundSession?.hasWindow).toBe(false);
    expect(Object.keys(useBoardStore.getState().archivedByProjectId)).toHaveLength(1);
  });
});

describe('shedUnwatchedTerminalRings', () => {
  beforeEach(() => {
    resetTerminalFeed();
  });

  /**
   * Every ring that exists is held by a mounted session screen (retainTerminal
   * creates it, the last releaseTerminal deletes it), so the terminal arm is
   * inert by construction. This pins that, rather than pretending it sheds.
   */
  it('keeps every retained ring, watched or not', () => {
    retainTerminal('watched');
    retainTerminal('pane-not-ready');
    appendChunk('watched', 'visible bytes');
    appendChunk('pane-not-ready', 'bytes waiting for the remounted page');
    const unsubscribe = subscribeChunks('watched', () => undefined);

    expect(shedUnwatchedTerminalRings()).toBe(0);
    expect(getBufferedData('watched')).toBe('visible bytes');
    expect(getBufferedData('pane-not-ready')).toBe('bytes waiting for the remounted page');

    unsubscribe();
  });

  it('keeps a ring once its last listener has gone, while a screen still holds it', () => {
    retainTerminal('was-watched');
    appendChunk('was-watched', 'bytes');
    const unsubscribe = subscribeChunks('was-watched', () => undefined);
    unsubscribe();

    expect(shedUnwatchedTerminalRings()).toBe(0);
    expect(isTerminalRetained('was-watched')).toBe(true);
  });

  it('is idempotent, because listeners fire on every warning', () => {
    retainTerminal('session-a');
    expect(shedUnwatchedTerminalRings()).toBe(0);
    expect(shedUnwatchedTerminalRings()).toBe(0);
    expect(isTerminalRetained('session-a')).toBe(true);
  });
});

/**
 * RETENTION IS NOT REVOKED (see the docstring on `shedBackgroundTranscripts`
 * itself). The old contract deleted a shed session from `retainedSessionIds`
 * outright, which made the drop unrecoverable: `applyTranscript` and
 * `applyWindow` both no-op for a session that is not retained, and a
 * `SessionScreen` lower in the navigation stack stays mounted with no mount
 * effect left to re-run. The new contract only empties the payload and
 * leaves the retention claim alone, so a later window or delta lands
 * normally.
 */
describe('transcriptStore.shedBackgroundTranscripts', () => {
  beforeEach(() => {
    useTranscriptStore.getState().reset();
  });

  function retainWithWindow(sessionId: string, totalEntries: number): void {
    const { retainSession, applyWindow } = useTranscriptStore.getState();
    retainSession(sessionId);
    applyWindow(sessionId, windowPayload(1, totalEntries, 0, [userEntryFixture({ uuid: `${sessionId}-entry` })]));
  }

  it('leaves retainedSessionIds completely untouched - retention is a screen-owned claim, not something the shed may revoke', () => {
    retainWithWindow('oldest', 1);
    retainWithWindow('middle', 1);
    retainWithWindow('newest', 1);

    useTranscriptStore.getState().shedBackgroundTranscripts();

    expect(useTranscriptStore.getState().retainedSessionIds).toEqual(['oldest', 'middle', 'newest']);
  });

  it('empties a background session that had a window, preserving totalEntries and advancing tailRevision', () => {
    retainWithWindow('oldest', 7);
    retainWithWindow('newest', 1);
    const beforeShed = selectTranscriptForSession(useTranscriptStore.getState(), 'oldest');

    useTranscriptStore.getState().shedBackgroundTranscripts();

    const shed = selectTranscriptForSession(useTranscriptStore.getState(), 'oldest');
    // Emptied, not deleted: the old contract removed this key from
    // bySessionId entirely rather than resetting it in place.
    expect(shed).not.toBeNull();
    expect(shed?.hasWindow).toBe(false);
    expect(shed?.entries).toEqual([]);
    expect(shed?.needsTailFetch).toBe(true);
    expect(shed?.totalEntries).toBe(7);
    // Every other writer only ever moves tailRevision forward, and
    // ConversationTab resets its live-tail buffer on any CHANGE to it - a
    // rewind to emptySessionState()'s 0 would fire that reset a second time.
    expect(shed?.tailRevision).toBeGreaterThan(beforeShed?.tailRevision ?? -1);
  });

  it('leaves the newest retained session entirely untouched', () => {
    retainWithWindow('oldest', 1);
    retainWithWindow('newest', 3);
    const beforeShed = selectTranscriptForSession(useTranscriptStore.getState(), 'newest');

    useTranscriptStore.getState().shedBackgroundTranscripts();

    expect(selectTranscriptForSession(useTranscriptStore.getState(), 'newest')).toBe(beforeShed);
  });

  it('a shed session is recoverable: a later window fetch and a later delta both still land, not discarded', () => {
    retainWithWindow('oldest', 1);
    retainWithWindow('newest', 1);
    useTranscriptStore.getState().shedBackgroundTranscripts();

    // A fetched window must still populate the session. Under the old
    // contract this session was dropped from retainedSessionIds, so
    // applyWindow's `!retainedSessionIds.includes` guard would have
    // discarded it silently and permanently.
    useTranscriptStore.getState().applyWindow('oldest', windowPayload(2, 2, 0, [userEntryFixture({ uuid: 'recovered' })]));
    const afterWindow = selectTranscriptForSession(useTranscriptStore.getState(), 'oldest');
    // Under the old (retention-revoking) contract this session was no longer
    // in retainedSessionIds, so applyWindow's own guard would have silently
    // discarded the fetch and left no entry at all.
    expect(afterWindow).not.toBeNull();
    expect(afterWindow?.hasWindow).toBe(true);
    expect(afterWindow?.entries.map((entry) => entry.uuid)).toEqual(['recovered']);

    // A live delta landing after that must also be accepted, not dropped.
    // Index 1 is contiguous with the one-entry window applyWindow just
    // landed (startIndex 0, one entry already at position 0).
    useTranscriptStore.getState().applyTranscript(deltaEvent('oldest', 3, 3, [{ index: 1, entry: userEntryFixture({ uuid: 'live' }) }]));
    const afterDelta = selectTranscriptForSession(useTranscriptStore.getState(), 'oldest');
    expect(afterDelta?.entries.map((entry) => entry.uuid)).toEqual(['recovered', 'live']);
  });

  it('is safe with nothing retained', () => {
    expect(() => useTranscriptStore.getState().shedBackgroundTranscripts()).not.toThrow();
    expect(useTranscriptStore.getState().retainedSessionIds).toEqual([]);
  });

  it('leaves a single retained session entirely untouched, entries included', () => {
    retainWithWindow('only', 4);
    const beforeShed = selectTranscriptForSession(useTranscriptStore.getState(), 'only');

    useTranscriptStore.getState().shedBackgroundTranscripts();

    expect(useTranscriptStore.getState().retainedSessionIds).toEqual(['only']);
    expect(selectTranscriptForSession(useTranscriptStore.getState(), 'only')).toBe(beforeShed);
  });

  it('is idempotent: shedding an already-shed session changes nothing further', () => {
    retainWithWindow('oldest', 5);
    retainWithWindow('newest', 1);
    useTranscriptStore.getState().shedBackgroundTranscripts();
    const afterFirstShed = selectTranscriptForSession(useTranscriptStore.getState(), 'oldest');

    useTranscriptStore.getState().shedBackgroundTranscripts();

    expect(selectTranscriptForSession(useTranscriptStore.getState(), 'oldest')).toEqual(afterFirstShed);
    expect(useTranscriptStore.getState().retainedSessionIds).toEqual(['oldest', 'newest']);
  });

  /**
   * Reference-stable (`bySessionId` itself unchanged) on a pass that drops
   * nothing, not merely a pass with one-or-zero retained. Two retained
   * sessions where the background one has no window YET is the shape that
   * hits the loop's `!shedSession.hasWindow` continue for every candidate,
   * so `shedAnySession` never flips true. Listeners fire on every warning,
   * and Android 14+ delivers 'backgrounded' on every app switch - a fresh
   * object each time would re-render every transcript consumer for a no-op.
   */
  it('returns the same bySessionId object when there is nothing to drop', () => {
    const { retainSession, applyWindow } = useTranscriptStore.getState();
    retainSession('background-no-window');
    retainSession('newest');
    applyWindow('newest', windowPayload(1, 1, 0, [userEntryFixture({ uuid: 'newest-entry' })]));
    const beforeShed = useTranscriptStore.getState().bySessionId;

    useTranscriptStore.getState().shedBackgroundTranscripts();

    expect(useTranscriptStore.getState().bySessionId).toBe(beforeShed);
  });
});
