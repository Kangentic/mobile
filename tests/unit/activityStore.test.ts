/**
 * activityStore: snapshot application, each ActivityEvent payload type,
 * permission set/clear, and the triage section mapping/sort.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

  /**
   * The desktop pushes session-ended just before tearing the read-stream
   * subscription down. It had no case in the switch, so it fell through and
   * was discarded - taking the session-failed notification and the session
   * screen's ended state with it.
   */
  it('session-ended marks the feed ended and records whether it was deliberate', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture());

    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'session-ended', intentional: false }));

    const entry = useActivityStore.getState().bySessionId['sess-1'];
    expect(entry.feedStatus).toBe('ended');
    expect(entry.endedIntentionally).toBe(false);
  });

  /**
   * A dead session keeps being re-subscribed by the reconciler until a board
   * snapshot drops it, and the desktop refuses every attempt. Without this
   * guard the first refusal overwrites the real cause of death with a
   * consequence of it, and the screen shows the wrong terminal state.
   */
  it('a later refused subscribe cannot downgrade an ended session back to rejected', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'session-ended', intentional: true }));

    useActivityStore.getState().markRejected('sess-1');

    const entry = useActivityStore.getState().bySessionId['sess-1'];
    expect(entry.feedStatus).toBe('ended');
    expect(entry.endedIntentionally).toBe(true);
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

  it('marks sectionChangedAt only when an event actually changes the triage section', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    expect(useActivityStore.getState().bySessionId['sess-1'].sectionChangedAt).toBeNull();

    // idle -> working: a section change.
    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }));
    const changedAt = useActivityStore.getState().bySessionId['sess-1'].sectionChangedAt;
    expect(changedAt).not.toBeNull();

    // Still working: unread bumps and usage updates keep the section.
    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'event', event: { ts: 1, type: 'tool_start' } }));
    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'usage', usage: usageFixture() }));
    expect(useActivityStore.getState().bySessionId['sess-1'].sectionChangedAt).toBe(changedAt);
  });

  it('applySnapshot never marks a section change (mass refreshes stay silent)', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    // The fixture snapshot reports 'thinking': a section change relative to
    // the idle default, but snapshot-driven, so no pulse marker.
    useActivityStore.getState().applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture());
    const entry = useActivityStore.getState().bySessionId['sess-1'];
    expect(entry.state).toBe('thinking');
    expect(entry.sectionChangedAt).toBeNull();
  });

  /**
   * A re-delivered snapshot (reconnect, pull-to-refresh) fires for every live
   * session at once. If the section it reports is unchanged, the ordering key
   * must stay put - otherwise every reconnect reshuffles the whole feed into
   * snapshot-arrival order, exactly the churn enteredSectionAt exists to stop.
   */
  it('applySnapshot leaves enteredSectionAt untouched when the section is unchanged', () => {
    vi.useFakeTimers();
    try {
      // Fake time (rather than two real-clock reads) so a same-millisecond
      // coincidence can never make an always-bump implementation pass this
      // by accident: the clock genuinely moves between the two calls.
      vi.setSystemTime(1_000);
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      const enteredSectionAtOnRegister = useActivityStore.getState().bySessionId['sess-1'].enteredSectionAt;
      expect(sectionForEntry(useActivityStore.getState().bySessionId['sess-1'])).toBe('idle');
      expect(enteredSectionAtOnRegister).toBe(1_000);

      vi.setSystemTime(5_000);
      // Idle -> idle: the re-delivered snapshot reports the same section.
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ activity: { state: 'idle', reason: null } }));

      const entry = useActivityStore.getState().bySessionId['sess-1'];
      expect(sectionForEntry(entry)).toBe('idle');
      expect(entry.enteredSectionAt).toBe(enteredSectionAtOnRegister);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The companion case: a snapshot that genuinely moves a session to a new
   * section must still advance enteredSectionAt, or newly-arrived agents
   * would never rank above sessions that have been sitting in a section for
   * a while (and the unchanged-section test above would pass vacuously for
   * an implementation that stopped updating enteredSectionAt altogether).
   */
  it('applySnapshot bumps enteredSectionAt when the section genuinely changed', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      const enteredSectionAtOnRegister = useActivityStore.getState().bySessionId['sess-1'].enteredSectionAt;
      expect(sectionForEntry(useActivityStore.getState().bySessionId['sess-1'])).toBe('idle');

      vi.setSystemTime(5_000);
      // The default fixture reports 'thinking': idle -> working IS a section change.
      useActivityStore.getState().applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture());

      const entry = useActivityStore.getState().bySessionId['sess-1'];
      expect(sectionForEntry(entry)).toBe('working');
      expect(entry.enteredSectionAt).toBe(5_000);
      expect(entry.enteredSectionAt).not.toBe(enteredSectionAtOnRegister);
    } finally {
      vi.useRealTimers();
    }
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

    // Force distinct arrival ordering (newest into the section on top).
    useActivityStore.setState((state) => ({
      bySessionId: {
        ...state.bySessionId,
        'sess-working-old': { ...state.bySessionId['sess-working-old'], enteredSectionAt: 1000 },
        'sess-working-new': { ...state.bySessionId['sess-working-new'], enteredSectionAt: 2000 },
      },
    }));

    const sections = selectTriageRows(useActivityStore.getState());
    expect(sections.map((section) => section.section)).toEqual(['needs-you', 'working', 'idle']);
    expect(sections[0].entries.map((entry) => entry.sessionId)).toEqual(['sess-permission']);
    expect(sections[1].entries.map((entry) => entry.sessionId)).toEqual(['sess-working-new', 'sess-working-old']);
    expect(sections[2].entries.map((entry) => entry.sessionId)).toEqual(['sess-idle']);
  });

  /**
   * Reported live: two agents working at once traded places in the feed
   * continuously, because every streamed engine event bumped lastEventAt and
   * the section re-sorted on it. A row's position must only move when the
   * row moves sections.
   */
  it('keeps concurrently working sessions in a stable order as events stream (no ping-pong)', () => {
    const { registerSession, applyActivityEvent } = useActivityStore.getState();
    registerSession('sess-a', 'task-a', 'project-1');
    registerSession('sess-b', 'task-b', 'project-1');
    applyActivityEvent(activityEvent('sess-a', { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }));
    applyActivityEvent(activityEvent('sess-b', { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }));
    useActivityStore.setState((state) => ({
      bySessionId: {
        ...state.bySessionId,
        'sess-a': { ...state.bySessionId['sess-a'], enteredSectionAt: 1000 },
        'sess-b': { ...state.bySessionId['sess-b'], enteredSectionAt: 2000 },
      },
    }));
    const initialOrder = selectTriageRows(useActivityStore.getState())[1].entries.map((entry) => entry.sessionId);
    expect(initialOrder).toEqual(['sess-b', 'sess-a']);

    // The OLDER session now emits a flurry of events (tokens, usage ticks).
    // Pre-fix this jumped it to the top on the first one.
    for (let index = 0; index < 5; index += 1) {
      applyActivityEvent(activityEvent('sess-a', { type: 'usage', usage: usageFixture() }));
      applyActivityEvent(activityEvent('sess-a', { type: 'event', event: { ts: index, type: 'tool_start', tool: 'Bash' } }));
    }

    const afterOrder = selectTriageRows(useActivityStore.getState())[1].entries.map((entry) => entry.sessionId);
    expect(afterOrder).toEqual(initialOrder);
  });

  it('re-ranks a session only when it changes section', () => {
    const { registerSession, applyActivityEvent } = useActivityStore.getState();
    registerSession('sess-a', 'task-a', 'project-1');
    applyActivityEvent(activityEvent('sess-a', { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }));
    const whileWorking = useActivityStore.getState().bySessionId['sess-a'].enteredSectionAt;

    // Same section: the ordering key must hold.
    applyActivityEvent(activityEvent('sess-a', { type: 'event', event: { ts: 1, type: 'tool_start', tool: 'Bash' } }));
    expect(useActivityStore.getState().bySessionId['sess-a'].enteredSectionAt).toBe(whileWorking);

    // Moving to needs-you IS a re-rank.
    applyActivityEvent(activityEvent('sess-a', { type: 'permission', promptId: 'sess-a:tool-1', pending: true }));
    expect(useActivityStore.getState().bySessionId['sess-a'].enteredSectionAt).toBeGreaterThanOrEqual(whileWorking);
    expect(sectionForEntry(useActivityStore.getState().bySessionId['sess-a'])).toBe('needs-you');
  });
});
