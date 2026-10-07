import { beforeEach, describe, expect, it } from 'vitest';
import type { SubscriptionManager } from '../../src/channel/subscriptionManager';
import { buildInspectPayload } from '../../src/devsupport/inspectBridge';
import type { InspectRequestKind } from '../../src/devsupport/inspectProtocol';
import { boardSnapshotFixture, boardTaskFixture, streamSnapshotFixture } from '../../src/devsupport/desktopFixtures';
import { setInspectRoute, setInspectSubscriptions, setInspectTerminal } from '../../src/devsupport/inspectState';
import { useActivityStore } from '../../src/state/activityStore';
import { useBoardStore } from '../../src/state/boardStore';
import { useChannelStore } from '../../src/state/channelStore';
import { useDiffStore } from '../../src/state/diffStore';
import { appendChunk, resetTerminalFeed, retainTerminal, seedScrollback, subscribeChunks } from '../../src/state/terminalFeed';
import { useTranscriptStore } from '../../src/state/transcriptStore';

function payloadFor(kind: InspectRequestKind, argument?: string): Promise<unknown> {
  return buildInspectPayload({ kind, argument });
}

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
    setInspectTerminal(null);
  });

  it('summarizes the connection state', async () => {
    useChannelStore.getState().setPairedState('paired');
    useChannelStore.getState().setTransportState('connected');
    useChannelStore.getState().markEstablished();
    await expect(payloadFor('connection')).resolves.toEqual({
      transportState: 'connected',
      established: true,
      rekeyCount: 0,
      relayUrl: null,
      pairedState: 'paired',
    });
  });

  it('summarizes stores as counts and statuses, never full payloads', async () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    const payload = (await payloadFor('stores')) as {
      activity: { sessionId: string; feedStatus: string }[];
      transcript: unknown[];
      board: { projects: string[] };
      diff: unknown[];
    };
    expect(payload.activity).toEqual([
      // sessionStatus sits next to feedStatus deliberately and is NOT the same
      // fact: null here is "no snapshot has landed yet", which is exactly the
      // state a registered-but-unsnapshotted session is in.
      expect.objectContaining({ sessionId: 'sess-1', taskId: 'task-1', feedStatus: 'pending', sessionStatus: null }),
    ]);
    expect(payload.transcript).toEqual([]);
    expect(payload.board.projects).toEqual([]);
    expect(payload.diff).toEqual([]);
    expect(JSON.stringify(payload)).not.toContain('entries":');
  });

  /**
   * The null case above is not enough on its own: a registered-but-unsnapshotted
   * entry's sessionStatus is null BY CONSTRUCTION (emptyEntry), so a hardcoded
   * `sessionStatus: null` in buildInspectPayload's mapper would satisfy that test
   * without ever reading `entry.sessionStatus`. This snapshots a session to a
   * live, non-null status first, so the assertion can only pass if the mapper
   * actually forwards the field.
   */
  it('echoes a live entry\'s sessionStatus, not a hardcoded null', async () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore
      .getState()
      .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'suspended' }));

    const payload = (await payloadFor('stores')) as {
      activity: { sessionId: string; sessionStatus: string | null }[];
    };
    expect(payload.activity).toEqual([expect.objectContaining({ sessionId: 'sess-1', sessionStatus: 'suspended' })]);
  });

  /**
   * Protocol 0.16.0's lifecycle fields, as the inspect loop reports them. Every
   * value is chosen to differ from what a hardcoded mapper would write: a fresh
   * entry's `resuming` and `resumable` are both false by construction, so a
   * false-valued assertion would pass against a mapper that never read them
   * (the same trap the sessionStatus test above spells out).
   */
  it('reports the 0.16.0 and 0.17.0 lifecycle: the entry\'s resuming and resumable, the in-flight board rows, the pending successors', async () => {
    useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
    useActivityStore
      .getState()
      .applySnapshot('sess-1', 'task-1', 'project-1', streamSnapshotFixture({ sessionStatus: 'suspended', resuming: true, resumable: true }));
    // A session the phone holds no entry for still names its successor.
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-ended',
      taskId: 'task-2',
      payload: { type: 'session-ended', intentional: true, successorSessionId: 'sess-next' },
    });
    useBoardStore.getState().applyBoardSnapshot(
      boardSnapshotFixture({
        projectId: 'project-1',
        view: 'sessions',
        tasks: [
          // The board fields can be absent (an older desktop's row): reported as null, never undefined.
          boardTaskFixture({
            id: 'task-labelled',
            session_id: null,
            spawn_progress: 'Creating worktree...',
            resumable: undefined,
            paused: undefined,
          }),
          boardTaskFixture({ id: 'task-paused', session_id: null, resumable: true, paused: true }),
          // Paused with no Resume on offer (0.17.0, a task sitting in Done): listed on `paused` alone.
          boardTaskFixture({ id: 'task-done-paused', session_id: null, resumable: false, paused: true }),
          // A task that still names its session reports that session.
          boardTaskFixture({ id: 'task-parked', session_id: 'sess-parked', resumable: true, paused: true }),
          // Nothing in flight and nothing to resume: not listed, and neither is a blank label.
          boardTaskFixture({ id: 'task-blank-label', session_id: null, spawn_progress: '   ' }),
          boardTaskFixture({ id: 'task-plain', session_id: null }),
        ],
      }),
    );

    const payload = (await payloadFor('stores')) as {
      activity: { sessionId: string; resuming: boolean; resumable: boolean }[];
      board: { inFlightTasks: { taskId: string }[] };
      pendingSuccessors: unknown[];
    };

    expect(payload.activity).toEqual([expect.objectContaining({ sessionId: 'sess-1', resuming: true, resumable: true })]);
    expect([...payload.board.inFlightTasks].sort((first, second) => first.taskId.localeCompare(second.taskId))).toEqual([
      { taskId: 'task-done-paused', sessionId: null, spawnProgress: null, resumable: false, paused: true },
      { taskId: 'task-labelled', sessionId: null, spawnProgress: 'Creating worktree...', resumable: null, paused: null },
      { taskId: 'task-parked', sessionId: 'sess-parked', spawnProgress: null, resumable: true, paused: true },
      { taskId: 'task-paused', sessionId: null, spawnProgress: null, resumable: true, paused: true },
    ]);
    expect(payload.pendingSuccessors).toEqual([{ taskId: 'task-2', sessionId: 'sess-next', endedSessionId: 'sess-ended' }]);
  });

  it('reports terminal feed ring stats, and listeners with no ring behind them', async () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'hello world');
    // A pane that has rebound to a successor the screen has not retained yet:
    // normal for a moment mid-swap, a leaked subscription if it persists.
    subscribeChunks('sess-successor', () => undefined);
    // `seeded` is what the terminal pane's hold rule reads: a ring built from
    // chunks alone is replaced the moment the seed lands, so a ring reporting
    // chunks with seeded=false is a pane waiting on its scrollback.
    // `retainCount` is how many mounted screens hold the ring: one that stays
    // above zero with no screen on top is a leaked retention, which keeps the
    // desktop streaming PTY bytes nobody reads.
    await expect(payloadFor('feed-stats')).resolves.toEqual({
      rings: [{ sessionId: 'sess-1', chunks: 1, totalBytes: 11, dims: null, seeded: false, listeners: 0, retainCount: 1 }],
      unbufferedListeners: ['sess-successor'],
    });

    seedScrollback('sess-1', 'seeded scrollback');
    await expect(payloadFor('feed-stats')).resolves.toMatchObject({
      rings: [expect.objectContaining({ sessionId: 'sess-1', seeded: true })],
    });
  });

  it('answers subscriptions from the registered manager and errors without one', async () => {
    await expect(payloadFor('subscriptions')).rejects.toThrow(/No active connection/);
    const snapshot = {
      desiredStreams: ['sess-1'],
      activeStreams: [],
      desiredBoards: ['project-1'],
      activeBoards: ['project-1'],
      desiredDiffTaskIds: [],
      activeDiffTaskIds: [],
    };
    setInspectSubscriptions({ debugSnapshot: () => snapshot } as unknown as SubscriptionManager);
    await expect(payloadFor('subscriptions')).resolves.toEqual(snapshot);
  });

  it('answers the route from the probe registry and errors without one', async () => {
    await expect(payloadFor('route')).rejects.toThrow(/Route probe/);
    setInspectRoute({ pathname: '/task/task-1', params: { taskId: 'task-1' } });
    await expect(payloadFor('route')).resolves.toEqual({ pathname: '/task/task-1', params: { taskId: 'task-1' } });
  });

  describe('terminal', () => {
    const probeState = { buildId: 'abc123', gridHeightPx: 640, rows: 48 };
    const writeStats = { attempts: 7, failures: 2, lastError: 'not connected', lastAttemptAt: 1000 };

    function registerTerminal(expectedBuildId: string): string[] {
      const seenExpressions: string[] = [];
      setInspectTerminal({
        sessionId: 'sess-1',
        expectedBuildId,
        evaluate: (expression: string) => {
          seenExpressions.push(expression);
          return Promise.resolve(probeState);
        },
        writeStats: () => ({ ...writeStats }),
      });
      return seenExpressions;
    }

    it('errors when no terminal pane is mounted', async () => {
      await expect(payloadFor('terminal')).rejects.toThrow(/No terminal pane mounted/);
      await expect(payloadFor('terminal-eval', '1 + 1')).rejects.toThrow(/No terminal pane mounted/);
    });

    it('joins the page probe with the write outcomes RN owns', async () => {
      const seenExpressions = registerTerminal('abc123');
      const payload = await payloadFor('terminal');
      expect(seenExpressions).toEqual(['window.__kangenticTerminal.probe()']);
      expect(payload).toEqual({
        sessionId: 'sess-1',
        expectedBuildId: 'abc123',
        loadedBuildId: 'abc123',
        buildIdMatches: true,
        writes: writeStats,
        page: probeState,
      });
    });

    it('flags a stale page when the loaded build id is not the expected one', async () => {
      registerTerminal('def456');
      const payload = (await payloadFor('terminal')) as { buildIdMatches: boolean; loadedBuildId: unknown };
      expect(payload.buildIdMatches).toBe(false);
      expect(payload.loadedBuildId).toBe('abc123');
    });

    it('passes an eval expression through untouched and rejects an empty one', async () => {
      const seenExpressions = registerTerminal('abc123');
      await expect(payloadFor('terminal-eval', 'window.innerHeight')).resolves.toEqual(probeState);
      expect(seenExpressions).toEqual(['window.innerHeight']);
      await expect(payloadFor('terminal-eval')).rejects.toThrow(/needs an expression/);
    });
  });
});
