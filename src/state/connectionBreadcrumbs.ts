import type { TransportState } from '@kangentic/protocol';
import { recordConnectionState } from '@/observability/reportContext';
import type { ConnectionBreadcrumbState } from '@/observability/reportVocabulary';
import { useBoardStore, type ProjectBoard } from './boardStore';
import { useChannelStore } from './channelStore';

/**
 * Puts the connection's life on the crash-report trail: connecting, connected,
 * established, reconnecting, closed, and the first board snapshot of a session.
 *
 * WHY THIS EXISTS. Sentry MOBILE-H was an iOS app hang two seconds after the
 * app came back from two and a half days in the background, and its event
 * could not say whether the app was reconnecting at the time or whether a
 * board had just landed and every row was laying out again. This trail is the
 * answer to "doing what". See src/observability/reportContext.ts.
 *
 * WHY IT LIVES HERE AND WATCHES THE STORES. The transitions happen in
 * `src/connection/` and `src/channel/`, and recording them at the call sites
 * would be the obvious design. It is the wrong one twice over: `src/channel/`
 * may not import the observability door at all
 * (.claude/rules/crash-reporting-scope.md), and a door import in the
 * connection manager or the store feed would pull the Sentry SDK's module
 * graph into every vitest file that loads them. Watching the same two stores
 * the UI reads needs no change to either directory and no new store field,
 * and it records what the app believed, which is what a screen was drawing.
 *
 * THE ONE RULE: each state is recorded once per connection cycle, and a cycle
 * starts at `established` or `closed`.
 *
 * It is a rule about the trail's budget rather than about tidiness. A crash
 * report keeps the last `maxBreadcrumbs` entries, and two ordinary conditions
 * would otherwise spend all of them:
 *
 * - With the desktop away (a closed laptop) the socket to the relay still
 *   opens, waits, drops and retries on a five-second floor, so the transport
 *   reads `connected` then `reconnecting` for as long as that lasts.
 * - A busy board is re-read on a 300 ms debounce, so snapshots can land
 *   several times a second.
 *
 * Either one would push the screen trail, the very thing that says where the
 * user was, out of the report. Under the rule a retry loop costs three slots
 * however long it runs and a session's snapshots cost one, so nothing this
 * module records can evict anything.
 *
 * What the rule gives up is the steady state: after the first snapshot of a
 * session, later ones are not recorded, so the trail cannot say that a
 * snapshot landed in the second before a failure deep into a session. The
 * first one is the case that needed answering (a bootstrap landing on a
 * re-establish), and it is always recorded.
 */

/**
 * What each transport state reads as on the trail. A record over the
 * protocol's own union, so a state the package adds is a type error here until
 * someone decides what it should record.
 *
 * `idle` reads as `closed` because that is how a deliberate close arrives: the
 * connection manager drops its transport listener BEFORE disposing the
 * transport, so the transport's own `closed` never reaches the store, and then
 * resets the store to `idle` (`closeConnection` in connectionManager.ts).
 * Leaving a live state for `idle` is therefore the only signal there is that
 * the app closed the connection on a background or an unpair. Without this the
 * trail would go on saying `established` through all of it.
 */
const TRANSPORT_TRAIL_STATE: Record<TransportState, ConnectionBreadcrumbState> = {
  idle: 'closed',
  connecting: 'connecting',
  connected: 'connected',
  reconnecting: 'reconnecting',
  closed: 'closed',
};

/** The two states a cycle starts at. */
function startsCycle(state: ConnectionBreadcrumbState): boolean {
  return state === 'established' || state === 'closed';
}

export interface ConnectionTrailState {
  transportState: TransportState;
  established: boolean;
  /** What has been recorded since the cycle began, the state that began it included. */
  recordedThisCycle: ReadonlySet<ConnectionBreadcrumbState>;
  /** The last state recorded, so a cycle is not restarted by its own start arriving twice. */
  lastRecorded: ConnectionBreadcrumbState | null;
}

export type ConnectionTrailEvent =
  | { kind: 'channel'; transportState: TransportState; established: boolean }
  | { kind: 'board-snapshot' };

export interface ConnectionTrailStep {
  state: ConnectionTrailState;
  /** The states to record, in order. Usually none. */
  record: ConnectionBreadcrumbState[];
}

/**
 * The trail's starting point. Nothing is recorded for the state the app
 * launches in: a trail records changes, and at launch there has been none.
 */
export function initialConnectionTrailState(channel: { transportState: TransportState; established: boolean }): ConnectionTrailState {
  return {
    transportState: channel.transportState,
    established: channel.established,
    recordedThisCycle: new Set(),
    lastRecorded: null,
  };
}

/**
 * Whether a board snapshot would be recorded right now. Exported so the board
 * subscription can skip comparing boards on every store write once a session
 * has had its one snapshot, which is nearly always.
 */
export function awaitsBoardSnapshot(state: ConnectionTrailState): boolean {
  return state.established && !state.recordedThisCycle.has('board-snapshot');
}

/**
 * The whole decision, as a pure function of the previous state and one event,
 * so the rule is tested without a store, a timer or the SDK.
 */
export function advanceConnectionTrail(previous: ConnectionTrailState, event: ConnectionTrailEvent): ConnectionTrailStep {
  const candidates: ConnectionBreadcrumbState[] = [];
  let transportState = previous.transportState;
  let established = previous.established;

  if (event.kind === 'channel') {
    if (event.transportState !== previous.transportState) {
      candidates.push(TRANSPORT_TRAIL_STATE[event.transportState]);
    }
    if (event.established && !previous.established) candidates.push('established');
    transportState = event.transportState;
    established = event.established;
  } else if (awaitsBoardSnapshot(previous)) {
    candidates.push('board-snapshot');
  }

  let recordedThisCycle = previous.recordedThisCycle;
  let lastRecorded = previous.lastRecorded;
  const record: ConnectionBreadcrumbState[] = [];
  for (const candidate of candidates) {
    if (startsCycle(candidate)) {
      // A cycle's start arriving twice in a row is one start: the transport's
      // own `closed` followed by the store's reset to `idle` is the case.
      // Compared against the LAST state recorded rather than the cycle's set,
      // so a second close after a failed reconnect attempt is still recorded.
      if (lastRecorded === candidate) continue;
      recordedThisCycle = new Set([candidate]);
    } else {
      if (recordedThisCycle.has(candidate)) continue;
      recordedThisCycle = new Set([...recordedThisCycle, candidate]);
    }
    lastRecorded = candidate;
    record.push(candidate);
  }

  return { state: { transportState, established, recordedThisCycle, lastRecorded }, record };
}

/**
 * Whether any project's board came from a snapshot the previous state did not
 * hold. `snapshotAt` is written only by `applyBoardSnapshot`; an optimistic
 * move, an edit and a shed all carry the existing value forward, so comparing
 * it per project tells a real snapshot from every other write to this store.
 * Inequality rather than "later than", so a clock stepping backwards cannot
 * hide one.
 */
function hasNewBoardSnapshot(
  nextBoards: Record<string, ProjectBoard>,
  previousBoards: Record<string, ProjectBoard>,
): boolean {
  for (const projectId of Object.keys(nextBoards)) {
    if (nextBoards[projectId]?.snapshotAt !== previousBoards[projectId]?.snapshotAt) return true;
  }
  return false;
}

/**
 * Starts watching. Called from `index.js` at bundle entry, beside
 * `registerMemoryShedders()` and for the same reason: outside React, so the
 * trail covers a connection that opens before any screen has mounted, and
 * registered once for the life of the process.
 *
 * Harmless without a DSN. The door it reports to no-ops when crash reporting
 * never started, so a build from source runs two cheap subscriptions that
 * record nothing.
 */
export function registerConnectionBreadcrumbs(): () => void {
  let trail = initialConnectionTrailState(useChannelStore.getState());

  const advance = (event: ConnectionTrailEvent): void => {
    const step = advanceConnectionTrail(trail, event);
    trail = step.state;
    for (const state of step.record) recordConnectionState(state);
  };

  const unsubscribeChannel = useChannelStore.subscribe((next) => {
    // The store is also written for rekeys, the relay address and the paired
    // state. None of those is on the trail.
    if (next.transportState === trail.transportState && next.established === trail.established) return;
    advance({ kind: 'channel', transportState: next.transportState, established: next.established });
  });

  const unsubscribeBoard = useBoardStore.subscribe((next, previous) => {
    if (!awaitsBoardSnapshot(trail)) return;
    if (next.boardsByProjectId === previous.boardsByProjectId) return;
    if (!hasNewBoardSnapshot(next.boardsByProjectId, previous.boardsByProjectId)) return;
    advance({ kind: 'board-snapshot' });
  });

  return () => {
    unsubscribeChannel();
    unsubscribeBoard();
  };
}
