import { create } from 'zustand';
import type {
  ActivityEvent,
  ActivityReasonWire,
  ActivityStateWire,
  ReadStreamResponsePayload,
  SessionUsageWire,
} from '@kangentic/protocol';

export type TriageSection = 'needs-you' | 'working' | 'idle';

export interface SessionActivityEntry {
  sessionId: string;
  taskId: string;
  projectId: string;
  state: ActivityStateWire;
  reason: ActivityReasonWire | null;
  usage: SessionUsageWire | null;
  /** The live outstanding prompt id (permission prompts AND AskUserQuestion/ExitPlanMode pauses), or null. */
  awaitedPromptId: string | null;
  /** Epoch ms of the last snapshot/event touching this session. */
  lastEventAt: number;
  /** Session events since the last markRead (the triage unread badge). */
  unreadCount: number;
  /** 'pending' until the first snapshot lands; 'rejected' when the desktop refused the stream subscribe. */
  feedStatus: 'pending' | 'live' | 'rejected';
}

interface ActivityStoreState {
  bySessionId: Record<string, SessionActivityEntry>;
  registerSession: (sessionId: string, taskId: string, projectId: string) => void;
  applySnapshot: (sessionId: string, taskId: string, projectId: string, snapshot: ReadStreamResponsePayload) => void;
  applyActivityEvent: (event: ActivityEvent) => void;
  markRejected: (sessionId: string) => void;
  removeSession: (sessionId: string) => void;
  markRead: (sessionId: string) => void;
  reset: () => void;
}

function emptyEntry(sessionId: string, taskId: string, projectId: string): SessionActivityEntry {
  return {
    sessionId,
    taskId,
    projectId,
    state: 'idle',
    reason: null,
    usage: null,
    awaitedPromptId: null,
    lastEventAt: Date.now(),
    unreadCount: 0,
    feedStatus: 'pending',
  };
}

export const useActivityStore = create<ActivityStoreState>((set) => ({
  bySessionId: {},

  registerSession: (sessionId, taskId, projectId) =>
    set((state) => {
      const existing = state.bySessionId[sessionId];
      if (existing) {
        if (existing.taskId === taskId && existing.projectId === projectId) return state;
        return { bySessionId: { ...state.bySessionId, [sessionId]: { ...existing, taskId, projectId } } };
      }
      return { bySessionId: { ...state.bySessionId, [sessionId]: emptyEntry(sessionId, taskId, projectId) } };
    }),

  applySnapshot: (sessionId, taskId, projectId, snapshot) =>
    set((state) => {
      const existing = state.bySessionId[sessionId] ?? emptyEntry(sessionId, taskId, projectId);
      return {
        bySessionId: {
          ...state.bySessionId,
          [sessionId]: {
            ...existing,
            taskId,
            projectId,
            state: snapshot.activity.state ?? 'idle',
            reason: snapshot.activity.reason,
            usage: snapshot.usage,
            awaitedPromptId: snapshot.awaitedPromptId,
            lastEventAt: Date.now(),
            feedStatus: 'live',
          },
        },
      };
    }),

  applyActivityEvent: (event) =>
    set((state) => {
      const existing = state.bySessionId[event.sessionId];
      if (!existing) return state;
      const payload = event.payload;
      const updated: SessionActivityEntry = { ...existing, lastEventAt: Date.now() };
      switch (payload.type) {
        case 'activity':
          updated.state = payload.state;
          updated.reason = payload.reason;
          // The engine leaving 'permission' means the prompt resolved; the
          // dedicated permission event usually races ahead of this, but a
          // missed one must not leave a stale answerable prompt behind.
          if (payload.state !== 'permission') updated.awaitedPromptId = null;
          break;
        case 'usage':
          updated.usage = payload.usage;
          break;
        case 'event':
          updated.unreadCount = existing.unreadCount + 1;
          break;
        case 'permission':
          updated.awaitedPromptId = payload.pending ? payload.promptId : null;
          if (payload.pending) updated.state = 'permission';
          break;
      }
      return { bySessionId: { ...state.bySessionId, [event.sessionId]: updated } };
    }),

  markRejected: (sessionId) =>
    set((state) => {
      const existing = state.bySessionId[sessionId];
      if (!existing) return state;
      return { bySessionId: { ...state.bySessionId, [sessionId]: { ...existing, feedStatus: 'rejected' } } };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.bySessionId)) return state;
      const bySessionId = { ...state.bySessionId };
      delete bySessionId[sessionId];
      return { bySessionId };
    }),

  markRead: (sessionId) =>
    set((state) => {
      const existing = state.bySessionId[sessionId];
      if (!existing || existing.unreadCount === 0) return state;
      return { bySessionId: { ...state.bySessionId, [sessionId]: { ...existing, unreadCount: 0 } } };
    }),

  reset: () => set({ bySessionId: {} }),
}));

/**
 * The triage bucketing: 'permission' needs the user (covers permission
 * prompts and AskUserQuestion/ExitPlanMode pauses), 'thinking' is working,
 * 'idle' is idle. An idle-after-work promotion into needs-you is
 * deliberately NOT encoded here yet; it is expressible later as
 * `state === 'idle' && unreadCount > 0` without a store change.
 */
export function sectionForEntry(entry: SessionActivityEntry): TriageSection {
  switch (entry.state) {
    case 'permission':
      return 'needs-you';
    case 'thinking':
      return 'working';
    case 'idle':
      return 'idle';
  }
}

export interface TriageRows {
  section: TriageSection;
  entries: SessionActivityEntry[];
}

const TRIAGE_SECTION_ORDER: readonly TriageSection[] = ['needs-you', 'working', 'idle'];

/** Pure selector for `useActivityStore((state) => selectTriageRows(state))`-style reactive reads. */
export function selectTriageRows(state: { bySessionId: Record<string, SessionActivityEntry> }): TriageRows[] {
  const entries = Object.values(state.bySessionId);
  return TRIAGE_SECTION_ORDER.map((section) => ({
    section,
    entries: entries
      .filter((entry) => sectionForEntry(entry) === section)
      .sort((first, second) => second.lastEventAt - first.lastEventAt),
  }));
}
