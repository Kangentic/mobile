import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TransportState } from '@kangentic/protocol';
import { boardSnapshotFixture } from '@/devsupport/desktopFixtures';
import { CONNECTION_BREADCRUMB_STATE_LIST, type ConnectionBreadcrumbState } from '@/observability/reportVocabulary';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import {
  advanceConnectionTrail,
  awaitsBoardSnapshot,
  initialConnectionTrailState,
  registerConnectionBreadcrumbs,
  type ConnectionTrailEvent,
  type ConnectionTrailState,
} from '@/state/connectionBreadcrumbs';

/**
 * The connection's life on the crash-report trail (task #152, from Sentry
 * MOBILE-H, whose event could not say whether the app was reconnecting or a
 * board had just landed when it hung).
 *
 * Two things are pinned. The mapping, because the trail is only worth reading
 * if `closed` means the connection closed. And the budget rule, because the
 * failure this module can cause is invisible in any single event: a retry loop
 * or a busy board quietly spending the whole trail, and pushing the screen
 * crumbs that say where the user was out of the report.
 */

/**
 * The observability door reaches Sentry, which does not load under vitest, so
 * it is mocked by specifier and what it was asked to record is read back.
 */
const doorState = vi.hoisted(() => ({ recorded: [] as string[] }));
vi.mock('@/observability/reportContext', () => ({
  recordConnectionState: (state: string) => {
    doorState.recorded.push(state);
  },
}));

function channelEvent(transportState: TransportState, established = false): ConnectionTrailEvent {
  return { kind: 'channel', transportState, established };
}

/** Runs events through the pure rule from a fresh idle start and returns everything it recorded, in order. */
function recordedFor(events: ConnectionTrailEvent[]): ConnectionBreadcrumbState[] {
  let state: ConnectionTrailState = initialConnectionTrailState({ transportState: 'idle', established: false });
  const recorded: ConnectionBreadcrumbState[] = [];
  for (const event of events) {
    const step = advanceConnectionTrail(state, event);
    state = step.state;
    recorded.push(...step.record);
  }
  return recorded;
}

const SNAPSHOT: ConnectionTrailEvent = { kind: 'board-snapshot' };

describe('advanceConnectionTrail', () => {
  it('records a first connection in order: connecting, connected, established, then the first board snapshot', () => {
    expect(
      recordedFor([channelEvent('connecting'), channelEvent('connected'), channelEvent('connected', true), SNAPSHOT]),
    ).toEqual(['connecting', 'connected', 'established', 'board-snapshot']);
  });

  it('records nothing for the state the app launches in', () => {
    expect(recordedFor([channelEvent('idle')])).toEqual([]);
  });

  it('records the app closing the connection, which reaches the store only as a reset to idle', () => {
    // The mutation this guards: treating `idle` as "nothing happened". The
    // connection manager drops its transport listener before disposing, so a
    // background or an unpair never writes `closed`. Without this mapping the
    // trail goes on saying `established` through all of it.
    expect(
      recordedFor([channelEvent('connecting'), channelEvent('connected'), channelEvent('connected', true), channelEvent('idle')]),
    ).toEqual(['connecting', 'connected', 'established', 'closed']);
  });

  it("records one close when the transport's own closed is followed by the store's reset", () => {
    expect(
      recordedFor([channelEvent('connecting'), channelEvent('connected'), channelEvent('closed'), channelEvent('idle')]),
    ).toEqual(['connecting', 'connected', 'closed']);
  });

  it('spends three slots on a retry loop against an absent desktop, however long it runs', () => {
    // The relay accepts the socket, nothing answers, it drops, and the
    // transport retries on a five-second floor: `connected` then
    // `reconnecting`, for as long as the laptop stays shut. The mutation this
    // guards is recording every transition, which here would be 200 crumbs
    // into a trail that keeps 100.
    const retryLoop: ConnectionTrailEvent[] = [channelEvent('connecting')];
    for (let attempt = 0; attempt < 100; attempt += 1) {
      retryLoop.push(channelEvent('connected'), channelEvent('reconnecting'));
    }

    expect(recordedFor(retryLoop)).toEqual(['connecting', 'connected', 'reconnecting']);
  });

  it('records the recovery after a retry loop, and starts a new cycle there', () => {
    expect(
      recordedFor([
        channelEvent('connecting'),
        channelEvent('connected'),
        channelEvent('reconnecting'),
        channelEvent('connected'),
        channelEvent('connected', true),
        // The link drops again: a new cycle, so its states are recorded afresh.
        channelEvent('reconnecting'),
        channelEvent('connected'),
        channelEvent('connected', true),
      ]),
    ).toEqual(['connecting', 'connected', 'reconnecting', 'established', 'reconnecting', 'connected', 'established']);
  });

  it('records one board snapshot per secure session, however many land', () => {
    // A busy board is re-read on a 300 ms debounce. The mutation this guards
    // is recording each one.
    const events: ConnectionTrailEvent[] = [channelEvent('connecting'), channelEvent('connected'), channelEvent('connected', true)];
    for (let snapshot = 0; snapshot < 500; snapshot += 1) events.push(SNAPSHOT);

    expect(recordedFor(events).filter((state) => state === 'board-snapshot')).toHaveLength(1);
  });

  it('records the first board snapshot again after a re-establish, which is the bootstrap landing', () => {
    expect(
      recordedFor([
        channelEvent('connecting'),
        channelEvent('connected'),
        channelEvent('connected', true),
        SNAPSHOT,
        SNAPSHOT,
        channelEvent('reconnecting'),
        channelEvent('connected'),
        channelEvent('connected', true),
        SNAPSHOT,
      ]),
    ).toEqual([
      'connecting',
      'connected',
      'established',
      'board-snapshot',
      'reconnecting',
      'connected',
      'established',
      'board-snapshot',
    ]);
  });

  it('records no board snapshot while there is no secure session to have carried one', () => {
    expect(recordedFor([SNAPSHOT, channelEvent('connecting'), SNAPSHOT, channelEvent('connected'), SNAPSHOT])).toEqual([
      'connecting',
      'connected',
    ]);
  });

  it('records a second close when a reconnect attempt came between the two', () => {
    // Foreground, the desktop never answers, background again. The second
    // close is real and must not be swallowed as a repeat of the first.
    expect(
      recordedFor([
        channelEvent('connecting'),
        channelEvent('connected'),
        channelEvent('connected', true),
        channelEvent('idle'),
        channelEvent('connecting'),
        channelEvent('connected'),
        channelEvent('reconnecting'),
        channelEvent('idle'),
      ]),
    ).toEqual(['connecting', 'connected', 'established', 'closed', 'connecting', 'connected', 'reconnecting', 'closed']);
  });

  it('only ever records a member of the closed union, across every transport state in every order', () => {
    const transportStates: TransportState[] = ['idle', 'connecting', 'connected', 'reconnecting', 'closed'];
    const events: ConnectionTrailEvent[] = [];
    for (const from of transportStates) {
      for (const to of transportStates) {
        events.push(channelEvent(from), channelEvent(to, to === 'connected'), SNAPSHOT);
      }
    }

    const recorded = recordedFor(events);
    expect(recorded.length).toBeGreaterThan(0);
    for (const state of recorded) expect(CONNECTION_BREADCRUMB_STATE_LIST).toContain(state);
  });

  it('says a snapshot is awaited only between an establish and the first one', () => {
    let state = initialConnectionTrailState({ transportState: 'idle', established: false });
    expect(awaitsBoardSnapshot(state)).toBe(false);

    for (const event of [channelEvent('connecting'), channelEvent('connected'), channelEvent('connected', true)]) {
      state = advanceConnectionTrail(state, event).state;
    }
    expect(awaitsBoardSnapshot(state)).toBe(true);

    state = advanceConnectionTrail(state, SNAPSHOT).state;
    expect(awaitsBoardSnapshot(state)).toBe(false);
  });
});

describe('registerConnectionBreadcrumbs', () => {
  let unregister: () => void = () => undefined;

  beforeEach(() => {
    // `snapshotAt` is `Date.now()`, and the detector compares it per project,
    // so two snapshots in one test need the clock to move between them.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-18T19:38:50.000Z'));
    useChannelStore.setState({ transportState: 'idle', established: false, establishedAt: null, everEstablished: false });
    useBoardStore.getState().reset();
    doorState.recorded.length = 0;
    unregister = registerConnectionBreadcrumbs();
  });

  afterEach(() => {
    unregister();
    vi.useRealTimers();
  });

  /** A connection opening the way the connection manager drives the store. */
  function openAndEstablish(): void {
    useChannelStore.getState().setTransportState('connecting');
    useChannelStore.getState().setTransportState('connected');
    useChannelStore.getState().markEstablished();
  }

  it('records the store transitions of a connection opening, through the door', () => {
    openAndEstablish();

    expect(doorState.recorded).toEqual(['connecting', 'connected', 'established']);
  });

  it('records the first board snapshot applied on the session, and not the ones after it', () => {
    openAndEstablish();
    useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture());
    vi.advanceTimersByTime(400);
    useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture());
    vi.advanceTimersByTime(400);
    useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ projectId: 'project-2' }));

    expect(doorState.recorded).toEqual(['connecting', 'connected', 'established', 'board-snapshot']);
  });

  it('does not mistake an optimistic move for a snapshot', () => {
    // An optimistic move rewrites the project's board object and carries its
    // `snapshotAt` forward. Detecting "the board object changed" instead of
    // "a snapshot was applied" would record a crumb for a drag.
    useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture());
    openAndEstablish();
    doorState.recorded.length = 0;
    vi.advanceTimersByTime(400);

    const moveId = useBoardStore
      .getState()
      .applyOptimisticMove({ projectId: 'project-1', taskId: 'task-1', toSwimlaneId: 'lane-doing', toPosition: 0 });

    expect(moveId).not.toBeNull();
    expect(doorState.recorded).toEqual([]);
  });

  it('records closed when the connection manager resets the store, as it does on a background', () => {
    openAndEstablish();
    doorState.recorded.length = 0;

    useChannelStore.getState().reset();

    expect(doorState.recorded).toEqual(['closed']);
  });

  it('records nothing for a rekey, a relay address or a paired-state change', () => {
    openAndEstablish();
    doorState.recorded.length = 0;

    useChannelStore.getState().noteRekey();
    useChannelStore.getState().setRelayUrl('wss://relay.example');
    useChannelStore.getState().setPairedState('paired');

    expect(doorState.recorded).toEqual([]);
  });

  it('stops recording board snapshots once unregistered after the connection is up', () => {
    // The mutation this guards: dropping the board unsubscribe from the
    // returned function. Unregistering before the connection opens (below)
    // cannot see it, because the board listener could never record anyway.
    openAndEstablish();
    doorState.recorded.length = 0;

    unregister();
    useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture());

    expect(doorState.recorded).toEqual([]);
  });

  it('stops recording once unregistered', () => {
    unregister();
    openAndEstablish();

    expect(doorState.recorded).toEqual([]);
  });
});
