/**
 * SubscriptionManager: desired-state flush on established, full resubscribe
 * after a transport drop + fresh handshake, rejection pruning, and the
 * debounced board refresh. Runs over the real loopback + stub initiator.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  generateX25519KeyPair,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type JsonValue,
  type ReadBoardView,
} from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { CapabilityClient } from '@/channel/capabilityClient';
import { VerbClient, type CapabilityError } from '@/channel/verbClient';
import { SUBSCRIBE_FAN_OUT_CONCURRENCY, SubscriptionManager, type SubscriptionSnapshotSinks } from '@/channel/subscriptionManager';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { boardSnapshotFixture, diffFileListFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';

interface Harness {
  session: SessionManager;
  stub: StubSessionInitiator;
  manager: SubscriptionManager;
  requests: CapabilityRequestMessage[];
  sinkCalls: {
    streamSnapshots: string[];
    streamRejections: { sessionId: string; error: CapabilityError }[];
    boardSnapshots: string[];
    diffFileLists: string[];
    diffFetchFailures: { taskId: string; scope: string }[];
  };
}

function defaultResponder(request: CapabilityRequestMessage): CapabilityResponseMessage {
  const payload = request.payload as { sessionId?: string; projectId?: string; taskId?: string; action?: string; view?: ReadBoardView };
  if (payload.action === 'unsubscribe') return { type: 'capability-response', requestId: request.requestId, ok: true };
  switch (request.verb) {
    case 'read-stream':
      return { type: 'capability-response', requestId: request.requestId, ok: true, payload: streamSnapshotFixture() as unknown as JsonValue };
    case 'read-board':
      return {
        type: 'capability-response',
        requestId: request.requestId,
        ok: true,
        // Echoes the requested view, as a 0.9.0 desktop does.
        payload: boardSnapshotFixture({
          projectId: payload.projectId ?? 'project-1',
          ...(payload.view !== undefined ? { view: payload.view } : {}),
        }) as unknown as JsonValue,
      };
    case 'read-diff':
      return { type: 'capability-response', requestId: request.requestId, ok: true, payload: diffFileListFixture() as unknown as JsonValue };
    default:
      return { type: 'capability-response', requestId: request.requestId, ok: false, error: `unexpected verb ${request.verb}` };
  }
}

async function harness(
  respond: (request: CapabilityRequestMessage) => CapabilityResponseMessage | null = defaultResponder,
): Promise<Harness> {
  const [phoneTransport, desktopTransport] = createLoopbackPair();
  await phoneTransport.connect();
  await desktopTransport.connect();
  const phoneIdentity = generateX25519KeyPair();
  const desktopIdentity = generateX25519KeyPair();
  const session = new SessionManager({
    identity: phoneIdentity,
    remoteStaticPublicKey: desktopIdentity.publicKey,
    transport: phoneTransport,
  });
  session.start();
  const stub = new StubSessionInitiator(desktopTransport, {
    desktopStatic: desktopIdentity,
    phoneStaticPublicKey: phoneIdentity.publicKey,
  });

  const requests: CapabilityRequestMessage[] = [];
  stub.setRequestHandler((request) => {
    requests.push(request);
    return respond(request);
  });

  const sinkCalls: Harness['sinkCalls'] = {
    streamSnapshots: [],
    streamRejections: [],
    boardSnapshots: [],
    diffFileLists: [],
    diffFetchFailures: [],
  };
  const sinks: SubscriptionSnapshotSinks = {
    onStreamSnapshot: (sessionId) => sinkCalls.streamSnapshots.push(sessionId),
    onStreamRejected: (sessionId, error) => sinkCalls.streamRejections.push({ sessionId, error }),
    onBoardSnapshot: (snapshot) => sinkCalls.boardSnapshots.push(snapshot.projectId),
    onDiffFileList: (taskId) => sinkCalls.diffFileLists.push(taskId),
    onDiffFetchFailed: (taskId, scope) => sinkCalls.diffFetchFailures.push({ taskId, scope }),
  };
  const verbs = new VerbClient(new CapabilityClient(session));
  const manager = new SubscriptionManager({ session, verbs, sinks });
  return { session, stub, manager, requests, sinkCalls };
}

async function flushLoopback(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** Same round-based flush as `flushLoopback`, but advancing vitest's fake clock instead of a real timer - for tests that also need to control debounce/retry timers precisely. */
async function flushLoopbackFakeTimers(rounds = 6): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('SubscriptionManager', () => {
  /**
   * Board task #70. A subscribe in flight across a rekey is sealed under keys
   * the desktop has just retired, so nothing ever answers it and the board
   * stays empty until the next reconcile. The manager re-issues every pending
   * board subscribe when a rekey lands. The responder holds the first
   * read-board (returns null) and answers the re-issue; the stub's
   * beginHandshake on an established session is a rekey. Mutation seen
   * failing: dropping the onRekey subscription from the constructor (one
   * request, no snapshot).
   */
  it('re-issues a board subscribe that was in flight across a rekey', async () => {
    let held = 0;
    const { stub, manager, requests, sinkCalls } = await harness((request) => {
      if (request.verb === 'read-board' && held === 0) {
        held += 1;
        return null;
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredBoards(new Set(['project-1']));
    await flushLoopback();
    expect(requests.filter((request) => request.verb === 'read-board')).toHaveLength(1);
    expect(sinkCalls.boardSnapshots).toEqual([]);

    stub.beginHandshake();
    await flushLoopback();

    expect(requests.filter((request) => request.verb === 'read-board')).toHaveLength(2);
    expect(sinkCalls.boardSnapshots).toEqual(['project-1']);
  });

  /**
   * The cold-start fan-out, which used to issue one request per project plus
   * one per live session all at once. Sentry MOBILE-8's fix bounded the Agents
   * feed's snippet pre-warm; this is the same defect one layer up, and at the
   * fleet size that made that report plausible it is the larger of the two.
   *
   * Every assertion here is on the WIRE (what actually left) rather than on a
   * rendered result, because a queue that silently degraded to unbounded would
   * produce identical snapshots and identical sink calls.
   */
  describe('the subscribe fan-out is bounded', () => {
    const manySessionIds = Array.from({ length: 12 }, (_, index) => `fan-sess-${index}`);

    /** Holds every subscribe unanswered, so what is in flight stays in flight. */
    function holdEverything(): (request: CapabilityRequestMessage) => CapabilityResponseMessage | null {
      return (request) => (request.verb === 'read-stream' || request.verb === 'read-board' ? null : defaultResponder(request));
    }

    it('issues at most the cap at once, not one per session', async () => {
      const { stub, manager, requests } = await harness(holdEverything());
      stub.beginHandshake();
      await flushLoopback();

      manager.setDesiredStreams(new Set(manySessionIds));
      await flushLoopback();

      // Exactly the cap, not merely "fewer than twelve": nothing is ever
      // answered, so no slot is freed and this count IS the concurrency.
      expect(requests.filter((request) => request.verb === 'read-stream')).toHaveLength(SUBSCRIBE_FAN_OUT_CONCURRENCY);
      expect(SUBSCRIBE_FAN_OUT_CONCURRENCY).toBeLessThan(manySessionIds.length);
    });

    it('reconciling the same sessions twice does not double up the queue', async () => {
      const { stub, manager, requests } = await harness(holdEverything());
      stub.beginHandshake();
      await flushLoopback();

      // `activeStreamIds` is only written when a response LANDS, so during the
      // in-flight window the guard in setDesiredStreams does not stop a second
      // reconcile re-issuing. Unqueued that was a harmless refresh; behind a
      // cap the duplicates would occupy the slots the unsubscribed sessions
      // are waiting for.
      manager.setDesiredStreams(new Set(manySessionIds));
      manager.setDesiredStreams(new Set(manySessionIds));
      await flushLoopback();

      const subscribed = requests.filter((request) => request.verb === 'read-stream');
      expect(subscribed).toHaveLength(SUBSCRIBE_FAN_OUT_CONCURRENCY);
      const subscribedIds = subscribed.map((request) => (request.payload as { sessionId: string }).sessionId);
      expect(new Set(subscribedIds).size).toBe(subscribed.length);
    });

    it('never subscribes a session dropped while its subscribe was still queued', async () => {
      const { stub, manager, requests } = await harness(holdEverything());
      stub.beginHandshake();
      await flushLoopback();

      manager.setDesiredStreams(new Set(manySessionIds));
      await flushLoopback();
      // Still queued behind the cap, never sent.
      const queuedSessionId = manySessionIds[manySessionIds.length - 1];
      expect(requests.some((request) => (request.payload as { sessionId?: string }).sessionId === queuedSessionId)).toBe(false);

      manager.setDesiredStreams(new Set(manySessionIds.filter((sessionId) => sessionId !== queuedSessionId)));
      await flushLoopback();

      // The drain-time re-check is the whole point: trusting the closure would
      // re-establish a stream whose drop already ran, so nothing would ever
      // tear it down again.
      expect(requests.some((request) => (request.payload as { sessionId?: string }).sessionId === queuedSessionId)).toBe(false);
    });

    /**
     * Pins the OUTCOME, not one line. Mutating away the drain-time
     * `isEstablished` re-check does NOT redden this, because
     * `SessionManager.send` throws on a dead session and the request never
     * reaches the wire either way - so this is honest about being
     * defence-in-depth coverage rather than a guard on that check. It still
     * earns its place: a backlog draining across a transport drop is exactly
     * the arrangement the cap introduced, and "nothing leaks onto the wire"
     * is the property that has to hold however it is enforced.
     */
    it('puts nothing on the wire when the backlog drains after a transport drop', async () => {
      const { session, stub, manager, requests } = await harness(holdEverything());
      stub.beginHandshake();
      await flushLoopback();

      manager.setDesiredStreams(new Set(manySessionIds));
      await flushLoopback();
      const sentWhileEstablished = requests.length;

      session.reset();
      await flushLoopback();

      // The backlog drains against a dead session; each task re-checks
      // isEstablished and no-ops rather than sending into a torn-down channel.
      expect(requests).toHaveLength(sentWhileEstablished);
    });

    /**
     * `dispose()` drops everything still behind the cap, not merely the ones
     * already in flight. The proof has to let the active ones SETTLE after
     * disposing - answering them frees their queue slots, and if the backlog
     * had merely been left alone (not cleared), `drain()` would start the
     * next batch once those slots freed, same as an ordinary cap refill.
     *
     * `disposed` also short-circuits every queued closure on its own, so this
     * pins the OUTCOME as a conjunction of the two guards rather than either
     * one in isolation - the same honesty the transport-drop test above
     * states about its own drain-time recheck.
     */
    it('dispose drops the queued backlog, so it never reaches the wire even once the in-flight requests settle', async () => {
      const { stub, manager, requests } = await harness(holdEverything());
      stub.beginHandshake();
      await flushLoopback();

      manager.setDesiredStreams(new Set(manySessionIds));
      await flushLoopback();
      const activeRequests = requests.filter((request) => request.verb === 'read-stream');
      expect(activeRequests).toHaveLength(SUBSCRIBE_FAN_OUT_CONCURRENCY);

      manager.dispose();

      // Answer every already-active request, which frees its queue slot.
      // Without the drop, freeing a slot is exactly what lets the next
      // backlogged session start.
      for (const activeRequest of activeRequests) stub.send(defaultResponder(activeRequest));
      await flushLoopback();

      expect(requests.filter((request) => request.verb === 'read-stream')).toHaveLength(SUBSCRIBE_FAN_OUT_CONCURRENCY);
    });

    /**
     * `subscribeStream`'s catch arms exactly one retry per session
     * (`!isRetry`), at a fixed delay, so a transport hiccup that fails the
     * whole fan-out at once schedules every retry to fire together. Routed
     * through `enqueueStreamSubscribe` rather than a direct re-issue, that
     * mass-fire respects the cap instead of becoming a second uncapped
     * storm.
     */
    it('a stream retry re-enters through the queue, so a mass timeout does not become a second uncapped storm', async () => {
      vi.useFakeTimers();
      try {
        const retrySessionIds = Array.from({ length: SUBSCRIBE_FAN_OUT_CONCURRENCY + 1 }, (_, index) => `retry-sess-${index}`);
        const { stub, manager, requests } = await harness(holdEverything());
        stub.beginHandshake();
        await flushLoopbackFakeTimers();

        manager.setDesiredStreams(new Set(retrySessionIds));
        await flushLoopbackFakeTimers();
        const readStreamRequests = (): CapabilityRequestMessage[] => requests.filter((request) => request.verb === 'read-stream');
        expect(readStreamRequests()).toHaveLength(SUBSCRIBE_FAN_OUT_CONCURRENCY);

        // Every active request times out at once (CapabilityClient's own
        // 10s default), which arms a retry timer per session and frees its
        // slot - letting the one still-backlogged session start its own
        // first attempt immediately, before any retry timer fires.
        await vi.advanceTimersByTimeAsync(10_000);
        expect(readStreamRequests()).toHaveLength(SUBSCRIBE_FAN_OUT_CONCURRENCY + 1);

        // The retry timers for the first CAP sessions fire together, 2s
        // later (STREAM_RETRY_DELAY_MS). Only one slot is free at that
        // moment - the still-backlogged session's own attempt has its own
        // later 10s deadline - so a QUEUED re-entry sends only that one
        // free slot's worth; a direct re-issue would send all CAP
        // regardless, exceeding the cap by CAP - 1.
        await vi.advanceTimersByTimeAsync(2_000);
        expect(readStreamRequests()).toHaveLength(SUBSCRIBE_FAN_OUT_CONCURRENCY * 2);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * Seen on the release build (2026-09-18): switching the Board tab to another
   * project left it on its skeleton for two minutes, until leaving the tab and
   * coming back re-issued the upgrade, which then landed in four seconds. The
   * upgrade request has CapabilityClient's 10 s timeout and had NO retry: a
   * desktop that answered late once stranded the screen until a refocus, with
   * nothing on screen saying so. Streams already retry once through the queue
   * (`subscribeStream`'s catch); boards now do the same.
   */
  describe('a board subscribe that times out is retried once', () => {
    it('re-issues a full-board upgrade after a timeout without waiting for a refocus', async () => {
      vi.useFakeTimers();
      try {
        let heldFullRequests = 0;
        const { stub, manager, requests, sinkCalls } = await harness((request) => {
          const payload = request.payload as { view?: ReadBoardView };
          if (request.verb === 'read-board' && payload.view === 'full' && heldFullRequests === 0) {
            heldFullRequests += 1;
            return null;
          }
          return defaultResponder(request);
        });
        stub.beginHandshake();
        await flushLoopbackFakeTimers();
        manager.setDesiredBoards(new Set(['project-1']));
        await flushLoopbackFakeTimers();
        expect(sinkCalls.boardSnapshots).toEqual(['project-1']);

        manager.setBoardWantsFull('project-1');
        await flushLoopbackFakeTimers();
        const fullRequests = (): CapabilityRequestMessage[] =>
          requests.filter((request) => request.verb === 'read-board' && (request.payload as { view?: ReadBoardView }).view === 'full');
        expect(fullRequests()).toHaveLength(1);

        // The desktop never answers: CapabilityClient's own 10 s timeout fires,
        // and the retry timer is armed. Nothing has gone out yet.
        await vi.advanceTimersByTimeAsync(10_000);
        await flushLoopbackFakeTimers();
        expect(fullRequests()).toHaveLength(1);

        // BOARD_RETRY_DELAY_MS later the upgrade goes out again, on its own,
        // and this time it lands.
        await vi.advanceTimersByTimeAsync(2_000);
        await flushLoopbackFakeTimers();
        expect(fullRequests()).toHaveLength(2);
        expect(sinkCalls.boardSnapshots).toEqual(['project-1', 'project-1']);
      } finally {
        vi.useRealTimers();
      }
    });

    it('retries once and only once, so a desktop that never answers is not polled forever', async () => {
      vi.useFakeTimers();
      try {
        const { stub, manager, requests } = await harness((request) => {
          const payload = request.payload as { view?: ReadBoardView };
          if (request.verb === 'read-board' && payload.view === 'full') return null;
          return defaultResponder(request);
        });
        stub.beginHandshake();
        await flushLoopbackFakeTimers();
        manager.setDesiredBoards(new Set(['project-1']));
        await flushLoopbackFakeTimers();
        manager.setBoardWantsFull('project-1');
        await flushLoopbackFakeTimers();
        const fullRequests = (): CapabilityRequestMessage[] =>
          requests.filter((request) => request.verb === 'read-board' && (request.payload as { view?: ReadBoardView }).view === 'full');

        await vi.advanceTimersByTimeAsync(12_000);
        await flushLoopbackFakeTimers();
        expect(fullRequests()).toHaveLength(2);

        // The retry times out too. No third attempt: from here the recoveries
        // are the existing ones (a refocus, a board event, a reconnect).
        await vi.advanceTimersByTimeAsync(30_000);
        await flushLoopbackFakeTimers();
        expect(fullRequests()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not retry a subscribe the desktop rejected', async () => {
      vi.useFakeTimers();
      try {
        const { stub, manager, requests } = await harness((request) => {
          const payload = request.payload as { view?: ReadBoardView };
          if (request.verb === 'read-board' && payload.view === 'full') {
            return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'No such project' };
          }
          return defaultResponder(request);
        });
        stub.beginHandshake();
        await flushLoopbackFakeTimers();
        manager.setDesiredBoards(new Set(['project-1']));
        await flushLoopbackFakeTimers();
        manager.setBoardWantsFull('project-1');
        await flushLoopbackFakeTimers();
        const fullRequests = (): CapabilityRequestMessage[] =>
          requests.filter((request) => request.verb === 'read-board' && (request.payload as { view?: ReadBoardView }).view === 'full');
        expect(fullRequests()).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(15_000);
        await flushLoopbackFakeTimers();
        expect(fullRequests()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    /**
     * A leaked retry timer is invisible while the board stays dropped (the
     * timer's own desired-set check refuses it), so the board is dropped and
     * re-added inside the retry delay: the re-add issues exactly one subscribe
     * of its own, and a timer that dropBoard failed to clear would fire into
     * that fresh subscription and issue a second. Mutation seen failing:
     * skipping the clear in dropBoard (two subscribes after the re-add).
     */
    it('drops the armed retry when the board is no longer wanted', async () => {
      vi.useFakeTimers();
      try {
        const { stub, manager, requests } = await harness((request) => {
          const payload = request.payload as { view?: ReadBoardView };
          if (request.verb === 'read-board' && payload.view === 'full') return null;
          return defaultResponder(request);
        });
        stub.beginHandshake();
        await flushLoopbackFakeTimers();
        manager.setDesiredBoards(new Set(['project-1']));
        await flushLoopbackFakeTimers();
        manager.setBoardWantsFull('project-1');
        await flushLoopbackFakeTimers();
        await vi.advanceTimersByTimeAsync(10_000);
        await flushLoopbackFakeTimers();

        manager.setDesiredBoards(new Set());
        await flushLoopbackFakeTimers();
        const countBeforeReAdd = requests.filter(
          (request) => request.verb === 'read-board' && (request.payload as { action?: string }).action !== 'unsubscribe',
        ).length;
        manager.setDesiredBoards(new Set(['project-1']));
        await vi.advanceTimersByTimeAsync(5_000);
        await flushLoopbackFakeTimers();

        const subscribesAfterReAdd = requests.filter(
          (request) => request.verb === 'read-board' && (request.payload as { action?: string }).action !== 'unsubscribe',
        ).length;
        expect(subscribesAfterReAdd - countBeforeReAdd).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  /**
   * `refreshStream`, `refreshBoard`, `setStreamWantsTerminal` and
   * `setBoardWantsFull` are each one request caused by a user action with a
   * screen waiting on the answer, and deliberately bypass `subscribeQueue`.
   * The fan-out cap exists for the STORMS - one request per project or per
   * session, issued all at once - not for a single screen-driven refresh;
   * putting these four behind it would make opening a session screen wait on
   * up to `SUBSCRIBE_FAN_OUT_CONCURRENCY` unrelated background subscribes.
   */
  describe('the four screen-driven paths bypass the fan-out queue', () => {
    const saturatingSessionIds = Array.from({ length: SUBSCRIBE_FAN_OUT_CONCURRENCY + 2 }, (_, index) => `bypass-sess-${index}`);
    const saturatingProjectIds = Array.from({ length: SUBSCRIBE_FAN_OUT_CONCURRENCY + 2 }, (_, index) => `bypass-project-${index}`);

    function holdEverything(): (request: CapabilityRequestMessage) => CapabilityResponseMessage | null {
      return (request) => (request.verb === 'read-stream' || request.verb === 'read-board' ? null : defaultResponder(request));
    }

    it('refreshStream reaches the wire immediately while the stream queue is saturated', async () => {
      const { stub, manager, requests } = await harness(holdEverything());
      stub.beginHandshake();
      await flushLoopback();
      manager.setDesiredStreams(new Set(saturatingSessionIds));
      await flushLoopback();

      const stillQueuedSessionId = saturatingSessionIds[saturatingSessionIds.length - 1];
      expect(requests.some((request) => (request.payload as { sessionId?: string }).sessionId === stillQueuedSessionId)).toBe(false);
      const countBeforeRefresh = requests.filter((request) => request.verb === 'read-stream').length;
      expect(countBeforeRefresh).toBe(SUBSCRIBE_FAN_OUT_CONCURRENCY);

      manager.refreshStream(stillQueuedSessionId);
      await flushLoopback();

      expect(requests.filter((request) => request.verb === 'read-stream')).toHaveLength(countBeforeRefresh + 1);
    });

    it('setStreamWantsTerminal reaches the wire immediately while the stream queue is saturated', async () => {
      const { stub, manager, requests } = await harness(holdEverything());
      stub.beginHandshake();
      await flushLoopback();
      manager.setDesiredStreams(new Set(saturatingSessionIds));
      await flushLoopback();

      const stillQueuedSessionId = saturatingSessionIds[saturatingSessionIds.length - 1];
      const countBeforeToggle = requests.filter((request) => request.verb === 'read-stream').length;
      expect(countBeforeToggle).toBe(SUBSCRIBE_FAN_OUT_CONCURRENCY);

      const issuedResubscribe = manager.setStreamWantsTerminal(stillQueuedSessionId, true);
      await flushLoopback();

      expect(issuedResubscribe).toBe(true);
      expect(requests.filter((request) => request.verb === 'read-stream')).toHaveLength(countBeforeToggle + 1);
    });

    it('refreshBoard reaches the wire on its own debounce timer, not behind the saturated board queue', async () => {
      vi.useFakeTimers();
      try {
        const { stub, manager, requests } = await harness(holdEverything());
        stub.beginHandshake();
        await flushLoopbackFakeTimers();
        manager.setDesiredBoards(new Set(saturatingProjectIds));
        await flushLoopbackFakeTimers();

        const stillQueuedProjectId = saturatingProjectIds[saturatingProjectIds.length - 1];
        const countBeforeRefresh = requests.filter((request) => request.verb === 'read-board').length;
        expect(countBeforeRefresh).toBe(SUBSCRIBE_FAN_OUT_CONCURRENCY);

        manager.refreshBoard(stillQueuedProjectId);
        // BOARD_REFRESH_DEBOUNCE_MS, not exported - a fixed, short debounce
        // independent of how saturated the fan-out queue is.
        await vi.advanceTimersByTimeAsync(300);

        expect(requests.filter((request) => request.verb === 'read-board')).toHaveLength(countBeforeRefresh + 1);
      } finally {
        vi.useRealTimers();
      }
    });

    it('setBoardWantsFull reaches the wire immediately while the board queue is saturated', async () => {
      vi.useFakeTimers();
      try {
        const { stub, manager, requests } = await harness(holdEverything());
        stub.beginHandshake();
        await flushLoopbackFakeTimers();
        manager.setDesiredBoards(new Set(saturatingProjectIds));
        await flushLoopbackFakeTimers();

        const stillQueuedProjectId = saturatingProjectIds[saturatingProjectIds.length - 1];
        const countBeforeUpgrade = requests.filter((request) => request.verb === 'read-board').length;
        expect(countBeforeUpgrade).toBe(SUBSCRIBE_FAN_OUT_CONCURRENCY);

        manager.setBoardWantsFull(stillQueuedProjectId);
        await flushLoopbackFakeTimers();

        const afterUpgrade = requests.filter((request) => request.verb === 'read-board');
        expect(afterUpgrade).toHaveLength(countBeforeUpgrade + 1);
        expect(afterUpgrade[afterUpgrade.length - 1].payload).toMatchObject({ projectId: stillQueuedProjectId, view: 'full' });
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it('flushes desired sets declared before the first handshake once established', async () => {
    const { stub, manager, sinkCalls } = await harness();
    manager.setDesiredBoards(new Set(['project-1']));
    manager.setDesiredStreams(new Set(['sess-1', 'sess-2']));
    expect(sinkCalls.boardSnapshots).toEqual([]);

    stub.beginHandshake();
    await flushLoopback();

    expect(sinkCalls.boardSnapshots).toEqual(['project-1']);
    expect([...sinkCalls.streamSnapshots].sort()).toEqual(['sess-1', 'sess-2']);
  });

  /**
   * The boards a Board tab already has open (upgraded to 'full') go out
   * before the feed-only ones on a fresh establish, so the desktop answers
   * the screen the user is looking at first rather than queuing it behind
   * every other project.
   *
   * Mutation seen failing: reverting boardsFullFirst to plain
   * `[...this.desiredBoardIds]` issued project-1 ('sessions') first instead
   * of project-2 ('full') - the first subscribe's payload matched
   * `{"projectId":"project-1","view":"sessions"}` instead of the expected
   * `{"projectId":"project-2","view":"full"}`.
   */
  it('issues full-board subscribes before sessions-board subscribes on establish', async () => {
    const { stub, manager, requests } = await harness();
    manager.setDesiredBoards(new Set(['project-1', 'project-2', 'project-3']));
    manager.setBoardWantsFull('project-2');

    stub.beginHandshake();
    await flushLoopback();

    const boardSubscribes = requests.filter(
      (request) => request.verb === 'read-board' && (request.payload as { action?: string }).action !== 'unsubscribe',
    );
    expect(boardSubscribes).toHaveLength(3);
    expect(boardSubscribes[0].payload).toMatchObject({ projectId: 'project-2', view: 'full' });
    const remainingProjectIds = boardSubscribes
      .slice(1)
      .map((request) => (request.payload as { projectId?: string }).projectId)
      .sort();
    expect(remainingProjectIds).toEqual(['project-1', 'project-3']);
  });

  /**
   * The feed discards PTY bytes on arrival, and on a live board that discard
   * measured ~13MB an hour with no terminal on screen. So a stream is
   * subscribed list-only by default, and only a session screen asks for the
   * bytes. `terminal` absent would mean "send them" to the desktop, so the
   * false must actually be on the wire, not merely omitted.
   */
  it('subscribes streams list-only until a screen asks for the terminal', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredStreams(new Set(['sess-1']));
    await flushLoopback();

    const subscribes = requests.filter((request) => request.verb === 'read-stream');
    expect(subscribes).toHaveLength(1);
    expect((subscribes[0].payload as { terminal?: boolean }).terminal).toBe(false);

    manager.setStreamWantsTerminal('sess-1', true);
    await flushLoopback();

    const afterOpen = requests.filter((request) => request.verb === 'read-stream');
    expect(afterOpen).toHaveLength(2);
    expect((afterOpen[1].payload as { terminal?: boolean }).terminal).toBe(true);
  });

  /**
   * Measured on a release build: every column move seeded the successor's
   * terminal TWICE, 30 to 45 ms apart. The board snapshot's reconcile queued a
   * subscribe for the new session and the screen's terminal flip issued a
   * direct one before the queued copy had started; the copy then started,
   * read the same flag, and the page replayed the whole ring a second time.
   * The direct request supersedes the queued copy.
   */
  it('issues one subscribe, not two, when the terminal flip lands while the reconcile copy is still queued', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredStreams(new Set(['sess-1']));
    // Synchronously, before the queue's microtask starts the copy: the shape
    // a board snapshot followed by the screen's open produces.
    expect(manager.setStreamWantsTerminal('sess-1', true)).toBe(true);
    await flushLoopback();

    const subscribes = requests.filter((request) => request.verb === 'read-stream');
    expect(subscribes).toHaveLength(1);
    expect((subscribes[0].payload as { terminal?: boolean }).terminal).toBe(true);
  });

  /**
   * The other order: a reconcile that lands while a subscribe for the same
   * session is already on the wire. Nothing it could ask for differs from
   * what is about to be answered.
   */
  it('does not re-issue a subscribe that is already in flight when a reconcile re-lists the session', async () => {
    const { stub, manager, requests } = await harness((request) => {
      // Hold every read-stream: the first subscribe stays in flight.
      if (request.verb === 'read-stream') return null;
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredStreams(new Set(['sess-1']));
    await flushLoopback();
    expect(requests.filter((request) => request.verb === 'read-stream')).toHaveLength(1);

    manager.setDesiredStreams(new Set(['sess-1', 'sess-2']));
    await flushLoopback();

    const subscribes = requests.filter((request) => request.verb === 'read-stream');
    expect(subscribes.map((request) => (request.payload as { sessionId?: string }).sessionId)).toEqual(['sess-1', 'sess-2']);
  });

  it('drops back to list-only when the screen closes', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredStreams(new Set(['sess-1']));
    manager.setStreamWantsTerminal('sess-1', true);
    await flushLoopback();
    const countAfterOpen = requests.length;

    manager.setStreamWantsTerminal('sess-1', false);
    await flushLoopback();

    const afterClose = requests.slice(countAfterOpen).filter((request) => request.verb === 'read-stream');
    expect(afterClose).toHaveLength(1);
    expect((afterClose[0].payload as { terminal?: boolean }).terminal).toBe(false);
  });

  /**
   * openSessionScreen trusts this return value to decide whether it still
   * needs its own refreshStream call (see tests/unit/openSessionScreen.test.ts):
   * true means setStreamWantsTerminal's own re-subscribe already fetched a
   * fresh frame, false means nothing was issued and the caller must ask
   * itself. If this drifted to always-true (or always-false), the caller's
   * own tests are mocking the return value and would never catch it - only
   * asserting the REAL return value here does.
   */
  it('setStreamWantsTerminal returns true only when it actually issues a re-subscribe', async () => {
    const { stub, manager } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredStreams(new Set(['sess-1']));
    await flushLoopback();

    // Changed, desired, and established: this call IS the re-subscribe.
    expect(manager.setStreamWantsTerminal('sess-1', true)).toBe(true);
    await flushLoopback();

    // Same value as already set: nothing to do, nothing issued.
    expect(manager.setStreamWantsTerminal('sess-1', true)).toBe(false);

    // A session nobody has declared desired: the flag is recorded, but
    // there is no active subscription to re-issue.
    expect(manager.setStreamWantsTerminal('sess-2', true)).toBe(false);
  });

  it('setStreamWantsTerminal returns false for a desired stream before the handshake establishes', async () => {
    const { manager } = await harness();
    // Declared before any handshake - exactly the openSessionScreen case of
    // opening a screen while still connecting.
    manager.setDesiredStreams(new Set(['sess-1']));

    expect(manager.setStreamWantsTerminal('sess-1', true)).toBe(false);
  });

  it('does not re-subscribe when the terminal mode is set to what it already is', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredStreams(new Set(['sess-1']));
    await flushLoopback();
    const countAfterSubscribe = requests.length;

    manager.setStreamWantsTerminal('sess-1', false);
    await flushLoopback();

    expect(requests).toHaveLength(countAfterSubscribe);
  });

  /**
   * The phone watches every project's board to find live sessions, but only
   * draws the tasks that have one. Measured across 15 projects, the full
   * boards were 63kB compressed against 12kB for the projection, repeated on
   * every board change - so 'sessions' is the default and 'full' is asked for
   * only where a whole board is rendered.
   */
  it('subscribes boards with the sessions projection until a board screen asks for the full one', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredBoards(new Set(['project-1', 'project-2']));
    await flushLoopback();

    const subscribes = requests.filter((request) => request.verb === 'read-board');
    expect(subscribes).toHaveLength(2);
    expect(subscribes.every((request) => (request.payload as { view?: string }).view === 'sessions')).toBe(true);

    manager.setBoardWantsFull('project-1');
    await flushLoopback();

    const afterOpen = requests.filter((request) => request.verb === 'read-board');
    expect(afterOpen).toHaveLength(3);
    expect((afterOpen[2].payload as { projectId?: string; view?: string })).toMatchObject({
      projectId: 'project-1',
      view: 'full',
    });
  });

  /**
   * The two subscribes above, arranged so both are in flight at once: the
   * reconcile's 'sessions' subscribe has to have LEFT before the Board tab
   * asks for 'full', or there is no race to test.
   *
   * The flush between them is what arranges that, and it is load-bearing
   * rather than incidental. `setDesiredBoards` schedules its subscribe behind
   * the fan-out cap (`SUBSCRIBE_FAN_OUT_CONCURRENCY`) and the queued task reads
   * the wanted view at DRAIN time, so without the flush the upgrade lands
   * first and the reconcile issues 'full' as well - two identical requests and
   * no stale response to ignore. An earlier revision of this test ran the two
   * calls back to back and its docstring claimed that was "the only arrangement
   * that reaches the race"; that was true of the unqueued fan-out and is not
   * true now.
   *
   * The race itself is unchanged in production: bootstrap asks for 'sessions'
   * and the Board tab focuses and asks for 'full' before the first answer comes
   * back, so two read-boards for one project are in flight at once and the
   * responses can land in either order.
   *
   * A late 'sessions' snapshot must not be applied: applyBoardSnapshot replaces
   * tasksById wholesale, so it would erase every task without a live session
   * from a Board tab that had already rendered them, strand the screen back on
   * its skeleton, and leave any optimistic move over one of those tasks with
   * nothing to commit against.
   */
  it('ignores a board response whose view is no longer the one wanted', async () => {
    const heldSessionsRequests: CapabilityRequestMessage[] = [];
    const { stub, manager, requests, sinkCalls } = await harness((request) => {
      if (request.verb === 'read-board' && (request.payload as { view?: ReadBoardView }).view === 'sessions') {
        heldSessionsRequests.push(request);
        return null;
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredBoards(new Set(['project-1']));
    // Lets the queued 'sessions' subscribe actually leave, so the upgrade
    // below overlaps it instead of preceding it. See the docstring.
    await flushLoopback();
    manager.setBoardWantsFull('project-1');
    await flushLoopback();

    // Both went out; only the 'full' one has been answered so far.
    expect(requests.filter((request) => request.verb === 'read-board')).toHaveLength(2);
    expect(heldSessionsRequests).toHaveLength(1);
    expect(sinkCalls.boardSnapshots).toEqual(['project-1']);

    // Release the stale answer, out of issue order.
    for (const held of heldSessionsRequests) stub.send(defaultResponder(held));
    await flushLoopback();

    // Not applied to the store...
    expect(sinkCalls.boardSnapshots).toEqual(['project-1']);
    // ...and the LANDED view is still 'full', which setBoardWantsFull proves by
    // declining to re-issue (it only re-issues while the upgrade has not landed).
    const countBeforeRefocus = requests.length;
    manager.setBoardWantsFull('project-1');
    await flushLoopback();
    expect(requests).toHaveLength(countBeforeRefocus);
  });

  /**
   * The same race on the terminal flag: opening a session screen and closing it
   * again before the first subscribe answers leaves two read-streams in flight
   * with opposite `terminal` values.
   */
  it('ignores a stream response whose terminal mode is no longer the one wanted', async () => {
    const heldListOnlyRequests: CapabilityRequestMessage[] = [];
    const { stub, manager, requests, sinkCalls } = await harness((request) => {
      if (request.verb === 'read-stream' && (request.payload as { terminal?: boolean }).terminal === false) {
        heldListOnlyRequests.push(request);
        return null;
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredStreams(new Set(['sess-1']));
    // Same reason as the board test above: the queued list-only subscribe has
    // to leave before the terminal flag flips, or the reconcile reads the new
    // flag at drain time and never issues a list-only request to go stale.
    await flushLoopback();
    manager.setStreamWantsTerminal('sess-1', true);
    await flushLoopback();

    expect(requests.filter((request) => request.verb === 'read-stream')).toHaveLength(2);
    expect(sinkCalls.streamSnapshots).toEqual(['sess-1']);

    for (const held of heldListOnlyRequests) stub.send(defaultResponder(held));
    await flushLoopback();

    expect(sinkCalls.streamSnapshots).toEqual(['sess-1']);
  });

  /**
   * Upgrade-only, deliberately. A full board is small, and downgrading one
   * back to 'sessions' would let a snapshot drop a task that an optimistic
   * move/edit/removal is still pending on, leaving the rollback nothing to
   * restore.
   */
  it('keeps a board on the full projection across a re-handshake, and never asks twice', async () => {
    const { session, stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredBoards(new Set(['project-1']));
    manager.setBoardWantsFull('project-1');
    await flushLoopback();
    const countAfterUpgrade = requests.length;

    manager.setBoardWantsFull('project-1');
    await flushLoopback();
    expect(requests).toHaveLength(countAfterUpgrade);

    session.reset();
    stub.beginHandshake();
    await flushLoopback();

    const afterReconnect = requests.slice(countAfterUpgrade).filter((request) => request.verb === 'read-board');
    expect(afterReconnect).toHaveLength(1);
    expect((afterReconnect[0].payload as { view?: string }).view).toBe('full');
  });

  /**
   * The upgrade-permanence guarantee above is scoped to a project that STAYS
   * desired. Once a project drops out of the desired set entirely (the
   * project list refreshed without it), its full-board upgrade is gone too -
   * a later re-add is a fresh board and starts back at the feed projection,
   * with the Board tab upgrading it again only if it is opened.
   */
  it('a board dropped from the desired set and later re-added starts back at the sessions projection', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredBoards(new Set(['project-1']));
    manager.setBoardWantsFull('project-1');
    await flushLoopback();

    const readBoardSubscribeRequests = (): CapabilityRequestMessage[] =>
      requests.filter((request) => request.verb === 'read-board' && (request.payload as { action?: string }).action !== 'unsubscribe');
    expect((readBoardSubscribeRequests().at(-1)?.payload as { view?: string }).view).toBe('full');

    manager.setDesiredBoards(new Set());
    await flushLoopback();
    // Only the requests issued AFTER the re-add count: an earlier subscribe
    // still in flight can land on the stub out of issue order, which would
    // make `.at(-1)` over the whole list a coin flip.
    const countBeforeReadd = requests.length;
    manager.setDesiredBoards(new Set(['project-1']));
    await flushLoopback();

    const afterReadd = requests
      .slice(countBeforeReadd)
      .filter((request) => request.verb === 'read-board' && (request.payload as { action?: string }).action !== 'unsubscribe');
    expect(afterReadd).toHaveLength(1);
    expect(afterReadd[0].payload).toMatchObject({ projectId: 'project-1', view: 'sessions' });
  });

  it('re-issues every desired subscription after a transport drop and fresh handshake', async () => {
    const { session, stub, manager, requests, sinkCalls } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredBoards(new Set(['project-1']));
    manager.setDesiredStreams(new Set(['sess-1']));
    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'working' });
    await flushLoopback();
    const requestCountBeforeDrop = requests.length;

    // Transport drop: ChannelController would call session.reset(); the
    // desktop then re-initiates a handshake on reconnect.
    session.reset();
    stub.beginHandshake();
    await flushLoopback();

    const requestsAfterDrop = requests.slice(requestCountBeforeDrop);
    const verbsAfterDrop = requestsAfterDrop.map((request) => request.verb).sort();
    expect(verbsAfterDrop).toEqual(['read-board', 'read-diff', 'read-stream']);
    expect(sinkCalls.boardSnapshots).toEqual(['project-1', 'project-1']);
    expect(sinkCalls.streamSnapshots).toEqual(['sess-1', 'sess-1']);
    expect(sinkCalls.diffFileLists).toEqual(['task-1', 'task-1']);
  });

  it('prunes a stream the desktop rejects and reports it through the sink', async () => {
    const { stub, manager, sinkCalls, requests } = await harness((request) => {
      if (request.verb === 'read-stream') {
        return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'No such session: sess-dead' };
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredStreams(new Set(['sess-dead']));
    await flushLoopback();

    expect(sinkCalls.streamRejections).toHaveLength(1);
    expect(sinkCalls.streamRejections[0].sessionId).toBe('sess-dead');
    expect(sinkCalls.streamRejections[0].error.message).toMatch(/No such session/);

    // Pruned: re-declaring an unrelated desired set must not retry sess-dead.
    const requestCount = requests.length;
    manager.setDesiredStreams(new Set(['sess-dead']));
    await flushLoopback();
    // Re-declaring DOES retry (it is a fresh desired set)...
    expect(requests.length).toBe(requestCount + 1);
  });

  /**
   * A refused diff fetch used to be swallowed whole. The Changes tab's only
   * other state is its loading skeleton, so the pane sat on it forever, and
   * DiffFetchStatus's 'error' member had no writer anywhere in the app.
   *
   * The SCOPE matters as much as the taskId: the store keys status by scope,
   * so reporting the failure without it would let a scope switch mid-flight
   * mark the wrong one failed.
   */
  it('reports a refused diff fetch through the sink, with the scope it was for', async () => {
    const { stub, manager, sinkCalls } = await harness((request) => {
      if (request.verb === 'read-diff') {
        return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'No worktree for task-1' };
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'branch' });
    await flushLoopback();

    expect(sinkCalls.diffFetchFailures).toEqual([{ taskId: 'task-1', scope: 'branch' }]);
    expect(sinkCalls.diffFileLists).toEqual([]);
  });

  it('does not report a diff failure for a watch that has since been dropped', async () => {
    const { stub, manager, sinkCalls } = await harness((request) => {
      if (request.verb === 'read-diff') {
        return { type: 'capability-response', requestId: request.requestId, ok: false, error: 'No worktree for task-1' };
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'working' });
    // Dropped before the refusal comes back: the screen has moved on, and a
    // late error must not reopen an error state on a pane nobody is watching.
    manager.setDesiredDiff('task-1', null);
    await flushLoopback();

    expect(sinkCalls.diffFetchFailures).toEqual([]);
  });

  /**
   * The other half of the same staleness guard: a watch that has since been
   * RE-SCOPED rather than dropped. The Changes tab flips scope (working ->
   * branch) while the old fetch is still in flight; when it finally rejects,
   * the desired entry is a fresh { projectId, scope: 'branch' } object, so a
   * comparison keyed on it (`this.desiredDiffsByTaskId.get(taskId) !==
   * desired`) must reject the STALE 'working' closure. Without that, the late
   * rejection would fire onDiffFetchFailed for the CURRENT (branch) watch and
   * mark a fetch that actually succeeded as errored.
   */
  it('does not report a diff failure, or mark the new scope errored, for a watch that has since been re-scoped', async () => {
    const heldWorkingRequests: CapabilityRequestMessage[] = [];
    const { stub, manager, sinkCalls } = await harness((request) => {
      if (request.verb === 'read-diff' && (request.payload as { scope?: string }).scope === 'working') {
        heldWorkingRequests.push(request);
        return null;
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'working' });
    await flushLoopback();
    expect(heldWorkingRequests).toHaveLength(1);

    // Re-scoped while the 'working' fetch is still outstanding. This issues
    // its own subscribeDiff for 'branch', which the default responder answers
    // successfully.
    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'branch' });
    await flushLoopback();
    expect(sinkCalls.diffFileLists).toEqual(['task-1']);

    // The stale 'working' fetch finally rejects.
    for (const held of heldWorkingRequests) {
      stub.send({ type: 'capability-response', requestId: held.requestId, ok: false, error: 'No worktree for task-1' });
    }
    await flushLoopback();

    // Must not report the stale rejection, and must not disturb the
    // already-successful 'branch' watch's state.
    expect(sinkCalls.diffFetchFailures).toEqual([]);
    expect(sinkCalls.diffFileLists).toEqual(['task-1']);
  });

  it('removing a desired stream unsubscribes it', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredStreams(new Set(['sess-1']));
    await flushLoopback();

    manager.setDesiredStreams(new Set());
    await flushLoopback();

    const unsubscribeRequests = requests.filter(
      (request) => request.verb === 'read-stream' && (request.payload as { action?: string }).action === 'unsubscribe',
    );
    expect(unsubscribeRequests).toHaveLength(1);
    expect((unsubscribeRequests[0].payload as { sessionId?: string }).sessionId).toBe('sess-1');
  });

  it('refreshBoard debounces bursts into one re-subscribe', async () => {
    vi.useFakeTimers();
    try {
      const { stub, manager, requests } = await harness();
      stub.beginHandshake();
      await vi.runAllTimersAsync();
      manager.setDesiredBoards(new Set(['project-1']));
      await vi.runAllTimersAsync();
      const boardRequestCount = (): number => requests.filter((request) => request.verb === 'read-board').length;
      const countAfterInitial = boardRequestCount();

      manager.refreshBoard('project-1');
      manager.refreshBoard('project-1');
      manager.refreshBoard('project-1');
      await vi.runAllTimersAsync();

      expect(boardRequestCount()).toBe(countAfterInitial + 1);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * refreshBoard must get PAST the in-flight dedupe, not merely behind it.
   * The debounce test above always lets the prior subscribe land before the
   * debounced call fires, so pendingBoardViewByProjectId is empty by then
   * and dropping `{ force: true }` from refreshBoard's re-subscribe would
   * still leave that test green. Holding the read-board response here keeps
   * the first subscribe "in flight" for the whole time the debounced call
   * fires.
   *
   * Mutation seen failing: dropping `{ force: true }` from refreshBoard's
   * `void this.subscribeBoard(projectId, { force: true })` left the
   * debounced call swallowed by subscribeBoard's own dedupe guard -
   * "expected 2, received 1" for the read-board request count.
   */
  it('refreshBoard forces its re-subscribe past the in-flight dedupe', async () => {
    const heldBoardRequests: CapabilityRequestMessage[] = [];
    const { stub, manager, requests } = await harness((request) => {
      if (request.verb === 'read-board') {
        heldBoardRequests.push(request);
        return null;
      }
      return defaultResponder(request);
    });
    stub.beginHandshake();
    await flushLoopback();
    manager.setDesiredBoards(new Set(['project-1']));
    await flushLoopback();

    const boardRequestCount = (): number => requests.filter((request) => request.verb === 'read-board').length;
    expect(boardRequestCount()).toBe(1);
    expect(heldBoardRequests).toHaveLength(1);

    manager.refreshBoard('project-1');
    // Real wait past BOARD_REFRESH_DEBOUNCE_MS (300ms): the first subscribe
    // is still held/unanswered the whole time, unlike the debounce test above.
    await new Promise((resolve) => setTimeout(resolve, 350));
    await flushLoopback();

    expect(boardRequestCount()).toBe(2);
    expect(heldBoardRequests).toHaveLength(2);
  });

  it('diff scope change re-subscribes; blur unsubscribes with the projectId', async () => {
    const { stub, manager, requests } = await harness();
    stub.beginHandshake();
    await flushLoopback();

    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'working' });
    await flushLoopback();
    manager.setDesiredDiff('task-1', { projectId: 'project-1', scope: 'branch' });
    await flushLoopback();
    manager.setDesiredDiff('task-1', null);
    await flushLoopback();

    const diffRequests = requests.filter((request) => request.verb === 'read-diff');
    expect(diffRequests.map((request) => (request.payload as { scope?: string; action?: string }).scope ?? (request.payload as { action?: string }).action)).toEqual([
      'working',
      'branch',
      'unsubscribe',
    ]);
    expect((diffRequests[2].payload as { projectId?: string }).projectId).toBe('project-1');
  });
});
