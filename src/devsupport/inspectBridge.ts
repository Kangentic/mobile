import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import { useDiffStore } from '@/state/diffStore';
import { usePairingStore } from '@/state/pairingStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { getTerminalFeedStats } from '@/state/terminalFeed';
import {
  decodeInspectRequest,
  encodeInspectHello,
  encodeInspectResponse,
  INSPECT_PORT,
  type InspectRequestKind,
} from './inspectProtocol';
import { getInspectRoute, getInspectSubscriptions } from './inspectState';

/**
 * The dev-only in-app half of the mobile inspect loop: dials OUT to the
 * local inspect server (scripts/mobileInspect.mjs) on 127.0.0.1:8791 via
 * `adb reverse`, and answers state-dump requests with STORE SUMMARIES
 * (counts and status fields, never full transcript/diff payloads).
 *
 * Ships in no production build, three ways: the boot call site is gated on
 * __DEV__ plus EXPO_PUBLIC_KANGENTIC_INSPECT === '1', the module loads only
 * through a dynamic import behind that gate (Metro strips it), and the
 * endpoint is hard-coded loopback (unreachable except through adb).
 */

const RETRY_DELAY_MS = 5000;

/** Exported for the unit tests; the bridge below is its only app consumer. */
export function buildInspectPayload(kind: InspectRequestKind): unknown {
  switch (kind) {
    case 'connection': {
      const channel = useChannelStore.getState();
      return {
        transportState: channel.transportState,
        established: channel.established,
        rekeyCount: channel.rekeyCount,
        relayUrl: channel.relayUrl,
        pairedState: channel.pairedState,
      };
    }
    // The pairing ceremony runs on its OWN transport, so `connection` reports
    // 'idle' throughout it and says nothing about why a ceremony failed. This
    // is the only window into which leg stalled: 'connecting' means the relay
    // socket, 'handshaking' means message 2 never came back from the desktop,
    // and 'awaiting-sas' means the crypto finished and only the taps are left.
    case 'pairing': {
      const machineState = usePairingStore.getState().machineState;
      if (!machineState) return { status: null };
      return {
        status: machineState.status,
        // Never the SAS itself, nor the token: presence is what diagnoses,
        // and both screens already show the digits to the person comparing.
        hasSas: machineState.status === 'awaiting-sas',
        errorKind: 'kind' in machineState ? machineState.kind : null,
        errorMessage: 'message' in machineState ? machineState.message : null,
      };
    }
    case 'stores': {
      const boards = useBoardStore.getState();
      const activity = useActivityStore.getState();
      const transcripts = useTranscriptStore.getState();
      const diffs = useDiffStore.getState();
      return {
        board: {
          projects: boards.projects.map((project) => project.id),
          pendingMoves: boards.pendingMoves.length,
          tasksByProject: Object.fromEntries(
            Object.entries(boards.boardsByProjectId).map(([projectId, board]) => [
              projectId,
              { columns: board.columns.length, tasks: Object.keys(board.tasksById).length },
            ]),
          ),
        },
        activity: Object.values(activity.bySessionId).map((entry) => ({
          sessionId: entry.sessionId,
          taskId: entry.taskId,
          state: entry.state,
          feedStatus: entry.feedStatus,
          awaitedPromptId: entry.awaitedPromptId,
          unreadCount: entry.unreadCount,
        })),
        transcript: Object.entries(transcripts.bySessionId).map(([sessionId, window]) => ({
          sessionId,
          startIndex: window.startIndex,
          entries: window.entries.length,
          totalEntries: window.totalEntries,
          revision: window.revision,
          needsTailFetch: window.needsTailFetch,
        })),
        diff: Object.entries(diffs.byTaskId).map(([taskId, taskDiff]) => ({
          taskId,
          scope: taskDiff.scope,
          files: taskDiff.fileList?.files.length ?? 0,
          status: taskDiff.fileListStatus,
          stale: taskDiff.stale,
        })),
      };
    }
    case 'subscriptions': {
      const subscriptions = getInspectSubscriptions();
      if (!subscriptions) throw new Error('No active connection (SubscriptionManager not registered)');
      return subscriptions.debugSnapshot();
    }
    case 'feed-stats':
      return getTerminalFeedStats();
    case 'route': {
      const route = getInspectRoute();
      if (!route) throw new Error('Route probe not mounted (is the app UI up?)');
      return route;
    }
  }
}

export function startInspectBridge(): () => void {
  let stopped = false;
  let socket: WebSocket | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRetry(): void {
    if (stopped || retryTimer !== null) return;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      connect();
    }, RETRY_DELAY_MS);
  }

  function connect(): void {
    if (stopped) return;
    const nextSocket = new WebSocket(`ws://127.0.0.1:${INSPECT_PORT}`);
    socket = nextSocket;
    nextSocket.onopen = () => {
      nextSocket.send(encodeInspectHello());
    };
    nextSocket.onmessage = (event: { data: unknown }) => {
      const request = decodeInspectRequest(event.data);
      if (request === null) return;
      try {
        const payload = buildInspectPayload(request.kind);
        nextSocket.send(encodeInspectResponse({ type: 'response', id: request.id, ok: true, payload }));
      } catch (error) {
        const message = error instanceof Error ? error.message : 'inspect request failed';
        nextSocket.send(encodeInspectResponse({ type: 'response', id: request.id, ok: false, error: message }));
      }
    };
    nextSocket.onerror = () => {
      // onclose follows; the retry is scheduled there.
    };
    nextSocket.onclose = () => {
      if (socket === nextSocket) socket = null;
      scheduleRetry();
    };
  }

  connect();

  return () => {
    stopped = true;
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    socket?.close();
    socket = null;
  };
}
