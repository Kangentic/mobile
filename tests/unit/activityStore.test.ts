import { describe, expect, it } from 'vitest';
import { selectSessionsBySection, useActivityStore, type AgentSession } from '@/state/activityStore';

describe('selectSessionsBySection', () => {
  it('returns only needs-you sessions, newest first', () => {
    const rows = selectSessionsBySection('needs-you');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((session) => session.section === 'needs-you')).toBe(true);
    for (let index = 1; index < rows.length; index++) {
      expect(rows[index - 1].lastUpdatedAt >= rows[index].lastUpdatedAt).toBe(true);
    }
  });

  it('returns only working sessions for the working section', () => {
    const rows = selectSessionsBySection('working');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((session) => session.section === 'working')).toBe(true);
  });

  it('returns an empty list for a section with no sessions', () => {
    const originalSessions = useActivityStore.getState().sessions;
    // The default mock data has an idle session, so drive the genuinely-empty
    // branch by seeding a fixture with no idle sessions.
    const withoutIdle: AgentSession[] = originalSessions.filter((session) => session.section !== 'idle');
    useActivityStore.setState({ sessions: withoutIdle });
    try {
      expect(selectSessionsBySection('idle')).toEqual([]);
    } finally {
      useActivityStore.setState({ sessions: originalSessions });
    }
  });
});
