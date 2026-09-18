/**
 * activityStore: snapshot application, each ActivityEvent payload type,
 * permission set/clear, and the triage section mapping/sort.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityEvent, ActivityEventPayload } from '@kangentic/protocol';
import {
  ENDED_ROW_GRACE_MS,
  RESPAWN_ROW_GRACE_MS,
  isStartingSession,
  sectionForEntry,
  selectSessionEnded,
  selectSessionSpawnProgressLabel,
  selectTaskRespawn,
  selectTriageRows,
  selectWaitingSince,
  useActivityStore,
} from '@/state/activityStore';
import { streamSnapshotFixture, usageFixture } from '@/devsupport/desktopFixtures';

/**
 * `taskId` defaults to the 'task-1' every other test in this file registers
 * against, and is a parameter only for the respawn-map block below: that map is
 * keyed by TASK, so proving it is keyed correctly needs an event whose task and
 * session ids cannot be confused for one another.
 */
function activityEvent(sessionId: string, payload: ActivityEventPayload, taskId = 'task-1'): ActivityEvent {
  return { kind: 'activity', sessionId, taskId, payload };
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
 * `renderableSpawnLabel` (`src/lib/spawnLabel.ts`), which would call `.trim()`
 * on it and throw at render.
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
     * sail through to `renderableSpawnLabel` (`src/lib/spawnLabel.ts`), which
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

    /**
     * The QUEUED retirement, which is deliberately WIDER than the 'suspended'
     * one above and must stay that way.
     *
     * A queued placeholder has `pty: null` (the desktop's shouldQueue branch),
     * so it can emit nothing at all - which makes ANY payload but a
     * 'session-ended' proof the queue promoted it, whatever it says. The
     * narrower
     * 'thinking'-only rule would leave a promoted session that happens to
     * report idle first badged "Waiting for a free slot" forever, because the
     * promotion REUSES the same session id and setDesiredStreams never
     * re-subscribes a session that already has a stream, so no snapshot would
     * ever correct it.
     *
     * 'idle' is the case that matters here: it is the one the 'suspended'
     * clause explicitly refuses, so a test that only passed 'thinking' would
     * still pass with the two clauses merged into one.
     */
    it.each([
      { state: 'idle' as const, reason: { kind: 'idle' as const } },
      { state: 'thinking' as const, reason: { kind: 'turn-active' as const } },
    ])('retires a stale queued when an activity event reports $state', ({ state, reason }) => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'queued' }));
      expect(useActivityStore.getState().bySessionId['sess-1'].sessionStatus).toBe('queued');

      useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'activity', state, reason }));

      expect(useActivityStore.getState().bySessionId['sess-1'].sessionStatus).toBe('running');
    });

    /**
     * The NON-activity payloads, which is where scoping the retirement to
     * `case 'activity'` actually bit. A queued placeholder emits nothing at
     * all, so any of these arriving is equally proof of promotion - and
     * 'permission' is the one with teeth: `starting` outranks every other body
     * source on the feed row, so a promoted session whose first push was a
     * prompt would have rendered as a muted "Waiting for a free slot" with the
     * decision it wants from the user hidden behind that caption, and the row's
     * peek effect skipped so nothing would fetch it either.
     *
     * These fail against a retirement that lives inside the switch's
     * `case 'activity'`, which is the whole point of listing them separately
     * from the it.each above.
     */
    it.each([
      {
        label: 'a permission prompt',
        payload: { type: 'permission' as const, promptId: 'prompt-1', pending: true },
      },
      { label: 'a usage report', payload: { type: 'usage' as const, usage: usageFixture() } },
      { label: 'a message preview', payload: { type: 'message-preview' as const, text: 'Reading the warehouse feed.' } },
    ])('retires a stale queued when the first payload after promotion is $label', ({ payload }) => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'queued' }));
      expect(useActivityStore.getState().bySessionId['sess-1'].sessionStatus).toBe('queued');

      useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', payload));

      expect(useActivityStore.getState().bySessionId['sess-1'].sessionStatus).toBe('running');
    });

    /**
     * The exclusion, and the control that stops the widening above from being
     * "retire on literally everything". A session cancelled OUT of the queue
     * ends without ever running, so calling it 'running' would be a lie the
     * ended-state handling then has to work around.
     */
    it('leaves a queued status alone when the session ends without running', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore
        .getState()
        .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'queued' }));

      useActivityStore.getState().applyActivityEvent(activityEvent('sess-1', { type: 'session-ended', intentional: true }));

      expect(useActivityStore.getState().bySessionId['sess-1'].sessionStatus).toBe('queued');
      expect(useActivityStore.getState().bySessionId['sess-1'].feedStatus).toBe('ended');
    });

    /**
     * The queued sibling of the constraint guard above. 'queued' is now
     * RENDERED (the Home feed row and the board card badge it), which is
     * exactly the pressure that would tempt someone to route it somewhere
     * load-bearing. It must stay a display-only observation: a queued session
     * is idle in triage terms and is emphatically not ended - it has not even
     * started.
     */
    it('never leaks a queued status into triage or endedness', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      useActivityStore
        .getState()
        .applySnapshot(
          'sess-1',
          'task-1',
          'project-1',
          streamSnapshotFixture({ activity: { state: 'idle', reason: null }, sessionStatus: 'queued' }),
        );

      const entry = useActivityStore.getState().bySessionId['sess-1'];
      expect(entry.sessionStatus).toBe('queued');
      expect(sectionForEntry(entry)).toBe('idle');
      expect(entry.feedStatus).toBe('live');
      expect(selectSessionEnded(useActivityStore.getState(), 'sess-1')).toBe(false);
    });
  });

  /**
   * The TASK-keyed end map, which exists because the session-keyed one above
   * cannot serve the list surfaces. During a swap the task's session_id is
   * null, so the Home feed row and the board card have no session id to look
   * anything up with - and the feed's rows come only from `bySessionId`, which
   * the reconciler prunes, so without this the row vanishes for the whole gap
   * and then reappears.
   */
  describe('respawnByTaskId (the task-keyed end signal)', () => {
    /**
     * Keyed by the event's TASK, never its session. A session-keyed write
     * would pass any test that used the same string for both, which is why the
     * ids here are deliberately unalike: the assertion fails on a
     * `[event.sessionId]` mutation instead of silently agreeing with it.
     */
    it('records a respawn against the task, not the ended session', () => {
      useActivityStore.getState().registerSession('sess-old', 'task-7', 'project-1');

      useActivityStore
        .getState()
        .applyActivityEvent(activityEvent('sess-old', sessionEndedWithLabel(true, 'Switching model...'), 'task-7'));

      expect(selectTaskRespawn(useActivityStore.getState(), 'task-7')?.label).toBe('Switching model...');
      expect(selectTaskRespawn(useActivityStore.getState(), 'sess-old')).toBeNull();
    });

    /**
     * An UNLABELLED end is recorded too. The desktop's own column-move swap
     * arrives with no label, indistinguishable from a park when it lands, so
     * the list surfaces retain both and the window is what separates them.
     */
    it('records an unlabelled end against the task, with a null label', () => {
      useActivityStore.getState().registerSession('sess-old', 'task-7', 'project-1');

      useActivityStore.getState().applyActivityEvent(activityEvent('sess-old', { type: 'session-ended', intentional: true }, 'task-7'));

      const respawn = selectTaskRespawn(useActivityStore.getState(), 'task-7');
      expect(respawn).not.toBeNull();
      expect(respawn?.label).toBeNull();
    });

    it('is a starting session for an unlabelled end, exactly as for a labelled one', () => {
      useActivityStore.getState().applyActivityEvent(activityEvent('sess-old', { type: 'session-ended', intentional: true }, 'task-7'));

      expect(isStartingSession(selectTaskRespawn(useActivityStore.getState(), 'task-7'), 'running')).toBe(true);
      expect(isStartingSession(null, 'running')).toBe(false);
    });

    /**
     * The two windows. An unlabelled end is a bet (it might be a park), so it
     * expires on the short grace; a labelled one is explicit desktop intent
     * and keeps the full window. Each direction has its own mutation: a single
     * window in either direction fails exactly one of these.
     */
    it('stops reporting an unlabelled end at the short grace, before a labelled one would', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        useActivityStore.getState().applyActivityEvent(activityEvent('sess-old', { type: 'session-ended', intentional: true }, 'task-7'));

        vi.setSystemTime(1_000_000 + ENDED_ROW_GRACE_MS - 1);
        expect(selectTaskRespawn(useActivityStore.getState(), 'task-7')).not.toBeNull();

        vi.setSystemTime(1_000_000 + ENDED_ROW_GRACE_MS);
        expect(selectTaskRespawn(useActivityStore.getState(), 'task-7')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it('keeps reporting a labelled end past the short grace', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        useActivityStore
          .getState()
          .applyActivityEvent(activityEvent('sess-old', sessionEndedWithLabel(true, 'Switching model...'), 'task-7'));

        vi.setSystemTime(1_000_000 + ENDED_ROW_GRACE_MS);
        expect(selectTaskRespawn(useActivityStore.getState(), 'task-7')?.label).toBe('Switching model...');
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * The successor landing is what spends the fact, and `registerSession` is
     * where the reconciler announces it. The clear has to happen THERE rather
     * than on a later pass: the reconciler registers every live session before
     * it prunes, so this is what lets the single board snapshot that installs
     * the successor also release the retained ghost - one snapshot, never two
     * rows for one task.
     */
    it('clears the respawn when a successor session registers for the task', () => {
      useActivityStore.getState().registerSession('sess-old', 'task-7', 'project-1');
      useActivityStore
        .getState()
        .applyActivityEvent(activityEvent('sess-old', sessionEndedWithLabel(true, 'Switching model...'), 'task-7'));

      useActivityStore.getState().registerSession('sess-new', 'task-7', 'project-1');

      expect(selectTaskRespawn(useActivityStore.getState(), 'task-7')).toBeNull();
    });

    /** A different task's successor must not spend this task's respawn. */
    it('leaves the respawn alone when an unrelated task registers a session', () => {
      useActivityStore.getState().registerSession('sess-old', 'task-7', 'project-1');
      useActivityStore
        .getState()
        .applyActivityEvent(activityEvent('sess-old', sessionEndedWithLabel(true, 'Switching model...'), 'task-7'));

      useActivityStore.getState().registerSession('sess-other', 'task-9', 'project-1');

      expect(selectTaskRespawn(useActivityStore.getState(), 'task-7')?.label).toBe('Switching model...');
    });

    /**
     * The desktop's label is INTENT, not a guarantee that a successor is
     * coming, so an unbounded map would leave a row claiming "Switching
     * model..." forever when a respawn dies. The selector is where that bound
     * lives, so the two cards and the reconciler's retention rule cannot
     * disagree about whether a respawn is still in flight.
     */
    it('stops reporting a respawn once the grace window has passed', () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        useActivityStore.getState().registerSession('sess-old', 'task-7', 'project-1');
        useActivityStore
          .getState()
          .applyActivityEvent(activityEvent('sess-old', sessionEndedWithLabel(true, 'Switching model...'), 'task-7'));

        vi.setSystemTime(1_000_000 + RESPAWN_ROW_GRACE_MS - 1);
        expect(selectTaskRespawn(useActivityStore.getState(), 'task-7')?.label).toBe('Switching model...');

        vi.setSystemTime(1_000_000 + RESPAWN_ROW_GRACE_MS);
        expect(selectTaskRespawn(useActivityStore.getState(), 'task-7')).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * Same reasoning as `endedSessionIds` recording before the no-entry bail:
     * a phone that never registered the outgoing session (a deep link, a push
     * tap) still has to learn a respawn is in flight for the task.
     */
    it('records a respawn even with no entry to update', () => {
      useActivityStore
        .getState()
        .applyActivityEvent(activityEvent('sess-unknown', sessionEndedWithLabel(true, 'Switching agent...'), 'task-7'));

      expect(selectTaskRespawn(useActivityStore.getState(), 'task-7')?.label).toBe('Switching agent...');
    });

    it('clears on reset', () => {
      useActivityStore
        .getState()
        .applyActivityEvent(activityEvent('sess-old', sessionEndedWithLabel(true, 'Switching model...'), 'task-7'));

      useActivityStore.getState().reset();

      expect(selectTaskRespawn(useActivityStore.getState(), 'task-7')).toBeNull();
    });

    /**
     * `registerSession` runs once per live task on EVERY board snapshot, so a
     * clear that rebuilt the map unconditionally would hand every subscriber a
     * new object on every snapshot - re-rendering each board card and feed row
     * for a fact that did not change.
     */
    it('leaves the map referentially unchanged when a registering task has no respawn', () => {
      useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
      const before = useActivityStore.getState().respawnByTaskId;

      useActivityStore.getState().registerSession('sess-2', 'task-2', 'project-1');

      expect(useActivityStore.getState().respawnByTaskId).toBe(before);
    });

    /**
     * THE SUCCESSOR TAKES THE GHOST'S PLACE. The feed is keyed on the session
     * id and ordered by `enteredSectionAt`, so a successor built from scratch
     * is a new row at the top of Idle with a fresh body, then a second jump
     * to Working when its snapshot lands: two moves and a body change inside
     * the swap. Inheriting the ghost's section, ordering key, preview, usage
     * and unread badge makes the bind a same-slot remount with the same body.
     * A plain `emptyEntry` fails every inherited field here.
     */
    describe('the successor inherits the ghost row', () => {
      it("inherits the ghost's section, ordering key, preview, usage and unread count, with fresh liveness", () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(1_000);
          useActivityStore.getState().registerSession('sess-old', 'task-7', 'project-1');
          useActivityStore.getState().applySnapshot(
            'sess-old',
            'task-7',
            'project-1',
            streamSnapshotFixture({ activity: { state: 'thinking', reason: null } }),
          );
          useActivityStore
            .getState()
            .applyActivityEvent(activityEvent('sess-old', { type: 'message-preview', text: 'Halfway through the refactor.' }, 'task-7'));
          useActivityStore
            .getState()
            .applyActivityEvent(activityEvent('sess-old', { type: 'event', event: { ts: 1, type: 'tool_start' } }, 'task-7'));
          useActivityStore
            .getState()
            .applyActivityEvent(activityEvent('sess-old', { type: 'event', event: { ts: 2, type: 'tool_start' } }, 'task-7'));
          useActivityStore.getState().applyActivityEvent(activityEvent('sess-old', { type: 'session-ended', intentional: true }, 'task-7'));

          vi.setSystemTime(5_000);
          useActivityStore.getState().registerSession('sess-new', 'task-7', 'project-1');

          const successor = useActivityStore.getState().bySessionId['sess-new'];
          const ghost = useActivityStore.getState().bySessionId['sess-old'];
          expect(successor.state).toBe('thinking');
          expect(successor.enteredSectionAt).toBe(ghost.enteredSectionAt);
          expect(successor.enteredSectionAt).toBeLessThan(5_000);
          expect(successor.messagePreview).toBe('Halfway through the refactor.');
          expect(successor.usage).toEqual(ghost.usage);
          expect(successor.unreadCount).toBe(2);
          // Liveness is the successor's own.
          expect(successor.feedStatus).toBe('pending');
          expect(successor.sessionStatus).toBeNull();
          expect(successor.endedIntentionally).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });

      /**
       * A pending prompt belongs to the agent that died and can never be
       * answered; inherited verbatim it would also read to localNotifier as a
       * brand-new prompt on a brand-new entry, and push "Agent needs your
       * input" for a dead question. Copying `state` unchanged fails this.
       */
      /**
       * The borrowed line is only for the gap. The successor may be a different
       * conversation (an isolated column's session ending, the main one
       * resuming), so its first snapshot hands the preview back - null re-arms
       * the Home row's peek of the successor's OWN transcript - while a preview
       * the successor pushes itself is its own and survives the snapshot.
       * Seen live: a resumed session that stayed idle wore the dead review
       * agent's sentence for minutes.
       */
      it("hands a borrowed preview back on the successor's first snapshot", () => {
        useActivityStore.getState().registerSession('sess-old', 'task-7', 'project-1');
        useActivityStore
          .getState()
          .applyActivityEvent(activityEvent('sess-old', { type: 'message-preview', text: 'The review agent said this.' }, 'task-7'));
        useActivityStore.getState().applyActivityEvent(activityEvent('sess-old', { type: 'session-ended', intentional: true }, 'task-7'));
        useActivityStore.getState().registerSession('sess-new', 'task-7', 'project-1');
        expect(useActivityStore.getState().bySessionId['sess-new'].messagePreview).toBe('The review agent said this.');

        useActivityStore.getState().applySnapshot('sess-new', 'task-7', 'project-1', streamSnapshotFixture());

        expect(useActivityStore.getState().bySessionId['sess-new'].messagePreview).toBeNull();
      });

      it('keeps a preview the successor pushed itself through its snapshot', () => {
        useActivityStore.getState().registerSession('sess-old', 'task-7', 'project-1');
        useActivityStore
          .getState()
          .applyActivityEvent(activityEvent('sess-old', { type: 'message-preview', text: 'The review agent said this.' }, 'task-7'));
        useActivityStore.getState().applyActivityEvent(activityEvent('sess-old', { type: 'session-ended', intentional: true }, 'task-7'));
        useActivityStore.getState().registerSession('sess-new', 'task-7', 'project-1');
        useActivityStore
          .getState()
          .applyActivityEvent(activityEvent('sess-new', { type: 'message-preview', text: 'The successor said this.' }, 'task-7'));

        useActivityStore.getState().applySnapshot('sess-new', 'task-7', 'project-1', streamSnapshotFixture());

        expect(useActivityStore.getState().bySessionId['sess-new'].messagePreview).toBe('The successor said this.');
      });

      it('never inherits a dead prompt: permission becomes idle with no awaited prompt', () => {
        useActivityStore.getState().registerSession('sess-old', 'task-7', 'project-1');
        useActivityStore
          .getState()
          .applyActivityEvent(activityEvent('sess-old', { type: 'permission', promptId: 'sess-old:tool-1', pending: true }, 'task-7'));
        useActivityStore.getState().applyActivityEvent(activityEvent('sess-old', { type: 'session-ended', intentional: true }, 'task-7'));

        useActivityStore.getState().registerSession('sess-new', 'task-7', 'project-1');

        const successor = useActivityStore.getState().bySessionId['sess-new'];
        expect(successor.state).toBe('idle');
        expect(successor.awaitedPromptId).toBeNull();
        expect(successor.awaitedPromptOptions).toBeNull();
      });

      /**
       * The control: a session registering for a task with NO end in flight
       * is an ordinary fresh entry, even when another entry for that task
       * happens to exist. Seeding off "any same-task entry" would pass the
       * tests above and fail this one.
       */
      it('registers a fresh entry when no end is in flight for the task', () => {
        vi.useFakeTimers();
        try {
          vi.setSystemTime(1_000);
          useActivityStore.getState().registerSession('sess-old', 'task-7', 'project-1');
          useActivityStore.getState().applySnapshot(
            'sess-old',
            'task-7',
            'project-1',
            streamSnapshotFixture({ activity: { state: 'thinking', reason: null } }),
          );

          vi.setSystemTime(5_000);
          useActivityStore.getState().registerSession('sess-new', 'task-7', 'project-1');

          const successor = useActivityStore.getState().bySessionId['sess-new'];
          expect(successor.state).toBe('idle');
          expect(successor.enteredSectionAt).toBe(5_000);
          expect(successor.messagePreview).toBeNull();
        } finally {
          vi.useRealTimers();
        }
      });
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
