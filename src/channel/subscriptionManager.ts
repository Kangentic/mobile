import type {
  DiffFileListWire,
  ReadBoardSnapshotResponsePayload,
  ReadBoardView,
  ReadDiffScope,
  ReadStreamResponsePayload,
  Unsubscribe,
} from '@kangentic/protocol';
import { traceConnection } from '@/devsupport/connectionTrace';
import { createBoundedTaskQueue } from '../lib/boundedTaskQueue';
import type { SessionManager } from './sessionManager';
import { CapabilityError, type VerbClient } from './verbClient';

const BOARD_REFRESH_DEBOUNCE_MS = 300;
const DIFF_REFRESH_DEBOUNCE_MS = 500;
const STREAM_RETRY_DELAY_MS = 2000;
/**
 * Same shape as the stream retry, added 2026-09-18 after the Board tab sat on
 * its skeleton for two minutes: the project switch's full-board upgrade hit
 * CapabilityClient's 10 s timeout once, and nothing re-issued it until the tab
 * was left and re-entered (the refocus retry in setBoardWantsFull), which then
 * landed in four seconds. One retry, queued, never for a rejection.
 */
const BOARD_RETRY_DELAY_MS = 2000;

/**
 * How many subscribe requests may be in flight at once.
 *
 * The cold-start fan-out is one `read-board` per project plus one `read-stream`
 * per live session, and it used to issue all of them at once: at the fleet size
 * that made Sentry MOBILE-8 plausible that is over fifty simultaneous requests,
 * each answered by a snapshot this process has to decode. Same shape as the
 * Agents feed's snippet pre-warm and the same fix, applied one layer up.
 *
 * Deliberately its OWN queue rather than one shared with the feed's pre-warm.
 * Sharing would mean a module in `src/channel/` reaching for screen state, and
 * these are not interchangeable: a subscribe is required work that must
 * eventually happen, a pre-warm is discretionary and gets dropped under memory
 * pressure. The combined worst case is the two caps added together, which is
 * still a constant rather than a function of fleet size.
 *
 * CHOSEN, not measured. The pre-warm's cap has the same status. Both are
 * provably constant in fleet size, which is the fix; the specific numbers want
 * the Android A/B described in `docs/developer-guide.md`.
 */
export const SUBSCRIBE_FAN_OUT_CONCURRENCY = 4;

export interface SubscriptionSnapshotSinks {
  onStreamSnapshot(sessionId: string, snapshot: ReadStreamResponsePayload): void;
  /** A stream subscribe the desktop rejected (e.g. "No such session") - the id is pruned from the desired set before this fires. */
  onStreamRejected(sessionId: string, error: CapabilityError): void;
  onBoardSnapshot(snapshot: ReadBoardSnapshotResponsePayload): void;
  onDiffFileList(taskId: string, fileList: DiffFileListWire): void;
  /** A diff fetch that failed, so the Changes pane can stop waiting and say so. */
  onDiffFetchFailed(taskId: string, scope: ReadDiffScope): void;
}

interface DesiredDiff {
  projectId: string;
  scope: ReadDiffScope;
}

export interface SubscriptionManagerOptions {
  session: SessionManager;
  verbs: VerbClient;
  sinks: SubscriptionSnapshotSinks;
}

/**
 * A desired-state reconciler over the verb client: screens and the
 * bootstrap declare WHAT should be live (stream sessions, board projects,
 * at most a screenful of diff watches) and this owns WHEN to (re)issue the
 * subscribe requests.
 *
 * Key desktop facts this leans on:
 * - `SubscriptionRegistry.set` desktop-side replaces-and-tears-down a prior
 *   subscription under the same key, so re-issuing a subscribe is always
 *   safe and doubles as "refresh the snapshot".
 * - `SessionManager.onEstablished` fires only on the null-to-established
 *   transition: a routine ~2 minute desktop rekey does NOT reset streams
 *   (the desktop keeps its registry across rekeys), while a transport drop
 *   runs `ChannelController`'s `session.reset()`, so the next handshake
 *   fires it - exactly when the desktop may have torn subscriptions down
 *   and a fresh snapshot is wanted anyway. Resubscribe-on-established is
 *   both necessary and sufficient.
 *
 * Every subscribe result flows through the sinks, making first-subscribe
 * and resubscribe one code path: stores always get snapshots from sinks
 * and deltas from FeedRouter.
 */
export class SubscriptionManager {
  private readonly session: SessionManager;
  private readonly verbs: VerbClient;
  private readonly sinks: SubscriptionSnapshotSinks;
  private readonly unsubscribeEstablished: Unsubscribe;
  private readonly unsubscribeRekey: Unsubscribe;

  private desiredStreamIds = new Set<string>();
  private desiredBoardIds = new Set<string>();
  private readonly desiredDiffsByTaskId = new Map<string, DesiredDiff>();

  private readonly activeStreamIds = new Set<string>();
  /**
   * Sessions whose subscription must carry live PTY bytes - the ones with a
   * terminal on screen. Everything else subscribes list-only: the feed needs
   * activity, not output it discards on arrival.
   */
  private readonly terminalStreamIds = new Set<string>();
  private readonly activeBoardIds = new Set<string>();
  /**
   * Which projection each board is subscribed with. Boards start at
   * 'sessions' (the feed watches every project but only draws the tasks with
   * an agent on them) and are upgraded to 'full' when the Board tab opens
   * one. The upgrade is permanent for the life of the pairing: a full board
   * is at most a few tens of kB, and downgrading would let a snapshot drop a
   * task that an optimistic move/edit/removal is still pending on, leaving
   * the rollback with nothing to restore.
   */
  private readonly boardViewByProjectId = new Map<string, ReadBoardView>();
  /**
   * The projection each board's last SUCCESSFUL subscribe actually returned,
   * as opposed to the one wanted above. Kept apart so a failed upgrade can be
   * retried: recording the intent as if it had landed would make every later
   * request a no-op, and the Board tab would wait on a snapshot nobody was
   * going to ask for again.
   */
  private readonly activeBoardViewByProjectId = new Map<string, ReadBoardView>();
  /**
   * Board subscribes issued and not yet answered, by project, with the view
   * they asked for. A re-establish issues one subscribe per desired board from
   * onEstablished, and connectionManager's own established listener then runs
   * the bootstrap, whose setDesiredBoards re-declares the same set. Before
   * this map, whether that second pass re-subscribed every board depended on
   * the desktop answering the project list before or after the N board reads:
   * `activeBoardIds` only fills as snapshots land, so a fast project list
   * meant 2N board reads, snapshots and store writes on every reconnect. An
   * identical request already in flight is the same request; only a request
   * that has settled (landed, failed, or timed out) can be re-issued, which
   * keeps setBoardWantsFull's re-focus retry working for a request the
   * desktop actually lost.
   */
  private readonly pendingBoardViewByProjectId = new Map<string, ReadBoardView>();
  private readonly activeDiffTaskIds = new Set<string>();

  private readonly boardRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly diffRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly streamRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly boardRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly subscribeQueue = createBoundedTaskQueue(SUBSCRIBE_FAN_OUT_CONCURRENCY);
  /**
   * Which ids already have a subscribe SCHEDULED but not yet started.
   *
   * Without this the cap makes an existing tolerance into a real problem.
   * `activeStreamIds` is only written once a response lands, so during the
   * in-flight window the guard in `setDesiredStreams` is false and a second
   * reconcile re-issues - harmless today because the desktop's
   * `SubscriptionRegistry.set` replaces-and-tears-down, so a re-issue is just a
   * refresh. Behind a queue those duplicates stop being free: they occupy the
   * four slots that the sessions with no subscription at all are waiting for.
   *
   * The flag clears when the task STARTS, not when its response lands, so the
   * refresh-by-re-issue behaviour above is preserved for anything that asks
   * while the request is genuinely in flight.
   */
  private readonly queuedStreamIds = new Set<string>();
  private readonly queuedBoardIds = new Set<string>();
  /**
   * Stream subscribes that have been SENT and not yet answered. A reconcile
   * that lands inside that window (a board snapshot re-listing the session
   * the screen just opened) must not issue a second copy of a request the
   * desktop is already answering. Measured on a release build: every column
   * move seeded the successor's terminal twice, 30 to 45 ms apart, one from
   * the reconcile's queue and one from the screen's terminal flip, and the
   * page replayed a full ring for each.
   */
  private readonly inFlightStreamIds = new Set<string>();
  private disposed = false;

  constructor(options: SubscriptionManagerOptions) {
    this.session = options.session;
    this.verbs = options.verbs;
    this.sinks = options.sinks;
    this.unsubscribeEstablished = this.session.onEstablished(() => this.onEstablished());
    this.unsubscribeRekey = this.session.onRekey(() => this.onRekey());
  }

  setDesiredStreams(sessionIds: ReadonlySet<string>): void {
    const previousDesired = this.desiredStreamIds;
    this.desiredStreamIds = new Set(sessionIds);

    for (const sessionId of previousDesired) {
      if (!this.desiredStreamIds.has(sessionId)) this.dropStream(sessionId);
    }
    if (!this.session.isEstablished) return;
    for (const sessionId of this.desiredStreamIds) {
      if (
        !this.activeStreamIds.has(sessionId) &&
        !this.inFlightStreamIds.has(sessionId) &&
        !this.streamRetryTimers.has(sessionId)
      ) {
        this.enqueueStreamSubscribe(sessionId);
      }
    }
  }

  setDesiredBoards(projectIds: ReadonlySet<string>): void {
    const previousDesired = this.desiredBoardIds;
    this.desiredBoardIds = new Set(projectIds);

    for (const projectId of previousDesired) {
      if (!this.desiredBoardIds.has(projectId)) this.dropBoard(projectId);
    }
    if (!this.session.isEstablished) return;
    for (const projectId of this.desiredBoardIds) {
      if (!this.activeBoardIds.has(projectId)) this.enqueueBoardSubscribe(projectId);
    }
  }

  /**
   * Upgrade one project's board to the full projection - the Board tab, which
   * renders every column and every card, not just the ones with an agent on
   * them. Never reversed (see boardViewByProjectId).
   *
   * Safe to call repeatedly, and the Board tab does on every focus: while the
   * upgrade has not actually landed this re-issues it, so a request lost to a
   * rekey or a timeout is retried by leaving the tab and coming back rather
   * than stranding the screen on its loading state. An upgrade still in
   * flight is not lost, and is not re-issued (pendingBoardViewByProjectId);
   * once it times out it is, and the next focus retries it.
   */
  setBoardWantsFull(projectId: string): void {
    this.boardViewByProjectId.set(projectId, 'full');
    if (this.activeBoardViewByProjectId.get(projectId) === 'full') return;
    if (!this.desiredBoardIds.has(projectId) || !this.session.isEstablished) return;
    void this.subscribeBoard(projectId);
  }

  /** At most a screenful of these exist (the Changes tab sets one on focus, null on blur) - the desktop fs-watcher is the scarce resource. */
  setDesiredDiff(taskId: string, input: DesiredDiff | null): void {
    if (input === null) {
      const previous = this.desiredDiffsByTaskId.get(taskId);
      this.desiredDiffsByTaskId.delete(taskId);
      if (this.activeDiffTaskIds.has(taskId) && previous) this.dropDiff(taskId, previous.projectId);
      return;
    }
    const previous = this.desiredDiffsByTaskId.get(taskId);
    this.desiredDiffsByTaskId.set(taskId, input);
    const scopeChanged = previous !== undefined && (previous.scope !== input.scope || previous.projectId !== input.projectId);
    if (!this.session.isEstablished) return;
    // A scope change is a re-subscribe (the desktop keys the watch by task
    // only and replaces it); an unchanged active watch needs nothing.
    if (!this.activeDiffTaskIds.has(taskId) || scopeChanged) void this.subscribeDiff(taskId, input);
  }

  /** Debounced re-subscribe: the BoardEvent delta carries ids only, so reconciliation is a fresh snapshot. */
  refreshBoard(projectId: string): void {
    if (!this.desiredBoardIds.has(projectId)) return;
    const existingTimer = this.boardRefreshTimers.get(projectId);
    if (existingTimer) return;
    this.boardRefreshTimers.set(
      projectId,
      setTimeout(() => {
        this.boardRefreshTimers.delete(projectId);
        if (this.session.isEstablished && this.desiredBoardIds.has(projectId)) void this.subscribeBoard(projectId, { force: true });
      }, BOARD_REFRESH_DEBOUNCE_MS),
    );
  }

  /**
   * Declare whether this session's subscription needs live PTY bytes. A
   * session screen turns it on when it opens and off when it closes; the feed
   * never turns it on. Flipping it re-subscribes, which is also what fetches
   * the fresh scrollback a newly-opened terminal needs to seed itself.
   *
   * Returns whether it issued that re-subscribe, so a caller that also wants
   * a fresh frame knows whether it still needs to ask for one.
   */
  setStreamWantsTerminal(sessionId: string, wantsTerminal: boolean): boolean {
    const previous = this.terminalStreamIds.has(sessionId);
    if (previous === wantsTerminal) return false;
    if (wantsTerminal) this.terminalStreamIds.add(sessionId);
    else this.terminalStreamIds.delete(sessionId);
    if (!this.desiredStreamIds.has(sessionId) || !this.session.isEstablished) return false;
    // A reconcile's copy still waiting in the queue is superseded by this
    // direct one: it would read the same flag when it started and answer the
    // same question a second time (the successor seeded twice per swap).
    this.queuedStreamIds.delete(sessionId);
    void this.subscribeStream(sessionId);
    return true;
  }

  /**
   * Immediate re-subscribe for one stream - the fresh-scrollback path when a
   * session screen opens.
   *
   * Deliberately NOT queued, and the same goes for `setStreamWantsTerminal`,
   * `setBoardWantsFull` and `refreshBoard`. Those four are one request each,
   * caused by a user action, and the screen is waiting on the answer; putting
   * them behind the fan-out cap would make opening a session screen wait on up
   * to four background subscribes. The cap exists for the storms, which are
   * the reconciles that issue one request PER project or PER session. A direct
   * re-issue can overlap a queued task for the same id, which is the
   * refresh-by-re-issue the desktop's replace-and-tear-down already makes safe.
   */
  refreshStream(sessionId: string): void {
    if (!this.desiredStreamIds.has(sessionId) || !this.session.isEstablished) return;
    // Same supersession as setStreamWantsTerminal: one answer is enough.
    this.queuedStreamIds.delete(sessionId);
    void this.subscribeStream(sessionId);
  }

  /** Debounced diff refetch after a DiffEvent (the event is a payload-less "re-fetch" signal). */
  refreshDiff(taskId: string): void {
    if (!this.desiredDiffsByTaskId.has(taskId)) return;
    if (this.diffRefreshTimers.has(taskId)) return;
    this.diffRefreshTimers.set(
      taskId,
      setTimeout(() => {
        this.diffRefreshTimers.delete(taskId);
        const desired = this.desiredDiffsByTaskId.get(taskId);
        if (desired && this.session.isEstablished) void this.subscribeDiff(taskId, desired);
      }, DIFF_REFRESH_DEBOUNCE_MS),
    );
  }

  /** Read-only copies of the desired/active sets, for the dev inspect bridge. */
  debugSnapshot(): {
    desiredStreams: string[];
    activeStreams: string[];
    desiredBoards: string[];
    activeBoards: string[];
    fullBoards: string[];
    desiredDiffTaskIds: string[];
    activeDiffTaskIds: string[];
  } {
    return {
      desiredStreams: [...this.desiredStreamIds].sort(),
      activeStreams: [...this.activeStreamIds].sort(),
      desiredBoards: [...this.desiredBoardIds].sort(),
      activeBoards: [...this.activeBoardIds].sort(),
      fullBoards: [...this.boardViewByProjectId.entries()].filter(([, view]) => view === 'full').map(([projectId]) => projectId).sort(),
      desiredDiffTaskIds: [...this.desiredDiffsByTaskId.keys()].sort(),
      activeDiffTaskIds: [...this.activeDiffTaskIds].sort(),
    };
  }

  dispose(): void {
    this.disposed = true;
    this.subscribeQueue.clear();
    this.queuedStreamIds.clear();
    this.queuedBoardIds.clear();
    this.unsubscribeEstablished();
    this.unsubscribeRekey();
    for (const timer of this.boardRefreshTimers.values()) clearTimeout(timer);
    this.boardRefreshTimers.clear();
    for (const timer of this.diffRefreshTimers.values()) clearTimeout(timer);
    this.diffRefreshTimers.clear();
    for (const timer of this.streamRetryTimers.values()) clearTimeout(timer);
    this.streamRetryTimers.clear();
    for (const timer of this.boardRetryTimers.values()) clearTimeout(timer);
    this.boardRetryTimers.clear();
  }

  /**
   * Schedules a stream subscribe behind the fan-out cap.
   *
   * Every precondition is re-checked at DRAIN time rather than trusted from
   * the closure, because the gap between enqueue and start is now unbounded.
   * A session can be desired, dropped, and desired again while its task waits;
   * the transport can drop and re-handshake. Checking only at enqueue would
   * re-establish a stream nobody wants (the drop already ran, so nothing would
   * ever tear it down again) or fire a request at a dead session.
   *
   * Note the flag is NOT cleared by `dropStream`. A queued task that finds its
   * session no longer desired simply no-ops, and one whose session was
   * re-desired in the meantime does the work the re-add wanted, so the flag can
   * stay set across the whole drop-and-re-add cycle without either losing a
   * subscribe or issuing two.
   */
  private enqueueStreamSubscribe(sessionId: string, isRetry = false): void {
    if (this.disposed || this.queuedStreamIds.has(sessionId)) return;
    this.queuedStreamIds.add(sessionId);
    this.subscribeQueue.enqueue(async () => {
      // Superseded while waiting: a direct subscribe for this id (the screen's
      // terminal flip or refresh) already went out carrying the current flag,
      // so this copy has nothing left to ask. `delete` doubles as the check.
      if (!this.queuedStreamIds.delete(sessionId)) return;
      // The isEstablished half is belt-and-braces: `SessionManager.send`
      // throws on a dead session anyway, so omitting it puts nothing on the
      // wire either. What it buys is that the task no-ops instead of throwing
      // into `subscribeStream`'s catch, which would arm a retry timer per
      // queued session for a connection that is already gone.
      if (this.disposed || !this.session.isEstablished || !this.desiredStreamIds.has(sessionId)) return;
      await this.subscribeStream(sessionId, isRetry);
    });
  }

  private enqueueBoardSubscribe(projectId: string, isRetry = false): void {
    if (this.disposed || this.queuedBoardIds.has(projectId)) return;
    this.queuedBoardIds.add(projectId);
    this.subscribeQueue.enqueue(async () => {
      this.queuedBoardIds.delete(projectId);
      if (this.disposed || !this.session.isEstablished || !this.desiredBoardIds.has(projectId)) return;
      await this.subscribeBoard(projectId, { isRetry });
    });
  }

  private onEstablished(): void {
    // The previous connection's actives are meaningless on a fresh
    // handshake (the desktop tore its registry down on disconnect).
    this.activeStreamIds.clear();
    this.activeBoardIds.clear();
    this.activeBoardViewByProjectId.clear();
    this.activeDiffTaskIds.clear();
    // Anything still pending was issued on the previous session's keys; the
    // controller rejected it, and the catch below clears it as it settles. A
    // fresh handshake starts from nothing in flight, and every board is
    // re-issued below, so an armed retry would only duplicate that.
    this.pendingBoardViewByProjectId.clear();
    for (const timer of this.boardRetryTimers.values()) clearTimeout(timer);
    this.boardRetryTimers.clear();
    // The biggest fan-out there is: every board and every live session at
    // once, on a path that also runs after a transport drop, so it is exactly
    // the cold-start storm repeated on every reconnect. Hence the cap.
    //
    // The full-first ordering matters MORE behind that cap, not less. The
    // boards held at 'full' are the ones a Board tab is showing, and the
    // desktop answers in issue order; unqueued, a feed-only project ahead of
    // them cost one round trip of latency, but with only
    // SUBSCRIBE_FAN_OUT_CONCURRENCY in flight it can cost several drains'
    // worth before the screen the user is looking at is even asked for.
    const boardsFullFirst = [...this.desiredBoardIds].sort(
      (left, right) => Number(this.boardViewByProjectId.get(right) === 'full') - Number(this.boardViewByProjectId.get(left) === 'full'),
    );
    for (const projectId of boardsFullFirst) this.enqueueBoardSubscribe(projectId);
    for (const sessionId of this.desiredStreamIds) this.enqueueStreamSubscribe(sessionId);
    for (const [taskId, desired] of this.desiredDiffsByTaskId) void this.subscribeDiff(taskId, desired);
  }

  /**
   * A board subscribe in flight across a rekey is lost the same way the
   * bootstrap is (see connectionManager's onRekey listener): sealed under keys
   * the desktop has just retired, it is never answered, and the board it
   * asked for stays empty until the next reconcile. Re-issuing it costs one
   * duplicate snapshot in the case where the answer was merely late, which
   * applyBoardSnapshot absorbs; `force` is what lets it past the in-flight
   * dedupe. Streams and diffs are not re-issued here: a lost stream subscribe
   * is re-declared by the next board snapshot's reconcile, and a diff by its
   * own screen's focus.
   */
  private onRekey(): void {
    if (!this.session.isEstablished) return;
    for (const projectId of [...this.pendingBoardViewByProjectId.keys()]) {
      if (this.desiredBoardIds.has(projectId)) void this.subscribeBoard(projectId, { force: true });
    }
  }

  private async subscribeStream(sessionId: string, isRetry = false): Promise<void> {
    const wantsTerminal = this.terminalStreamIds.has(sessionId);
    this.inFlightStreamIds.add(sessionId);
    try {
      const snapshot = await this.verbs.readStreamSubscribe(sessionId, { terminal: wantsTerminal }).finally(() => {
        this.inFlightStreamIds.delete(sessionId);
      });
      if (this.disposed || !this.desiredStreamIds.has(sessionId)) return;
      // Same staleness guard as subscribeBoard. Opening and immediately
      // closing a session screen flips the flag twice, so two subscribes are
      // in flight with opposite terminal values; whichever landed last would
      // otherwise decide the bookkeeping regardless of which is current.
      // Dropping the stale one loses nothing: the flag only ever changes on a
      // path that issues its own subscribe, so a fresher one is always coming.
      if (this.terminalStreamIds.has(sessionId) !== wantsTerminal) return;
      this.activeStreamIds.add(sessionId);
      this.sinks.onStreamSnapshot(sessionId, snapshot);
    } catch (error) {
      if (this.disposed || !this.desiredStreamIds.has(sessionId)) return;
      if (error instanceof CapabilityError) {
        // The desktop said no (session gone) - prune; the next board
        // snapshot reconcile re-adds it if it comes back.
        this.desiredStreamIds.delete(sessionId);
        this.sinks.onStreamRejected(sessionId, error);
        return;
      }
      // Timeout / transient transport failure: retry once after a beat,
      // then leave it to the next reconcile (established or board-driven).
      if (!isRetry && !this.streamRetryTimers.has(sessionId)) {
        this.streamRetryTimers.set(
          sessionId,
          setTimeout(() => {
            this.streamRetryTimers.delete(sessionId);
            // Queued, not direct: a transport hiccup fails the whole fan-out
            // at once, so every retry timer fires within the same tick and
            // the retry is a second storm in its own right.
            if (this.session.isEstablished && this.desiredStreamIds.has(sessionId)) this.enqueueStreamSubscribe(sessionId, true);
          }, STREAM_RETRY_DELAY_MS),
        );
      }
    }
  }

  /**
   * `force` is for refreshBoard only: a board event that lands while a
   * subscribe is still in flight means the snapshot about to arrive may
   * predate the change, so the refresh must go out regardless. Every
   * reconcile path (established, desired-set changes, the Board tab's
   * upgrade) asks for the same thing an in-flight request already asked for,
   * and is deduplicated.
   */
  private async subscribeBoard(projectId: string, options: { force?: boolean; isRetry?: boolean } = {}): Promise<void> {
    const view = this.boardViewByProjectId.get(projectId) ?? 'sessions';
    if (!options.force && this.pendingBoardViewByProjectId.get(projectId) === view) return;
    this.pendingBoardViewByProjectId.set(projectId, view);
    const issuedAt = Date.now();
    try {
      const snapshot = await this.verbs.readBoardSubscribe(projectId, { view });
      if (this.pendingBoardViewByProjectId.get(projectId) === view) this.pendingBoardViewByProjectId.delete(projectId);
      if (this.disposed || !this.desiredBoardIds.has(projectId)) return;
      // A response that answers a view we no longer want is stale, and
      // applying it would UNDO a newer one. Two subscribes for the same
      // project are legitimately in flight together (bootstrap asks for
      // 'sessions', the Board tab focusing then asks for 'full'), and
      // responses can land out of issue order. Without this, a late
      // 'sessions' snapshot overwrites the landed 'full' one: applyBoardSnapshot
      // replaces tasksById wholesale, so every task without a live session
      // vanishes from the Board tab, any optimistic move over one of them has
      // nothing left to commit against, and the screen strands on its skeleton
      // until the tab is re-focused. Mirrors the check subscribeDiff makes.
      if ((this.boardViewByProjectId.get(projectId) ?? 'sessions') !== view) return;
      this.activeBoardIds.add(projectId);
      this.activeBoardViewByProjectId.set(projectId, view);
      this.sinks.onBoardSnapshot(snapshot);
    } catch (error) {
      if (this.pendingBoardViewByProjectId.get(projectId) === view) this.pendingBoardViewByProjectId.delete(projectId);
      if (this.disposed || !this.desiredBoardIds.has(projectId)) return;
      // A rejection is an answer (the desktop said no) and is not retried. A
      // timeout or a transport failure is retried ONCE, after a beat and
      // through the queue so a mass timeout on the cold-start fan-out cannot
      // become a second uncapped storm, exactly as subscribeStream does.
      // Beyond that the recoveries are the existing ones: established,
      // refreshBoard, a desired-set change, or the Board tab re-focusing,
      // which re-issues an upgrade that has not landed.
      const rejected = error instanceof CapabilityError;
      const willRetry = !rejected && !options.isRetry && !this.boardRetryTimers.has(projectId);
      traceConnection('board-subscribe', {
        outcome: rejected ? 'rejected' : 'failed',
        view,
        ms: Date.now() - issuedAt,
        retry: willRetry,
      });
      if (!willRetry) return;
      this.boardRetryTimers.set(
        projectId,
        setTimeout(() => {
          this.boardRetryTimers.delete(projectId);
          if (this.session.isEstablished && this.desiredBoardIds.has(projectId)) this.enqueueBoardSubscribe(projectId, true);
        }, BOARD_RETRY_DELAY_MS),
      );
    }
  }

  private async subscribeDiff(taskId: string, desired: DesiredDiff): Promise<void> {
    try {
      const fileList = await this.verbs.readDiffFileList({ taskId, projectId: desired.projectId, scope: desired.scope });
      if (this.disposed || this.desiredDiffsByTaskId.get(taskId) !== desired) return;
      this.activeDiffTaskIds.add(taskId);
      this.sinks.onDiffFileList(taskId, fileList);
    } catch {
      // Screen-driven, and the Changes tab can re-trigger via setDesiredDiff -
      // but it can only show the failure if it is TOLD about it. Swallowing
      // here left `fileListStatus` on 'loading' forever, so a refused or
      // timed-out diff rendered as a skeleton that never resolved, and
      // DiffFetchStatus's 'error' member had no writer at all.
      //
      // Same staleness guard as the success path: a watch that has since been
      // dropped or re-scoped must not write over the current one's state.
      if (this.disposed || this.desiredDiffsByTaskId.get(taskId) !== desired) return;
      this.sinks.onDiffFetchFailed(taskId, desired.scope);
    }
  }

  private dropStream(sessionId: string): void {
    const retryTimer = this.streamRetryTimers.get(sessionId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.streamRetryTimers.delete(sessionId);
    }
    // terminalStreamIds is NOT cleared here: it is screen-owned state, set by
    // openSessionScreen and cleared by closeSessionScreen. A stream can drop
    // out of the desired set while its screen stays mounted (the task gets
    // archived desktop-side, say), and clearing the flag would bring the
    // session back list-only, leaving a mounted terminal permanently frozen.
    //
    // Nothing leaks: closeSessionScreen is the CLEANUP of SessionScreen's
    // mount effect, so it runs on every unmount path, not just the back
    // button - and a process death takes this manager with it.
    if (!this.activeStreamIds.has(sessionId)) return;
    this.activeStreamIds.delete(sessionId);
    if (this.session.isEstablished) void this.verbs.readStreamUnsubscribe(sessionId).catch(() => undefined);
  }

  private dropBoard(projectId: string): void {
    const refreshTimer = this.boardRefreshTimers.get(projectId);
    if (refreshTimer) {
      clearTimeout(refreshTimer);
      this.boardRefreshTimers.delete(projectId);
    }
    const retryTimer = this.boardRetryTimers.get(projectId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.boardRetryTimers.delete(projectId);
    }
    // The project left the desired set entirely; a later re-add starts back at
    // the feed projection and the Board tab upgrades it again if opened. Both
    // maps go, or a stale 'full' active would make that upgrade a no-op.
    this.boardViewByProjectId.delete(projectId);
    this.activeBoardViewByProjectId.delete(projectId);
    if (!this.activeBoardIds.has(projectId)) return;
    this.activeBoardIds.delete(projectId);
    if (this.session.isEstablished) void this.verbs.readBoardUnsubscribe(projectId).catch(() => undefined);
  }

  private dropDiff(taskId: string, projectId: string): void {
    this.activeDiffTaskIds.delete(taskId);
    if (this.session.isEstablished) {
      void this.verbs.readDiffUnsubscribe({ taskId, projectId }).catch(() => undefined);
    }
  }
}
