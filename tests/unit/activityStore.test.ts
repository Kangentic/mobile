/**
 * activityStore: snapshot application, each ActivityEvent payload type,
 * permission set/clear, and the triage section mapping/sort.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEvent, ActivityEventPayload } from '@kangentic/protocol';
import {
  sectionForEntry,
  selectSessionEnded,
  selectSessionSpawnProgressLabel,
  selectTriageRows,
  selectWaitingSince,
  useActivityStore,
} from '@/state/activityStore';
import { streamSnapshotFixture, usageFixture } from '@/devsupport/desktopFixtures';

function activityEvent(sessionId: string, payload: ActivityEventPayload): ActivityEvent {
  return { kind: 'activity', sessionId, taskId: 'task-1', payload };
}

/** A `session-ended` payload carrying the desktop's `spawnProgressLabel` (protocol 0.14.0+). */
function sessionEndedWithLabel(intentional: boolean, spawnProgressLabel: string): ActivityEventPayload {
  return { type: 'session-ended', intentional, spawnProgressLabel };
}

/**
 * A `session-ended` payload whose `spawnProgressLabel` is NOT a string. The
 * protocol declares it `string | undefined` and `parseActivityEventPayload`
 * rejects anything else, so this cannot arrive from a validated wire event; it
 * exists to prove the store does not hand a non-string on to
 * `SessionSwitchingState`'s `renderableLabel`, which would call `.trim()` on it
 * and throw at render.
 *
 * Built by INTERSECTION, not `as unknown as ActivityEventPayload`: a blanket
 * cast would accept any object shape at all, while this keeps the base payload
 * fully checked (a typo in `type`, a missing `intentional`) and widens only the
 * one field under test. That is the one local extension
 * protocol-types-from-package.md permits.
 *
 * The `Omit<Extract<...>>` is REQUIRED, not ceremony, and the flat
 * `ActivityEventPayload & { spawnProgressLabel?: number | ... }` this replaced
 * no longer compiles: 0.14.0 declares the field as `string`, so intersecting it
 * with `number` collapses the property to `string & number`. Omitting it from
 * the extracted member before re-adding it is what leaves a hole to widen.
 */
function sessionEndedWithNonStringLabel(spawnProgressLabel: number | Record<string, unknown>): ActivityEventPayload {
  const payload: Omit<Extract<ActivityEventPayload, { type: 'session-ended' }>, 'spawnProgressLabel'> & {
    spawnProgressLabel?: number | Record<string, unknown>;
  } = {
    type: 'session-ended',
    intentional: true,
    spawnProgressLabel,
  };
  return payload as ActivityEventPayload;
}

/**
 * A payload of a DIFFERENT type carrying a stray `spawnProgressLabel` field -
 * exercises `extractSpawnProgressLabel`'s `payload.type !== 'session-ended'`
 * early return, which a real desktop would never trigger (the field is
 * documented as riding only on `session-ended`) but the guard still has to
 * hold.
 */
function activityPayloadWithStraySpawnLabel(spawnProgressLabel: string): ActivityEventPayload {
  const payload: ActivityEventPayload & { spawnProgressLabel?: string } = {
    type: 'activity',
    state: 'thinking',
    reason: { kind: 'turn-active' },
    spawnProgressLabel,
  };
  return payload;
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

  /**
   * Caught by the session-ended-state E2E flow. A session that ends leaves the
   * board's `view: 'sessions'` projection in the very next snapshot (its task
   * no longer has a session_id, so the projection drops the task), and
   * reconcileSessionsFromBoards then prunes the activity entry for any session
   * no board claims - deleting `feedStatus: 'ended'` a few hundred
   * milliseconds after it was set. The session screen read only that field, so
   * its ended state appeared and vanished. Pruning the entry is right; the
   * fact that the session ended has to outlive it.
   */
  it('records an ended session id that survives the entry being pruned', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'session-ended', intentional: true }));
    expect(selectSessionEnded(useActivityStore.getState(), 'sess-1')).toBe(true);

    // What the board reconciler does once the task leaves the projection.
    useActivityStore.getState().removeSession('sess-1');

    expect(useActivityStore.getState().bySessionId['sess-1']).toBeUndefined();
    expect(selectSessionEnded(useActivityStore.getState(), 'sess-1')).toBe(true);
    expect(selectSessionEnded(useActivityStore.getState(), 'sess-other')).toBe(false);
    expect(selectSessionEnded(useActivityStore.getState(), null)).toBe(false);
  });

  /**
   * The other half of the terminal-'ended' invariant markRejected enforces.
   * The desktop pushes session-ended just BEFORE it tears the read-stream
   * registry entry down, so a subscribe already in flight can still succeed
   * inside that window and deliver a snapshot afterwards. Resurrecting the
   * session as 'live' would also disarm markRejected's guard, so the next
   * refusal would record 'rejected' - the consequence of the death - in place
   * of its actual cause.
   */
  it('a snapshot landing after session-ended cannot resurrect it as live', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'session-ended', intentional: false }));

    useActivityStore.getState().applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture());

    const entry = useActivityStore.getState().bySessionId['sess-1'];
    expect(entry.feedStatus).toBe('ended');
    expect(entry.endedIntentionally).toBe(false);

    // And the guard still holds for the refusal that follows.
    useActivityStore.getState().markRejected('sess-1');
    expect(useActivityStore.getState().bySessionId['sess-1'].feedStatus).toBe('ended');
  });

  /** A deep link or push tap can land on a session this phone never registered. */
  it('records an ended session id even with no entry to update', () => {
    useActivityStore.getState().applyActivityEvent(activityEvent('sess-ghost', { type: 'session-ended', intentional: false }));
    expect(useActivityStore.getState().bySessionId['sess-ghost']).toBeUndefined();
    expect(selectSessionEnded(useActivityStore.getState(), 'sess-ghost')).toBe(true);
  });

  /**
   * The mid-handoff respawn signal (kangentic board #639): a session-ended
   * push can carry the desktop's in-flight spawn-progress label, meaning a
   * successor is expected rather than this being a genuine park.
   */
  describe('spawnProgressLabel on session-ended', () => {
    it('is absent when the desktop sends no label (a genuine park, or a pre-field desktop)', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'session-ended', intentional: true }));
      expect(selectSessionSpawnProgressLabel(useActivityStore.getState(), 'sess-1')).toBeNull();
    });

    it('is recorded when the desktop sends one', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', sessionEndedWithLabel(true, 'Switching model...')));
      expect(selectSessionSpawnProgressLabel(useActivityStore.getState(), 'sess-1')).toBe('Switching model...');
    });

    /**
     * A deep link or push tap can land on a session this phone never
     * registered - the same case `endedSessionIds` covers for the ended fact
     * itself.
     */
    it('is recorded even with no entry to update', () => {
      useActivityStore.getState().applyActivityEvent(activityEvent('sess-ghost', sessionEndedWithLabel(true, 'Applying new settings...')));
      expect(useActivityStore.getState().bySessionId['sess-ghost']).toBeUndefined();
      expect(selectSessionSpawnProgressLabel(useActivityStore.getState(), 'sess-ghost')).toBe('Applying new settings...');
    });

    /**
     * The same pruning `endedSessionIds` survives (reconcileSessionsFromBoards
     * deletes the entry a few hundred ms after the session ends, once the
     * board drops the now-sessionless task). A label on SessionActivityEntry
     * itself would be pruned with it - this is why the label lives in its own
     * sibling map instead.
     */
    it('survives the entry being pruned', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', sessionEndedWithLabel(true, 'Switching agent...')));

      useActivityStore.getState().removeSession('sess-1');

      expect(useActivityStore.getState().bySessionId['sess-1']).toBeUndefined();
      expect(selectSessionSpawnProgressLabel(useActivityStore.getState(), 'sess-1')).toBe('Switching agent...');
    });

    it('clears on reset', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', sessionEndedWithLabel(true, 'Starting new session...')));
      expect(selectSessionSpawnProgressLabel(useActivityStore.getState(), 'sess-1')).toBe('Starting new session...');

      useActivityStore.getState().reset();

      expect(selectSessionSpawnProgressLabel(useActivityStore.getState(), 'sess-1')).toBeNull();
    });

    it('selectSessionSpawnProgressLabel returns null for a null sessionId', () => {
      expect(selectSessionSpawnProgressLabel(useActivityStore.getState(), null)).toBeNull();
    });

    /**
     * The runtime guard's `typeof` half. Without it a non-string label would
     * sail through to `SessionSwitchingState`'s `renderableLabel`, which
     * calls `.trim()` unconditionally and throws at render.
     */
    it('rejects a non-string spawnProgressLabel (a number), leaving the selector null', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', sessionEndedWithNonStringLabel(42)));
      expect(selectSessionSpawnProgressLabel(useActivityStore.getState(), 'sess-1')).toBeNull();
    });

    it('rejects a non-string spawnProgressLabel (an object), leaving the selector null', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore
        .getState()
        .applyActivityEvent(activityEvent('sess-1', sessionEndedWithNonStringLabel({ phase: 'switching' })));
      expect(selectSessionSpawnProgressLabel(useActivityStore.getState(), 'sess-1')).toBeNull();
    });

    /** The `payload.type !== 'session-ended'` early return's own coverage. */
    it('ignores a spawnProgressLabel riding a payload type other than session-ended', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore
        .getState()
        .applyActivityEvent(activityEvent('sess-1', activityPayloadWithStraySpawnLabel('Switching model...')));
      expect(selectSessionSpawnProgressLabel(useActivityStore.getState(), 'sess-1')).toBeNull();
    });

    /**
     * Identity matters here the same way it does elsewhere in this store: a
     * screen selecting `spawnProgressLabelBySessionId` re-renders on every
     * object identity change, so an event that carries no label must not
     * manufacture a new (value-equal) map on every activity tick.
     */
    it('leaves spawnProgressLabelBySessionId referentially unchanged when session-ended carries no label', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      const before = useActivityStore.getState().spawnProgressLabelBySessionId;

      useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'session-ended', intentional: true }));

      expect(useActivityStore.getState().spawnProgressLabelBySessionId).toBe(before);
    });
  });

  /**
   * `sessionStatus` crossed the wire from protocol 0.5.0 onward and was dropped
   * on the floor by applySnapshot, so a snapshot that said 'suspended' or
   * 'queued' was recorded as an ordinary live session.
   */
  describe('sessionStatus from the read-stream snapshot', () => {
    it('records the desktop-reported status', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');

      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'suspended' }));

      expect(useActivityStore.getState().bySessionId['sess-1'].sessionStatus).toBe('suspended');
    });

    /**
     * The protocol's own stated fallback for a pre-0.5.0 desktop, which omits
     * the field entirely - streamSnapshotFixture() omits it by default.
     */
    it('assumes running when the desktop omits the field', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');

      useActivityStore.getState().applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture());

      expect(useActivityStore.getState().bySessionId['sess-1'].sessionStatus).toBe('running');
    });

    /**
     * Null and 'running' are not synonyms: null is "no snapshot has landed",
     * 'running' is "one landed and said so (or omitted the field)". A registered
     * session that has never been snapshotted must stay distinguishable from a
     * running one, or a caller cannot tell "unknown" from "fine".
     */
    it('leaves a registered-but-unsnapshotted session null, not running', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');

      const entry = useActivityStore.getState().bySessionId['sess-1'];
      expect(entry.sessionStatus).toBeNull();
      expect(entry.feedStatus).toBe('pending');
    });

    /**
     * THE CONSTRAINT GUARD, and the assertion in this block worth the most.
     *
     * `sessionStatus` is a snapshot-time observation, never an endedness
     * signal. Routing 'suspended' (or 'exited', a snapshot racing teardown)
     * into `endedSessionIds` or into the triage sections would re-open the
     * mid-respawn "Session ended" flash that SessionScreen's spawn-label swap
     * latch exists to prevent, since `selectSessionEnded` is one of that
     * derivation's inputs. This fails loudly if anyone later wires it there.
     */
    it('never leaks a suspended or exited status into triage or endedness', () => {
      for (const status of ['suspended', 'exited'] as const) {
        useActivityStore.getState().reset();
        useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
        useActivityStore
          .getState()
          .applySnapshot(
            'sess-1',
            'task-1',
            'project-1',
            streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: status }),
          );

        const entry = useActivityStore.getState().bySessionId['sess-1'];
        expect(entry.sessionStatus).toBe(status);
        expect(sectionForEntry(entry)).toBe('idle');
        expect(entry.feedStatus).toBe('live');
        expect(selectSessionEnded(useActivityStore.getState(), 'sess-1')).toBe(false);
      }
    });

    /**
     * The field deliberately goes stale rather than being re-derived: the
     * `session-ended` PUSH is the sole authority on endedness (it carries
     * `intentional`, which a snapshot cannot), so applyActivityEvent must not
     * write 'exited' here and give two fields authority over one fact.
     */
    it('is left stale by session-ended rather than re-derived', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'suspended' }));

      useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'session-ended', intentional: true }));

      const entry = useActivityStore.getState().bySessionId['sess-1'];
      expect(entry.sessionStatus).toBe('suspended');
      expect(entry.feedStatus).toBe('ended');
    });

    /**
     * THE RESUME, and the one place staleness is NOT allowed to stand.
     *
     * The field is written only by applySnapshot, a snapshot lands only on a
     * fresh read-stream subscribe, and subscriptionManager's setDesiredStreams
     * skips a session that already has one. So on a live channel nothing ever
     * re-snapshots a resumed session, and without this a 'suspended' recorded
     * once would suppress localNotifier's "Agent went idle" for the rest of
     * the connection. A 'thinking' event is proof the session is not parked.
     */
    it('retires a stale suspended when an activity event reports thinking', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'suspended' }));

      useActivityStore
        .getState()
        .applyActivityEvent(activityEvent('sess-1', { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }));

      expect(useActivityStore.getState().bySessionId['sess-1'].sessionStatus).toBe('running');
    });

    /**
     * The narrowing guard for the retirement above: it is a LIVENESS
     * correction, so it may only ever overwrite 'suspended'. 'exited' must
     * survive (the `session-ended` push is the authority on endedness, and a
     * snapshot racing teardown is not a resume), and null must stay null
     * rather than becoming a snapshot-derived 'running' no snapshot reported.
     */
    it.each([
      { before: 'exited' as const, expected: 'exited' },
      { before: null, expected: null },
    ])('leaves $before alone when an activity event reports thinking', ({ before, expected }) => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      if (before !== null) {
        useActivityStore
          .getState()
          .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: before }));
      }

      useActivityStore
        .getState()
        .applyActivityEvent(activityEvent('sess-1', { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } }));

      expect(useActivityStore.getState().bySessionId['sess-1'].sessionStatus).toBe(expected);
    });

    /**
     * And the other half of the narrowing: only 'thinking' retires. An 'idle'
     * event carries no proof of a resume - the desktop can report idle for a
     * session it is about to park - so the park must survive one.
     */
    it('keeps a suspended status when an activity event reports idle', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'suspended' }));

      useActivityStore
        .getState()
        .applyActivityEvent(activityEvent('sess-1', { type: 'activity', state: 'idle', reason: { kind: 'idle' } }));

      expect(useActivityStore.getState().bySessionId['sess-1'].sessionStatus).toBe('suspended');
    });
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

  /**
   * Protocol 0.8.0+'s message-preview push replaces a per-session transcript
   * fetch that cost 2.3-34.6 KB and up to 3.8s to produce this same one line.
   * A desktop that predates it sends none, so the entry stays null and the
   * Home feed's own peek is the fallback - that null default is pinned in
   * emptyEntry, and this only exercises the event handler that populates it.
   */
  it('a message-preview event stores the desktop-pushed line', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    expect(useActivityStore.getState().bySessionId['sess-1'].messagePreview).toBeNull();

    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'message-preview', text: 'Fixed the redirect loop.' }));
    expect(useActivityStore.getState().bySessionId['sess-1'].messagePreview).toBe('Fixed the redirect loop.');

    // A later push REPLACES it, rather than merging or appending.
    useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'message-preview', text: 'Now running the test suite.' }));
    expect(useActivityStore.getState().bySessionId['sess-1'].messagePreview).toBe('Now running the test suite.');
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

  describe('selectWaitingSince', () => {
    function liveEntry(sessionId: string, snapshot: Parameters<typeof streamSnapshotFixture>[0]): void {
      useActivityStore.getState().registerSession(sessionId, 'task-1', 'project-1');
      useActivityStore.getState().applySnapshot(sessionId, 'task-1', 'project-1', streamSnapshotFixture(snapshot));
    }

    /**
     * THE test for this selector. `since` and `enteredSectionAt` normally agree
     * closely enough that a fallback-only implementation passes every other
     * assertion in this block, so they are forced far apart here: only a
     * selector that genuinely reads `reason.since` can return 111_000.
     */
    it('prefers reason.since over enteredSectionAt when the two disagree', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(999_000);
        liveEntry('sess-1', { activity: { state: 'idle', reason: { kind: 'idle', since: 111_000 } } });
        expect(useActivityStore.getState().bySessionId['sess-1'].enteredSectionAt).toBe(999_000);
        expect(selectWaitingSince(useActivityStore.getState().bySessionId['sess-1'])).toBe(111_000);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * The sibling of the 'idle' case above, for the OTHER reason kind the
     * selector's condition names. `applyActivityEvent`'s 'permission' branch
     * never writes `reason` (see this function's docstring point 1), so the
     * only way a live entry actually carries `reason.kind === 'permission'`
     * is a snapshot landing while a prompt is already outstanding - exactly
     * what a cold-launch subscribe into a pending prompt looks like, and what
     * both `mockDesktop.ts`'s `emitActivity('permission')` and
     * `stubDesktopPeer.mjs` actually send. Without this, deleting
     * `|| reason.kind === 'permission'` from the selector's condition leaves
     * every other test in this block green.
     */
    it('prefers reason.since over enteredSectionAt for a permission reason too', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(999_000);
        liveEntry('sess-1', { activity: { state: 'permission', reason: { kind: 'permission', since: 111_000 } } });
        const entry = useActivityStore.getState().bySessionId['sess-1'];
        expect(entry.feedStatus).toBe('live');
        expect(sectionForEntry(entry)).not.toBe('working');
        expect(entry.enteredSectionAt).toBe(999_000);
        expect(selectWaitingSince(entry)).toBe(111_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('falls back to enteredSectionAt when the desktop sends no since', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(4_000);
        liveEntry('sess-1', { activity: { state: 'idle', reason: { kind: 'idle' } } });
        expect(selectWaitingSince(useActivityStore.getState().bySessionId['sess-1'])).toBe(4_000);
      } finally {
        vi.useRealTimers();
      }
    });

    it('returns null while the agent is working', () => {
      liveEntry('sess-1', { activity: { state: 'thinking', reason: { kind: 'turn-active' } } });
      expect(selectWaitingSince(useActivityStore.getState().bySessionId['sess-1'])).toBeNull();
    });

    /**
     * applyActivityEvent's 'permission' branch sets `state` but never writes
     * `reason`, so a session that genuinely needs the user can still be
     * carrying the previous turn's `turn-active`. A selector gated on
     * `reason.kind` returns null here and the label silently never appears for
     * a pending prompt - the single most important row to show it on.
     */
    it('still reports a time when a pending prompt leaves a stale turn-active reason', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(2_000);
        liveEntry('sess-1', { activity: { state: 'thinking', reason: { kind: 'turn-active' } } });
        vi.setSystemTime(7_000);
        useActivityStore
          .getState()
          .applyActivityEvent(activityEvent('sess-1', { type: 'permission', promptId: 'sess-1:tool-1', pending: true }));

        const entry = useActivityStore.getState().bySessionId['sess-1'];
        expect(entry.state).toBe('permission');
        expect(entry.reason).toEqual({ kind: 'turn-active' });
        expect(selectWaitingSince(entry)).toBe(7_000);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * registerSession stamps enteredSectionAt before any snapshot lands, and an
     * un-snapshotted entry sits at state 'idle'. Without the feedStatus gate a
     * session this phone never actually subscribed to would claim "1m" a minute
     * into a cold start.
     */
    it('returns null for a pending or rejected feed, despite its idle state', () => {
      useActivityStore.getState().registerSession('sess-pending', 'task-1', 'project-1');
      const pending = useActivityStore.getState().bySessionId['sess-pending'];
      expect(pending.feedStatus).toBe('pending');
      expect(sectionForEntry(pending)).toBe('idle');
      expect(selectWaitingSince(pending)).toBeNull();

      useActivityStore.getState().markRejected('sess-pending');
      expect(selectWaitingSince(useActivityStore.getState().bySessionId['sess-pending'])).toBeNull();
    });

    it('returns null once the session has ended', () => {
      liveEntry('sess-1', { activity: { state: 'idle', reason: { kind: 'idle', since: 111_000 } } });
      useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'session-ended', intentional: true }));
      expect(selectWaitingSince(useActivityStore.getState().bySessionId['sess-1'])).toBeNull();
    });
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
