import { beforeEach, describe, expect, it } from 'vitest';
import type { SubscriptionManager } from '../../src/channel/subscriptionManager';
import { buildInspectPayload } from '../../src/devsupport/inspectBridge';
import { setInspectRoute, setInspectSubscriptions } from '../../src/devsupport/inspectState';
import { useActivityStore } from '../../src/state/activityStore';
import { useBoardStore } from '../../src/state/boardStore';
import { useChannelStore } from '../../src/state/channelStore';
import { useDiffStore } from '../../src/state/diffStore';
import { appendChunk, resetTerminalFeed, retainTerminal } from '../../src/state/terminalFeed';
import { useTranscriptStore } from '../../src/state/transcriptStore';

describe('buildInspectPayload', () => {
  beforeEach(() => {
    useChannelStore.getState().reset();
    useBoardStore.getState().reset();
    useActivityStore.getState().reset();
    useTranscriptStore.getState().reset();
    useDiffStore.getState().reset();
    resetTerminalFeed();
    setInspectRoute(null);
    setInspectSubscriptions(null);
  });

  it('summarizes the connection state', () => {
    useChannelStore.getState().setPairedState('paired');
    useChannelStore.getState().setTransportState('connected');
    useChannelStore.getState().markEstablished();
    expect(buildInspectPayload('connection')).toEqual({
      transportState: 'connected',
      established: true,
      rekeyCount: 0,
      relayUrl: null,
      pairedState: 'paired',
    });
  });

  it('summarizes stores as counts and statuses, never full payloads', () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    const payload = buildInspectPayload('stores') as {
      activity: { sessionId: string; feedStatus: string }[];
      transcript: unknown[];
      board: { projects: string[] };
      diff: unknown[];
    };
    expect(payload.activity).toEqual([
      expect.objectContaining({ sessionId: 'sess-1', taskId: 'task-1', feedStatus: 'pending' }),
    ]);
    expect(payload.transcript).toEqual([]);
    expect(payload.board.projects).toEqual([]);
    expect(payload.diff).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain('entries":');
  });

  it('reports terminal feed ring stats', () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'hello world');
    expect(buildInspectPayload('feed-stats')).toEqual([
      { sessionId: 'sess-1', chunks: 1, totalBytes: 11, dims: null, listeners: 0 },
    ]);
  });

  it('answers subscriptions from the registered manager and errors without one', () => {
    expect(() => buildInspectPayload('subscriptions')).toThrow(/No active connection/);
    const snapshot = {
      desiredStreams: ['sess-1'],
      activeStreams: [],
      desiredBoards: ['project-1'],
      activeBoards: ['project-1'],
      desiredDiffTaskIds: [],
      activeDiffTaskIds: [],
    };
    setInspectSubscriptions({ debugSnapshot: () => snapshot } as unknown as SubscriptionManager);
    expect(buildInspectPayload('subscriptions')).toEqual(snapshot);
  });

  it('answers the route from the probe registry and errors without one', () => {
    expect(() => buildInspectPayload('route')).toThrow(/Route probe/);
    setInspectRoute({ pathname: '/task/task-1', params: { taskId: 'task-1' } });
    expect(buildInspectPayload('route')).toEqual({ pathname: '/task/task-1', params: { taskId: 'task-1' } });
  });
});
