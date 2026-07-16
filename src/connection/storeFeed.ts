import type { TranscriptEvent, Unsubscribe } from '@kangentic/protocol';
import type { FeedRouter, SubscriptionManager, SubscriptionSnapshotSinks } from '@/channel';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore, selectLiveSessionIds } from '@/state/boardStore';
import { useDiffStore } from '@/state/diffStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { appendChunk, isTerminalRetained, seedScrollback, setTerminalDimensions } from '@/state/terminalFeed';

/**
 * The single place feed events and subscription snapshots meet store
 * actions - pure mapping, no policy. Reconciliation policy (which streams
 * to want, when to refresh) lives in SubscriptionManager + the board-diff
 * logic below; screens read stores and call actions.ts.
 */

function sessionOwnerFor(sessionId: string): { taskId: string; projectId: string } | null {
  const boardState = useBoardStore.getState();
  for (const [projectId, board] of Object.entries(boardState.boardsByProjectId)) {
    for (const task of Object.values(board.tasksById)) {
      if (task.session_id === sessionId) return { taskId: task.id, projectId };
    }
  }
  return null;
}

/**
 * After each board snapshot: register every live session with its owning
 * task (the triage card needs taskId/projectId), drop activity entries for
 * sessions no board claims anymore, and re-declare the desired stream set.
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
  for (const sessionId of Object.keys(useActivityStore.getState().bySessionId)) {
    if (!liveSessionIds.has(sessionId)) useActivityStore.getState().removeSession(sessionId);
  }

  subscriptions.setDesiredStreams(liveSessionIds);
}

export function createSnapshotSinks(getSubscriptions: () => SubscriptionManager): SubscriptionSnapshotSinks {
  return {
    onStreamSnapshot: (sessionId, snapshot) => {
      const owner = sessionOwnerFor(sessionId);
      useActivityStore.getState().applySnapshot(sessionId, owner?.taskId ?? '', owner?.projectId ?? '', snapshot);
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
      useBoardStore.getState().applyBoardSnapshot(snapshot);
      reconcileSessionsFromBoards(getSubscriptions());
    },
    onDiffFileList: (taskId, fileList) => {
      const scope = useDiffStore.getState().byTaskId[taskId]?.scope ?? 'working';
      useDiffStore.getState().applyFileList(taskId, scope, fileList);
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

export function bindFeedToStores(feed: FeedRouter, subscriptions: SubscriptionManager): Unsubscribe {
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
      setTerminalDimensions(event.sessionId, event.payload);
    }),
    feed.on('activity', (event) => {
      useActivityStore.getState().applyActivityEvent(event);
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
    if (transcriptFlushTimer !== null) {
      clearTimeout(transcriptFlushTimer);
      transcriptFlushTimer = null;
    }
    flushTranscriptEvents();
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
