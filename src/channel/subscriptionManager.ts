import type {
  DiffFileListWire,
  ReadBoardSnapshotResponsePayload,
  ReadBoardView,
  ReadDiffScope,
  ReadStreamResponsePayload,
  Unsubscribe,
} from '@kangentic/protocol';
import type { SessionManager } from './sessionManager';
import { CapabilityError, type VerbClient } from './verbClient';

const BOARD_REFRESH_DEBOUNCE_MS = 300;
const DIFF_REFRESH_DEBOUNCE_MS = 500;
const STREAM_RETRY_DELAY_MS = 2000;

export interface SubscriptionSnapshotSinks {
  onStreamSnapshot(sessionId: string, snapshot: ReadStreamResponsePayload): void;
  /** A stream subscribe the desktop rejected (e.g. "No such session") - the id is pruned from the desired set before this fires. */
  onStreamRejected(sessionId: string, error: CapabilityError): void;
  onBoardSnapshot(snapshot: ReadBoardSnapshotResponsePayload): void;
  onDiffFileList(taskId: string, fileList: DiffFileListWire): void;
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
  /** What each active subscription was actually opened with, so a mode change re-subscribes. */
  private readonly activeStreamWantsTerminal = new Map<string, boolean>();
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
  private readonly activeDiffTaskIds = new Set<string>();

  private readonly boardRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly diffRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly streamRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(options: SubscriptionManagerOptions) {
    this.session = options.session;
    this.verbs = options.verbs;
    this.sinks = options.sinks;
    this.unsubscribeEstablished = this.session.onEstablished(() => this.onEstablished());
  }

  setDesiredStreams(sessionIds: ReadonlySet<string>): void {
    const previousDesired = this.desiredStreamIds;
    this.desiredStreamIds = new Set(sessionIds);

    for (const sessionId of previousDesired) {
      if (!this.desiredStreamIds.has(sessionId)) this.dropStream(sessionId);
    }
    if (!this.session.isEstablished) return;
    for (const sessionId of this.desiredStreamIds) {
      if (!this.activeStreamIds.has(sessionId) && !this.streamRetryTimers.has(sessionId)) {
        void this.subscribeStream(sessionId);
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
      if (!this.activeBoardIds.has(projectId)) void this.subscribeBoard(projectId);
    }
  }

  /**
   * Upgrade one project's board to the full projection - the Board tab, which
   * renders every column and every card, not just the ones with an agent on
   * them. Idempotent, and never reversed (see boardViewByProjectId).
   */
  setBoardWantsFull(projectId: string): void {
    if (this.boardViewByProjectId.get(projectId) === 'full') return;
    this.boardViewByProjectId.set(projectId, 'full');
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
        if (this.session.isEstablished && this.desiredBoardIds.has(projectId)) void this.subscribeBoard(projectId);
      }, BOARD_REFRESH_DEBOUNCE_MS),
    );
  }

  /**
   * Declare whether this session's subscription needs live PTY bytes. A
   * session screen turns it on when it opens and off when it closes; the feed
   * never turns it on. Flipping it re-subscribes, which is also what fetches
   * the fresh scrollback a newly-opened terminal needs to seed itself.
   */
  setStreamWantsTerminal(sessionId: string, wantsTerminal: boolean): void {
    const previous = this.terminalStreamIds.has(sessionId);
    if (previous === wantsTerminal) return;
    if (wantsTerminal) this.terminalStreamIds.add(sessionId);
    else this.terminalStreamIds.delete(sessionId);
    if (!this.desiredStreamIds.has(sessionId) || !this.session.isEstablished) return;
    void this.subscribeStream(sessionId);
  }

  /** Immediate re-subscribe for one stream - the fresh-scrollback path when a session screen opens. */
  refreshStream(sessionId: string): void {
    if (!this.desiredStreamIds.has(sessionId) || !this.session.isEstablished) return;
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
    this.unsubscribeEstablished();
    for (const timer of this.boardRefreshTimers.values()) clearTimeout(timer);
    this.boardRefreshTimers.clear();
    for (const timer of this.diffRefreshTimers.values()) clearTimeout(timer);
    this.diffRefreshTimers.clear();
    for (const timer of this.streamRetryTimers.values()) clearTimeout(timer);
    this.streamRetryTimers.clear();
  }

  private onEstablished(): void {
    // The previous connection's actives are meaningless on a fresh
    // handshake (the desktop tore its registry down on disconnect).
    this.activeStreamIds.clear();
    this.activeBoardIds.clear();
    this.activeDiffTaskIds.clear();
    for (const projectId of this.desiredBoardIds) void this.subscribeBoard(projectId);
    for (const sessionId of this.desiredStreamIds) void this.subscribeStream(sessionId);
    for (const [taskId, desired] of this.desiredDiffsByTaskId) void this.subscribeDiff(taskId, desired);
  }

  private async subscribeStream(sessionId: string, isRetry = false): Promise<void> {
    const wantsTerminal = this.terminalStreamIds.has(sessionId);
    try {
      const snapshot = await this.verbs.readStreamSubscribe(sessionId, { terminal: wantsTerminal });
      if (this.disposed || !this.desiredStreamIds.has(sessionId)) return;
      this.activeStreamIds.add(sessionId);
      this.activeStreamWantsTerminal.set(sessionId, wantsTerminal);
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
            if (this.session.isEstablished && this.desiredStreamIds.has(sessionId)) void this.subscribeStream(sessionId, true);
          }, STREAM_RETRY_DELAY_MS),
        );
      }
    }
  }

  private async subscribeBoard(projectId: string): Promise<void> {
    try {
      const snapshot = await this.verbs.readBoardSubscribe(projectId, {
        view: this.boardViewByProjectId.get(projectId) ?? 'sessions',
      });
      if (this.disposed || !this.desiredBoardIds.has(projectId)) return;
      this.activeBoardIds.add(projectId);
      this.sinks.onBoardSnapshot(snapshot);
    } catch {
      // Board subscribe failures are recovered by the next reconcile
      // (established, refreshBoard, or a desired-set change).
    }
  }

  private async subscribeDiff(taskId: string, desired: DesiredDiff): Promise<void> {
    try {
      const fileList = await this.verbs.readDiffFileList({ taskId, projectId: desired.projectId, scope: desired.scope });
      if (this.disposed || this.desiredDiffsByTaskId.get(taskId) !== desired) return;
      this.activeDiffTaskIds.add(taskId);
      this.sinks.onDiffFileList(taskId, fileList);
    } catch {
      // Screen-driven; the Changes tab surfaces its own loading/error state
      // and can re-trigger via setDesiredDiff.
    }
  }

  private dropStream(sessionId: string): void {
    const retryTimer = this.streamRetryTimers.get(sessionId);
    if (retryTimer) {
      clearTimeout(retryTimer);
      this.streamRetryTimers.delete(sessionId);
    }
    this.terminalStreamIds.delete(sessionId);
    this.activeStreamWantsTerminal.delete(sessionId);
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
    // The project left the desired set entirely; a later re-add starts back at
    // the feed projection and the Board tab upgrades it again if opened.
    this.boardViewByProjectId.delete(projectId);
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
