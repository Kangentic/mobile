import type { Unsubscribe } from '@kangentic/protocol';
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

export function bindFeedToStores(feed: FeedRouter, subscriptions: SubscriptionManager): Unsubscribe {
  const unsubscribers: Unsubscribe[] = [
    feed.on('transcript', (event) => {
      useTranscriptStore.getState().applyTranscript(event);
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
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}
