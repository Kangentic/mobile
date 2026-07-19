/**
 * activityStore: snapshot application, each ActivityEvent payload type,
 * permission set/clear, and the triage section mapping/sort.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ActivityEvent, ActivityEventPayload } from '@kangentic/protocol';
import { sectionForEntry, selectTriageRows, useActivityStore } from '@/state/activityStore';
import { streamSnapshotFixture, usageFixture } from '@/devsupport/desktopFixtures';

function activityEvent(sessionId: string, payload: ActivityEventPayload): ActivityEvent {
  return { kind: 'activity', sessionId, taskId: 'task-1', payload };
}

describe('activityStore', () => {
  beforeEach(() => {
    useActivityStore.getState().reset();
  });

  it('registerSession creates a pending entry; applySnapshot makes it live', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    expect(useActivityStore.getState().bySessionId['sess-1'].feedStatus).toBe('pending');

    useActivityStore.getState().applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture());
    const entry = useActivityStore.getState().bySessionId['sess-1'];
    expect(entry.feedStatus).toBe('live');
    expect(entry.state).toBe('thinking');
    expect(entry.usage).not.toBeNull();
  });

  it('applyActivityEvent dispatches on payload type', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');

    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }));
    expect(useActivityStore.getState().bySessionId['sess-1'].state).toBe('thinking');

    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'usage', usage: usageFixture() }));
    expect(useActivityStore.getState().bySessionId['sess-1'].usage?.model.id).toBe('claude-opus-4-8');

    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'event', event: { ts: 1, type: 'tool_start', tool: 'Bash' } }));
    expect(useActivityStore.getState().bySessionId['sess-1'].unreadCount).toBe(1);
  });

  it('permission events set and clear the awaited prompt (and force the permission state)', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');

    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'permission', promptId: 'sess-1:tool-9', pending: true }));
    let entry = useActivityStore.getState().bySessionId['sess-1'];
    expect(entry.awaitedPromptId).toBe('sess-1:tool-9');
    expect(entry.state).toBe('permission');
    expect(sectionForEntry(entry)).toBe('needs-you');

    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'permission', promptId: 'sess-1:tool-9', pending: false }));
    entry = useActivityStore.getState().bySessionId['sess-1'];
    expect(entry.awaitedPromptId).toBeNull();
  });

  it('permission events carry, replace, and clear the probed option labels', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');

    const optionLabels = ['Yes', "Yes, and don't ask again for this command", 'No, and tell Claude what to do differently'];
    useActivityStore
      .getState()
      .applyActivityEvent(activityEvent('sess-1', { type: 'permission', promptId: 'sess-1:tool-9', pending: true, options: optionLabels }));
    expect(useActivityStore.getState().bySessionId['sess-1'].awaitedPromptOptions).toEqual(optionLabels);

    // A new prompt WITHOUT probed options must not inherit the old labels.
    useActivityStore
      .getState()
      .applyActivityEvent(activityEvent('sess-1', { type: 'permission', promptId: 'sess-1:tool-10', pending: true }));
    expect(useActivityStore.getState().bySessionId['sess-1'].awaitedPromptOptions).toBeNull();

    useActivityStore
      .getState()
      .applyActivityEvent(activityEvent('sess-1', { type: 'permission', promptId: 'sess-1:tool-10', pending: false }));
    expect(useActivityStore.getState().bySessionId['sess-1'].awaitedPromptOptions).toBeNull();
  });

  it('an activity state leaving permission clears a stale awaited prompt', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'permission', promptId: 'sess-1:tool-9', pending: true }));

    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }));
    expect(useActivityStore.getState().bySessionId['sess-1'].awaitedPromptId).toBeNull();
  });

  it('events for unknown sessions are dropped', () => {
    useActivityStore.getState().applyActivityEvent(activityEvent('sess-ghost', { type: 'usage', usage: usageFixture() }));
    expect(useActivityStore.getState().bySessionId['sess-ghost']).toBeUndefined();
  });

  it('markRead zeroes the unread counter', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'event', event: { ts: 1, type: 'tool_start' } }));
    useActivityStore.getState().markRead('sess-1');
    expect(useActivityStore.getState().bySessionId['sess-1'].unreadCount).toBe(0);
  });

  it('selectTriageRows buckets by state and sorts each section by recency', () => {
    const { registerSession, applyActivityEvent } = useActivityStore.getState();
    registerSession('sess-idle', 'task-a', 'project-1');
    registerSession('sess-working-old', 'task-b', 'project-1');
    registerSession('sess-working-new', 'task-c', 'project-1');
    registerSession('sess-permission', 'task-d', 'project-1');

    applyActivityEvent(activityEvent('sess-working-old', { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }));
    applyActivityEvent(activityEvent('sess-working-new', { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }));
    applyActivityEvent(activityEvent('sess-permission', { type: 'permission', promptId: 'sess-permission:tool-1', pending: true }));

    // Force distinct recency ordering.
    useActivityStore.setState((state) => ({
      bySessionId: {
        ...state.bySessionId,
        'sess-working-old': { ...state.bySessionId['sess-working-old'], lastEventAt: 1000 },
        'sess-working-new': { ...state.bySessionId['sess-working-new'], lastEventAt: 2000 },
      },
    }));

    const sections = selectTriageRows(useActivityStore.getState());
    expect(sections.map((section) => section.section)).toEqual(['needs-you', 'working', 'idle']);
    expect(sections[0].entries.map((entry) => entry.sessionId)).toEqual(['sess-permission']);
    expect(sections[1].entries.map((entry) => entry.sessionId)).toEqual(['sess-working-new', 'sess-working-old']);
    expect(sections[2].entries.map((entry) => entry.sessionId)).toEqual(['sess-idle']);
  });
});
