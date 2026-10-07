import type { ActivityEvent, TranscriptEvent, Unsubscribe } from '@kangentic/protocol';
import type { FeedRouter, SubscriptionManager, SubscriptionSnapshotSinks } from '@/channel';
import { traceConnection } from '@/devsupport/connectionTrace';
import {
  RESPAWN_ROW_GRACE_MS,
  extractSpawnProgressLabel,
  extractSuccessorSessionId,
  respawnGraceMs,
  selectPendingSuccessor,
  selectTaskRespawn,
  useActivityStore,
} from '@/state/activityStore';
import { findTaskById, sessionlessTaskStatus, useBoardStore, selectLiveSessionIds } from '@/state/boardStore';
import { useDiffStore } from '@/state/diffStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import {
  appendChunk,
  getTerminalDimensions,
  isTerminalRetained,
  seedScrollback,
  setTerminalDimensions,
} from '@/state/terminalFeed';

/**
 * The single place feed events and subscription snapshots meet store
 * actions - pure mapping, no policy. Reconciliation policy (which streams
 * to want, when to refresh) lives in SubscriptionManager + the board-diff
 * logic below; screens read stores and call actions.ts.
 */

/**
 * Which task owns a session: the board's answer first; then a successor the
 * desktop named (`session-ended.successorSessionId`) that no board lists yet;
 * then the owner the session was registered under. The last two matter
 * because `applySnapshot` OVERWRITES the entry's owner with what this returns,
 * so a snapshot that beats the board used to blank a correctly registered
 * entry's `taskId` to ''.
 */
function sessionOwnerFor(sessionId: string): { taskId: string; projectId: string } | null {
  const boardState = useBoardStore.getState();
  for (const [projectId, board] of Object.entries(boardState.boardsByProjectId)) {
    for (const task of Object.values(board.tasksById)) {
      if (task.session_id === sessionId) return { taskId: task.id, projectId };
    }
  }
  const pendingTaskId = pendingSuccessorTaskFor(sessionId);
  if (pendingTaskId !== null) {
    const pending = useActivityStore.getState().pendingSuccessorByTaskId[pendingTaskId];
    const projectId = pending?.projectId ?? findTaskById(boardState, pendingTaskId)?.projectId ?? null;
    if (projectId !== null) return { taskId: pendingTaskId, projectId };
  }
  const entry = useActivityStore.getState().bySessionId[sessionId];
  if (entry !== undefined && entry.taskId !== '' && entry.projectId !== '') return { taskId: entry.taskId, projectId: entry.projectId };
  return null;
}

/** The task this session is the (still unconfirmed, in-window) named successor for, or null. */
function pendingSuccessorTaskFor(sessionId: string): string | null {
  const activityState = useActivityStore.getState();
  for (const [taskId, pending] of Object.entries(activityState.pendingSuccessorByTaskId)) {
    if (pending.sessionId === sessionId && selectPendingSuccessor(activityState, taskId) !== null) return taskId;
  }
  return null;
}

/**
 * After each board snapshot: register every live session with its owning
 * task (the triage card needs taskId/projectId), drop activity entries for
 * sessions no board claims anymore, and re-declare the desired stream set.
 *
 * THE SUCCESSOR HOP. A successor the desktop named on a `session-ended`
 * (protocol 0.16.0: a resume of a paused row ends that row's feed, it never
 * turns it back into running) counts as the task's session until a board
 * names one itself: the ended id leaves the desired set and the successor
 * joins it, so it is subscribed now rather than a debounced board round trip
 * later. It is deliberately NOT registered here. The ghost keeps the row
 * (reading the desktop's "Resuming session..." step) until the successor's own
 * snapshot lands, which registers it from the ghost and re-runs this pass
 * (`onStreamSnapshot`), so the card goes straight from the step to the
 * successor's own state instead of borrowing the ghost's usage bar for a
 * round trip.
 *
 * The prune has two exceptions, both holding a row in place:
 *
 * 1. An end in flight (`selectTaskRespawn`): a task whose session just ended
 *    keeps its entry, labelled or not, so the Home feed can go on drawing the
 *    row exactly as it was instead of dropping it for the several seconds the
 *    task is sessionless. An older desktop's column-move swap arrives with no
 *    label and is indistinguishable from a park when it lands, so both are
 *    kept; the window (`respawnGraceMs`, short for an unlabelled end) is what
 *    bounds a park.
 * 2. A board that VOUCHES for the sessionless task (protocol 0.16.0,
 *    `sessionlessTaskStatus`): paused with a Resume, or a spawn label in
 *    flight. The desktop keeps that task in its `'sessions'` projection with a
 *    null `session_id`, so the session it ended is the task's Paused card, or
 *    its long respawn's card, for as long as the board says so - the SAME row,
 *    key, slot and ordering, never remounted as a task row. Only for an entry
 *    the desktop has ended: a live-looking entry whose end the phone missed
 *    would draw a running card for a paused task, so it is pruned and the
 *    feed's task row draws the truth instead. Past its window, the task's
 *    respawn record is dropped (`expireTaskRespawn`), a store write that
 *    re-renders the row whose display just changed with the clock.
 *
 * ONE ROW PER TASK: either exception yields the moment another entry claims
 * the task (a session the board, or a pending successor, makes live).
 *
 * Ordering makes the common case need no extra bookkeeping. The register loop
 * runs FIRST and `registerSession` clears the task's end fact, so by the time
 * the prune loop asks `selectTaskRespawn`, the snapshot that installs the
 * successor has already answered "nothing in flight" and the ghost is
 * released in that same pass. One snapshot, never two rows.
 */
function reconcileSessionsFromBoards(subscriptions: SubscriptionManager): void {
  const boardState = useBoardStore.getState();
  const liveSessionIds = selectLiveSessionIds(boardState);

  for (const [projectId, board] of Object.entries(boardState.boardsByProjectId)) {
    for (const task of Object.values(board.tasksById)) {
      if (task.session_id !== null && task.archived_at === null) {
        useActivityStore.getState().registerSession(task.session_id, task.id, projectId);
      }
    }
  }
  for (const [taskId, pending] of Object.entries(useActivityStore.getState().pendingSuccessorByTaskId)) {
    const boardSessionId = findTaskById(boardState, taskId)?.task.session_id ?? null;
    const boardCaughtUp = boardSessionId !== null && boardSessionId !== pending.endedSessionId;
    if (boardCaughtUp || selectPendingSuccessor(useActivityStore.getState(), taskId) === null) {
      useActivityStore.getState().releasePendingSuccessor(taskId);
      continue;
    }
    liveSessionIds.delete(pending.endedSessionId);
    liveSessionIds.add(pending.sessionId);
  }
  const claimedTaskIds = new Set<string>();
  for (const entry of Object.values(useActivityStore.getState().bySessionId)) {
    if (liveSessionIds.has(entry.sessionId)) claimedTaskIds.add(entry.taskId);
  }
  for (const sessionId of Object.keys(useActivityStore.getState().bySessionId)) {
    if (liveSessionIds.has(sessionId)) continue;
    const activityState = useActivityStore.getState();
    const entry = activityState.bySessionId[sessionId];
    if (entry !== undefined && !claimedTaskIds.has(entry.taskId)) {
      if (selectTaskRespawn(activityState, entry.taskId) !== null) {
        claimedTaskIds.add(entry.taskId);
        continue;
      }
      const boardTask = findTaskById(boardState, entry.taskId)?.task ?? null;
      const ended = entry.feedStatus === 'ended' || activityState.endedSessionIds[sessionId] === true;
      if (ended && boardTask !== null && sessionlessTaskStatus(boardTask) !== null) {
        claimedTaskIds.add(entry.taskId);
        activityState.expireTaskRespawn(entry.taskId);
        continue;
      }
    }
    useActivityStore.getState().removeSession(sessionId);
  }

  subscriptions.setDesiredStreams(liveSessionIds);
}

export function createSnapshotSinks(getSubscriptions: () => SubscriptionManager): SubscriptionSnapshotSinks {
  return {
    onStreamSnapshot: (sessionId, snapshot) => {
      const owner = sessionOwnerFor(sessionId);
      // The successor hop's second half (see reconcileSessionsFromBoards): a
      // named successor no board lists yet is registered HERE, from the ghost
      // it replaces, so the snapshot below lands on the ghost's row and slot,
      // and the pass after it releases the ghost. Registered once: a later
      // re-subscribe finds the entry already there.
      const hopTaskId = pendingSuccessorTaskFor(sessionId);
      const hopRegisters = hopTaskId !== null && owner !== null && useActivityStore.getState().bySessionId[sessionId] === undefined;
      if (hopRegisters) useActivityStore.getState().registerSession(sessionId, owner.taskId, owner.projectId);
      useActivityStore.getState().applySnapshot(sessionId, owner?.taskId ?? '', owner?.projectId ?? '', snapshot);
      if (hopRegisters) reconcileSessionsFromBoards(getSubscriptions());
      if (isTerminalRetained(sessionId)) {
        // Dims land BEFORE the seed so the pane's re-init reads the grid the
        // fresh scrollback was laid out for.
        setTerminalDimensions(sessionId, snapshot.ptyDimensions ?? null);
        seedScrollback(sessionId, snapshot.scrollback);
      }
    },
    onStreamRejected: (sessionId) => {
      useActivityStore.getState().markRejected(sessionId);
    },
    onBoardSnapshot: (snapshot) => {
      traceConnection('board-snapshot', { view: snapshot.view ?? null, tasks: snapshot.tasks.length });
      useBoardStore.getState().applyBoardSnapshot(snapshot);
      reconcileSessionsFromBoards(getSubscriptions());
    },
    onDiffFileList: (taskId, fileList) => {
      const scope = useDiffStore.getState().byTaskId[taskId]?.scope ?? 'working';
      useDiffStore.getState().applyFileList(taskId, scope, fileList);
    },
    onDiffFetchFailed: (taskId, scope) => {
      // The scope the FETCH was for, not whatever the store happens to hold:
      // a scope switch mid-flight must not mark the new scope failed.
      useDiffStore.getState().setStatus(taskId, scope, 'error');
    },
  };
}

/**
 * Coalesce window for transcript deltas. They arrive many times per second
 * while an agent streams (the settled tail entry grows token by token), and
 * each one re-copies the window array AND re-runs ConversationTab's O(n)
 * conversation-cell flatten - so a firehose costs O(n * deltas/sec) of
 * main-thread work that worsens as the transcript grows. Batching a burst into
 * one apply per window collapses that to one flatten+render per window. The
 * settled transcript does not need per-token freshness: the 250ms live-tail
 * carries the token-by-token streaming feel.
 */
const TRANSCRIPT_COALESCE_MS = 100;

/**
 * Coalesce window for usage (token-accounting) activity events. They stream
 * frequently during a turn but only bump a counter, yet each one produces a new
 * activity map and re-renders TriageHome (which subscribes to the whole map and
 * stays mounted behind the task screen). Only the latest usage per session
 * matters, so we keep the newest and apply it per window. Meaningful
 * transitions (state / event / permission) still apply immediately.
 */
const USAGE_COALESCE_MS = 500;

/**
 * How long a live `status: 'suspended'` push (protocol 0.16.0) waits for the
 * `session-ended` that explains it before it is applied on its own.
 *
 * The desktop's `suspend()` announces 'suspended' BEFORE it shuts the PTY down
 * (session-manager.ts: "Mark suspended BEFORE killing", then up to 1500 ms for a
 * natural exit plus 1500 ms for the kill), and it suspends ahead of every
 * model, agent, effort or column-move respawn. On the desktop that never reads
 * as "Paused", because the respawn's label is set first and wins (the card's
 * precedence). On the phone the label arrives later than the status, through a
 * board event, the 300 ms refresh debounce and a round trip, so applying the
 * push at once read "Paused" - and moved the Agents feed row into Paused - for
 * the gap of every respawn.
 *
 * So the edge INTO 'suspended' is held until the end arrives (the PTY exit
 * sends it, and a respawn's carries its label), which is applied right behind
 * it, so a respawn reads as its step and a genuine pause as Paused. A board
 * snapshot carrying the label deliberately does NOT release it: applied on a
 * session still live, the status would read Paused under that label until the
 * end. The cap only covers an end that never comes, a little past the
 * desktop's own 3 s shutdown bound; read out of the desktop source, not
 * measured.
 */
export const SUSPEND_PUSH_HOLD_MS = 3_500;

export function bindFeedToStores(feed: FeedRouter, subscriptions: SubscriptionManager): Unsubscribe {
  // A desktop-side PTY resize reflows the desktop terminal, so the phone's
  // ring holds scrollback laid out for the OLD grid - mixing it with
  // new-width deltas renders garble. Re-subscribing fetches a fresh
  // serialized frame at the new grid (replace semantics desktop-side) and
  // the pane re-seeds. Debounced per session: a drag-resize emits a burst.
  const RESIZE_RESEED_DEBOUNCE_MS = 300;
  const resizeReseedTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // One pending prune per task with a respawn in flight - see the activity
  // handler. Keyed by task so a second respawn restarts that task's window
  // rather than stacking a second sweep.
  const respawnSweepTimers = new Map<string, ReturnType<typeof setTimeout>>();
  // One held 'suspended' push per session, at most (see SUSPEND_PUSH_HOLD_MS).
  const heldSuspendBySessionId = new Map<string, { event: ActivityEvent; timer: ReturnType<typeof setTimeout> }>();
  const dropHeldSuspend = (sessionId: string): void => {
    const held = heldSuspendBySessionId.get(sessionId);
    if (held === undefined) return;
    clearTimeout(held.timer);
    heldSuspendBySessionId.delete(sessionId);
  };
  const releaseHeldSuspend = (sessionId: string): void => {
    const held = heldSuspendBySessionId.get(sessionId);
    if (held === undefined) return;
    dropHeldSuspend(sessionId);
    useActivityStore.getState().applyActivityEvent(held.event);
  };

  let pendingTranscriptEvents: TranscriptEvent[] = [];
  let transcriptFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushTranscriptEvents = (): void => {
    transcriptFlushTimer = null;
    if (pendingTranscriptEvents.length === 0) return;
    const events = pendingTranscriptEvents;
    pendingTranscriptEvents = [];
    // Applied in arrival order; revisions are monotonic so this equals applying
    // each delta as it arrived. React batches the resulting store updates into a
    // single render, so the O(n) flatten runs once for the whole batch.
    const store = useTranscriptStore.getState();
    for (const event of events) store.applyTranscript(event);
  };

  const latestUsageEventBySession = new Map<string, ActivityEvent>();
  let usageFlushTimer: ReturnType<typeof setTimeout> | null = null;
  const flushUsageEvents = (): void => {
    usageFlushTimer = null;
    if (latestUsageEventBySession.size === 0) return;
    const events = [...latestUsageEventBySession.values()];
    latestUsageEventBySession.clear();
    const store = useActivityStore.getState();
    for (const event of events) store.applyActivityEvent(event);
  };

  const unsubscribers: Unsubscribe[] = [
    feed.on('transcript', (event) => {
      pendingTranscriptEvents.push(event);
      if (transcriptFlushTimer === null) {
        transcriptFlushTimer = setTimeout(flushTranscriptEvents, TRANSCRIPT_COALESCE_MS);
      }
    }),
    feed.on('terminal', (event) => {
      // Dropped at the terminalFeed boundary unless the session is retained
      // (a task screen has it open) - triage needs activity, not PTY bytes.
      appendChunk(event.sessionId, event.payload.data);
    }),
    feed.on('terminal-resize', (event) => {
      // An event that repeats the dims the ring already holds means the
      // desktop terminal never reflowed, so the buffered bytes are still
      // laid out correctly and the live chunks stay coherent - skip the
      // re-seed rather than pay a serialized-frame round trip to repaint an
      // identical view. The desktop DOES emit such no-ops: its resize() has
      // no same-dims guard, and a task-detail remount (a project switch
      // away and back) re-sends the detail's unchanged fit. A null baseline
      // still re-seeds - with no known layout, the fresh frame is the truth.
      const previousDimensions = getTerminalDimensions(event.sessionId);
      setTerminalDimensions(event.sessionId, event.payload);
      if (
        previousDimensions !== null &&
        previousDimensions.cols === event.payload.cols &&
        previousDimensions.rows === event.payload.rows
      ) {
        return;
      }
      if (isTerminalRetained(event.sessionId)) {
        const existingTimer = resizeReseedTimers.get(event.sessionId);
        if (existingTimer !== undefined) clearTimeout(existingTimer);
        resizeReseedTimers.set(
          event.sessionId,
          setTimeout(() => {
            resizeReseedTimers.delete(event.sessionId);
            subscriptions.refreshStream(event.sessionId);
          }, RESIZE_RESEED_DEBOUNCE_MS),
        );
      }
    }),
    feed.on('activity', (event) => {
      if (event.payload.type === 'usage') {
        // Keep only the newest usage per session; flush per window so a token
        // firehose does not re-render TriageHome on every tick.
        latestUsageEventBySession.set(event.sessionId, event);
        if (usageFlushTimer === null) {
          usageFlushTimer = setTimeout(flushUsageEvents, USAGE_COALESCE_MS);
        }
        return;
      }
      if (event.payload.type === 'status') {
        // A newer status supersedes a held one, whatever it says.
        dropHeldSuspend(event.sessionId);
        const entry = useActivityStore.getState().bySessionId[event.sessionId];
        // Only the EDGE into 'suspended' is held. A push for a session already
        // suspended changes `resumable` alone (a move to Done, an archive) and
        // applies at once, as does every other status.
        if (event.payload.status === 'suspended' && entry !== undefined && entry.sessionStatus !== 'suspended') {
          const heldSessionId = event.sessionId;
          heldSuspendBySessionId.set(heldSessionId, {
            event,
            timer: setTimeout(() => releaseHeldSuspend(heldSessionId), SUSPEND_PUSH_HOLD_MS),
          });
          return;
        }
        useActivityStore.getState().applyActivityEvent(event);
        return;
      }
      // The end a held 'suspended' was waiting for: the status lands first,
      // then the end, back to back in one synchronous turn (one render).
      if (event.payload.type === 'session-ended') releaseHeldSuspend(event.sessionId);
      useActivityStore.getState().applyActivityEvent(event);
      // An end with no successor (a park, or a respawn that dies) must not
      // leave its row on screen forever. The retention above releases the
      // ghost on the board snapshot carrying the successor - but board
      // snapshots are EVENT-driven, not periodic, so on a quiet desktop a park
      // would see no further snapshot and the row would sit there
      // indefinitely. This is the only thing that re-runs the prune on a
      // clock, and it arms on EVERY end, since every end is now retained.
      //
      // Deliberately re-runs the existing reconcile rather than removing the
      // entry directly, so `removeSession` keeps exactly one caller and the
      // retention rule is evaluated in one place. The deadline is the same
      // per-record window the selector applies (`respawnGraceMs`, read off the
      // same extracted label the store recorded), so by the time it fires
      // `selectTaskRespawn` reports nothing in flight and the pass prunes
      // normally. No early cancel when the successor lands: that pass is
      // already a no-op, and one extra reconcile per swap is cheaper than the
      // bookkeeping to avoid it.
      if (event.payload.type !== 'session-ended') return;
      const respawnedTaskId = event.taskId;
      const pendingSweep = respawnSweepTimers.get(respawnedTaskId);
      if (pendingSweep !== undefined) clearTimeout(pendingSweep);
      // A named successor holds its stream for RESPAWN_ROW_GRACE_MS whatever
      // the end's label (selectPendingSuccessor), so its sweep waits as long.
      const successorNamed = extractSuccessorSessionId(event) !== null;
      respawnSweepTimers.set(
        respawnedTaskId,
        setTimeout(
          () => {
            respawnSweepTimers.delete(respawnedTaskId);
            reconcileSessionsFromBoards(subscriptions);
          },
          successorNamed ? RESPAWN_ROW_GRACE_MS : respawnGraceMs({ label: extractSpawnProgressLabel(event.payload) }),
        ),
      );
      // The hop: subscribe the named successor now, not when a board snapshot
      // gets round to naming it (see reconcileSessionsFromBoards).
      if (successorNamed) reconcileSessionsFromBoards(subscriptions);
    }),
    feed.on('board', (event) => {
      // BoardEvents carry ids only; reconciliation is a debounced re-snapshot.
      subscriptions.refreshBoard(event.projectId);
    }),
    feed.on('diff', (event) => {
      useDiffStore.getState().markStale(event.taskId);
      subscriptions.refreshDiff(event.taskId);
    }),
  ];
  return () => {
    for (const reseedTimer of resizeReseedTimers.values()) clearTimeout(reseedTimer);
    resizeReseedTimers.clear();
    // Dropped rather than flushed: unbinding tears the feed down, and a prune
    // pass firing against a disconnected channel would re-declare a desired
    // stream set nothing is listening for.
    for (const sweepTimer of respawnSweepTimers.values()) clearTimeout(sweepTimer);
    respawnSweepTimers.clear();
    // Dropped, not applied, for the same reason: the feed is going away.
    for (const held of heldSuspendBySessionId.values()) clearTimeout(held.timer);
    heldSuspendBySessionId.clear();
    if (transcriptFlushTimer !== null) {
      clearTimeout(transcriptFlushTimer);
      transcriptFlushTimer = null;
    }
    flushTranscriptEvents();
    if (usageFlushTimer !== null) {
      clearTimeout(usageFlushTimer);
      usageFlushTimer = null;
    }
    flushUsageEvents();
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
