import { create } from 'zustand';
import { mockAgentSessions } from './mockData';

export type ActivitySection = 'needs-you' | 'working' | 'idle';

export interface AgentSession {
  id: string;
  title: string;
  repository: string;
  section: ActivitySection;
  statusLabel: string;
  /** ISO 8601. */
  lastUpdatedAt: string;
  unreadCount: number;
  /** Set only when section is "needs-you". */
  pendingPromptSummary?: string;
}

interface ActivityState {
  sessions: AgentSession[];
}

export const useActivityStore = create<ActivityState>(() => ({
  sessions: mockAgentSessions,
}));

export function selectSessionsBySection(section: ActivitySection): AgentSession[] {
  return useActivityStore
    .getState()
    .sessions.filter((session) => session.section === section)
    .sort((a, b) => (a.lastUpdatedAt === b.lastUpdatedAt ? 0 : a.lastUpdatedAt < b.lastUpdatedAt ? 1 : -1));
}
