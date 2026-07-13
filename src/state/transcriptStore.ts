import { create } from 'zustand';
import type { TranscriptEntryWire, TranscriptEvent } from '@kangentic/protocol';

/**
 * How many sessions keep their transcript in memory at once. The task
 * screen retains the session it shows (plus the last couple visited, so
 * backing out and returning is instant); everything else drops transcript
 * pushes at this boundary and re-seeds on the next subscribe.
 */
const RETAINED_SESSION_CAP = 3;

export interface TranscriptSessionState {
  entries: TranscriptEntryWire[];
  /**
   * Phone-side push counter (the wire carries no revision). Bumped once per
   * applied push - list extraData and the live-tail reset key on it.
   */
  localRevision: number;
}

interface TranscriptStoreState {
  bySessionId: Record<string, TranscriptSessionState>;
  /** LRU, most recently retained last. */
  retainedSessionIds: string[];
  retainSession: (sessionId: string) => void;
  releaseSession: (sessionId: string) => void;
  applyTranscript: (event: TranscriptEvent) => void;
  reset: () => void;
}

/**
 * Merges a wholesale transcript push while preserving object identity for
 * unchanged entries: the desktop re-pushes the FULL array every revision,
 * but streaming only ever mutates the tail entry, so reusing the previous
 * entry object whenever the uuid matches (except for the new tail, which
 * may have grown blocks under the same uuid) lets row components memo on
 * `previousEntry === nextEntry` instead of deep-diffing.
 */
function mergePreservingIdentity(previousEntries: TranscriptEntryWire[], nextEntries: TranscriptEntryWire[]): TranscriptEntryWire[] {
  if (previousEntries.length === 0) return nextEntries;
  const previousByUuid = new Map(previousEntries.map((entry) => [entry.uuid, entry]));
  return nextEntries.map((entry, index) => {
    const isTailEntry = index === nextEntries.length - 1;
    if (isTailEntry) return entry;
    const previousEntry = previousByUuid.get(entry.uuid);
    return previousEntry && previousEntry.kind === entry.kind ? previousEntry : entry;
  });
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
    const previous = state.bySessionId[event.sessionId];
    const entries = mergePreservingIdentity(previous?.entries ?? [], event.payload);
    set({
      bySessionId: {
        ...state.bySessionId,
        [event.sessionId]: { entries, localRevision: (previous?.localRevision ?? 0) + 1 },
      },
    });
  },

  reset: () => set({ bySessionId: {}, retainedSessionIds: [] }),
}));

export function selectTranscriptForSession(state: TranscriptStoreState, sessionId: string): TranscriptSessionState | null {
  return state.bySessionId[sessionId] ?? null;
}
