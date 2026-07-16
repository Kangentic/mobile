import { create } from 'zustand';
import type { TranscriptEntryWire, TranscriptEvent, TranscriptWindowResponsePayload } from '@kangentic/protocol';

/**
 * How many sessions keep their transcript window in memory at once. The
 * task screen retains the session it shows (plus the last couple visited,
 * so backing out and returning is instant); everything else drops
 * transcript deltas at this boundary and re-fetches a window on the next
 * screen open.
 */
const RETAINED_SESSION_CAP = 3;

/**
 * A contiguous window of the session's transcript (protocol v2): the
 * desktop never sends the whole conversation. `entries[0]` sits at
 * absolute index `startIndex` in the full transcript; older history is
 * paged in via transcript-window requests, and live deltas upsert into or
 * append after the window.
 */
export interface TranscriptSessionState {
  entries: TranscriptEntryWire[];
  /** Absolute index of entries[0] in the full transcript. > 0 means more history exists above the window. */
  startIndex: number;
  /** Full transcript length at `revision` - drives the load-older affordance. */
  totalEntries: number;
  /** The desktop's whole-transcript revision this window reflects. */
  revision: number;
  /**
   * Bumped only when settled content lands at or past the previous window
   * end - i.e. the streaming turn produced new tail entries. The live-tail
   * buffer resets on this, NOT on older-page prepends or mid-window edits,
   * so paging history never wipes an in-progress stream render.
   */
  tailRevision: number;
  /**
   * Set when a delta arrived that this window cannot apply (a gap past the
   * window end, a uuid conflict, a reset signal, or a delta seen before
   * any window). The screen re-requests the newest window when it sees
   * this; deltas keep being tracked meanwhile.
   */
  needsTailFetch: boolean;
}

interface TranscriptStoreState {
  bySessionId: Record<string, TranscriptSessionState>;
  /** LRU, most recently retained last. */
  retainedSessionIds: string[];
  retainSession: (sessionId: string) => void;
  releaseSession: (sessionId: string) => void;
  applyTranscript: (event: TranscriptEvent) => void;
  applyWindow: (sessionId: string, window: TranscriptWindowResponsePayload) => void;
  reset: () => void;
}

function emptySessionState(): TranscriptSessionState {
  return { entries: [], startIndex: 0, totalEntries: 0, revision: -1, tailRevision: 0, needsTailFetch: true };
}

/** Reuse the previous entry object when content is unchanged so memoized rows skip re-render on `previous === next`. */
function preserveIdentity(previousEntry: TranscriptEntryWire | undefined, nextEntry: TranscriptEntryWire): TranscriptEntryWire {
  if (!previousEntry || previousEntry.uuid !== nextEntry.uuid) return nextEntry;
  return JSON.stringify(previousEntry) === JSON.stringify(nextEntry) ? previousEntry : nextEntry;
}

export const useTranscriptStore = create<TranscriptStoreState>((set, get) => ({
  bySessionId: {},
  retainedSessionIds: [],

  retainSession: (sessionId) =>
    set((state) => {
      const withoutSession = state.retainedSessionIds.filter((retainedId) => retainedId !== sessionId);
      const retainedSessionIds = [...withoutSession, sessionId];
      const evictedIds = retainedSessionIds.slice(0, Math.max(0, retainedSessionIds.length - RETAINED_SESSION_CAP));
      const keptIds = retainedSessionIds.slice(Math.max(0, retainedSessionIds.length - RETAINED_SESSION_CAP));
      if (evictedIds.length === 0) return { retainedSessionIds: keptIds };
      const bySessionId = { ...state.bySessionId };
      for (const evictedId of evictedIds) delete bySessionId[evictedId];
      return { retainedSessionIds: keptIds, bySessionId };
    }),

  releaseSession: (sessionId) =>
    set((state) => {
      if (!state.retainedSessionIds.includes(sessionId)) return state;
      const bySessionId = { ...state.bySessionId };
      delete bySessionId[sessionId];
      return {
        retainedSessionIds: state.retainedSessionIds.filter((retainedId) => retainedId !== sessionId),
        bySessionId,
      };
    }),

  applyTranscript: (event) => {
    const state = get();
    // Non-retained sessions drop transcript payloads entirely - triage only
    // needs activity state, and a full conversation per background session
    // would grow without bound.
    if (!state.retainedSessionIds.includes(event.sessionId)) return;
    const previous = state.bySessionId[event.sessionId] ?? emptySessionState();
    const payload = event.payload;

    // Stale or duplicate delta (rekey replays, chunk arriving after a newer
    // window): revisions only move forward.
    if (payload.revision < previous.revision) return;

    if (payload.mode === 'reset') {
      set({
        bySessionId: {
          ...state.bySessionId,
          [event.sessionId]: {
            ...emptySessionState(),
            revision: payload.revision,
            totalEntries: payload.totalEntries,
            tailRevision: previous.tailRevision + 1,
          },
        },
      });
      return;
    }

    // A delta with no window yet only records that a fetch is needed - the
    // window request will bring the actual entries.
    if (previous.revision === -1) {
      set({
        bySessionId: {
          ...state.bySessionId,
          [event.sessionId]: { ...previous, totalEntries: payload.totalEntries, needsTailFetch: true },
        },
      });
      return;
    }

    const windowEnd = previous.startIndex + previous.entries.length;
    let entries = previous.entries;
    let tailGrew = false;
    let gap = false;

    for (const upsert of payload.upserts) {
      if (upsert.index < previous.startIndex) continue; // above/below the loaded window - not visible
      const position = upsert.index - previous.startIndex;
      if (position < entries.length) {
        if (entries === previous.entries) entries = [...previous.entries];
        const isTail = upsert.index >= windowEnd - 1;
        // The streaming tail entry changes on every delta by definition, so the
        // O(entry-size) JSON.stringify identity check in preserveIdentity is pure
        // waste there (it always returns the new entry, and the tail entry grows
        // token by token). Only run it for stable mid-window entries, where an
        // unchanged upsert should reuse the object so memoized rows skip re-render.
        entries[position] = isTail ? upsert.entry : preserveIdentity(previous.entries[position], upsert.entry);
        if (isTail) tailGrew = true;
      } else if (position === entries.length) {
        if (entries === previous.entries) entries = [...previous.entries];
        entries.push(upsert.entry);
        tailGrew = true;
      } else {
        // A hole past the window end - entries between were never received
        // (e.g. deltas dropped while this session was unretained).
        gap = true;
        break;
      }
    }

    set({
      bySessionId: {
        ...state.bySessionId,
        [event.sessionId]: {
          entries: gap ? previous.entries : entries,
          startIndex: previous.startIndex,
          totalEntries: payload.totalEntries,
          revision: payload.revision,
          tailRevision: tailGrew && !gap ? previous.tailRevision + 1 : previous.tailRevision,
          needsTailFetch: previous.needsTailFetch || gap,
        },
      },
    });
  },

  applyWindow: (sessionId, window) => {
    const state = get();
    if (!state.retainedSessionIds.includes(sessionId)) return;
    const previous = state.bySessionId[sessionId] ?? emptySessionState();

    const windowEnd = window.startIndex + window.entries.length;
    const previousEnd = previous.startIndex + previous.entries.length;

    // An older-history page that ends exactly where the current window
    // starts extends it upward; anything else (first load, refetch after a
    // reset/gap, revision moved) replaces the window wholesale.
    const isOlderPage = previous.revision !== -1 && window.revision === previous.revision && windowEnd === previous.startIndex;

    if (isOlderPage) {
      set({
        bySessionId: {
          ...state.bySessionId,
          [sessionId]: {
            ...previous,
            entries: [...window.entries, ...previous.entries],
            startIndex: window.startIndex,
            totalEntries: window.totalEntries,
          },
        },
      });
      return;
    }

    // Wholesale window: preserve identity for entries that were already
    // loaded at the same absolute index so unchanged rows skip re-render.
    const entries = window.entries.map((entry, position) => {
      const absoluteIndex = window.startIndex + position;
      const previousPosition = absoluteIndex - previous.startIndex;
      const previousEntry =
        previousPosition >= 0 && previousPosition < previous.entries.length ? previous.entries[previousPosition] : undefined;
      return preserveIdentity(previousEntry, entry);
    });

    set({
      bySessionId: {
        ...state.bySessionId,
        [sessionId]: {
          entries,
          startIndex: window.startIndex,
          totalEntries: window.totalEntries,
          revision: window.revision,
          tailRevision: windowEnd > previousEnd || previous.revision === -1 ? previous.tailRevision + 1 : previous.tailRevision,
          needsTailFetch: false,
        },
      },
    });
  },

  reset: () => set({ bySessionId: {}, retainedSessionIds: [] }),
}));

export function selectTranscriptForSession(state: TranscriptStoreState, sessionId: string): TranscriptSessionState | null {
  return state.bySessionId[sessionId] ?? null;
}

export function selectHasMoreHistory(state: TranscriptStoreState, sessionId: string): boolean {
  const session = state.bySessionId[sessionId];
  return session ? session.startIndex > 0 : false;
}
