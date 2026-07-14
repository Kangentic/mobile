/**
 * End-to-end bootstrap over the loopback: project list -> board snapshots
 * -> live-session stream fan-out (R4: streams follow non-null session_id),
 * board events -> debounced re-snapshot -> session-set reconciliation.
 * Exercises runBootstrap + createSnapshotSinks + bindFeedToStores + the
 * real channel stack against the stub initiator.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  generateX25519KeyPair,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type JsonValue,
  type ReadBoardSnapshotResponsePayload,
} from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { CapabilityClient } from '@/channel/capabilityClient';
import { FeedRouter } from '@/channel/feedRouter';
import { VerbClient } from '@/channel/verbClient';
import { SubscriptionManager } from '@/channel/subscriptionManager';
import { runBootstrap } from '@/connection/bootstrap';
import { bindFeedToStores, createSnapshotSinks } from '@/connection/storeFeed';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useDiffStore } from '@/state/diffStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { resetTerminalFeed } from '@/state/terminalFeed';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { boardSnapshotFixture, boardTaskFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';

async function flushLoopback(rounds = 8): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe('bootstrap over loopback', () => {
  beforeEach(() => {
    useActivityStore.getState().reset();
    useBoardStore.getState().reset();
    useDiffStore.getState().reset();
    useTranscriptStore.getState().reset();
    resetTerminalFeed();
  });

  afterEach(() => {
    useActivityStore.getState().reset();
    useBoardStore.getState().reset();
  });

  it('populates stores and subscribes exactly the live sessions, then reconciles on board change', async () => {
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

    let boardSnapshot: ReadBoardSnapshotResponsePayload = boardSnapshotFixture({
      projectId: 'project-1',
      tasks: [
        boardTaskFixture({ id: 'task-1', session_id: 'sess-1' }),
        boardTaskFixture({ id: 'task-2', session_id: 'sess-2', position: 1 }),
        boardTaskFixture({ id: 'task-3', session_id: null, position: 2 }),
      ],
    });

    stub.setRequestHandler((request: CapabilityRequestMessage): CapabilityResponseMessage => {
      const payload = request.payload as { projectId?: string; sessionId?: string; action?: string };
      if (request.verb === 'read-board' && !payload.projectId) {
        return {
          type: 'capability-response',
          requestId: request.requestId,
          ok: true,
          payload: { projects: [{ id: 'project-1', name: 'Alpha' }] },
        };
      }
      if (request.verb === 'read-board') {
        return { type: 'capability-response', requestId: request.requestId, ok: true, payload: boardSnapshot as unknown as JsonValue };
      }
      if (request.verb === 'read-stream' && payload.action === 'subscribe') {
        return { type: 'capability-response', requestId: request.requestId, ok: true, payload: streamSnapshotFixture() as unknown as JsonValue };
      }
      return { type: 'capability-response', requestId: request.requestId, ok: true };
    });

    const capabilities = new CapabilityClient(session);
    const verbs = new VerbClient(capabilities);
    const feed = new FeedRouter(session);
    let subscriptionsHolder: SubscriptionManager | null = null;
    const subscriptions: SubscriptionManager = new SubscriptionManager({
      session,
      verbs,
      sinks: createSnapshotSinks(() => {
        if (!subscriptionsHolder) throw new Error('unresolved');
        return subscriptionsHolder;
      }),
    });
    subscriptionsHolder = subscriptions;
    bindFeedToStores(feed, subscriptions);

    stub.beginHandshake();
    await flushLoopback();
    await runBootstrap(verbs, subscriptions);
    await flushLoopback();

    // Stores populated.
    expect(useBoardStore.getState().projects).toEqual([{ id: 'project-1', name: 'Alpha' }]);
    expect(Object.keys(useBoardStore.getState().boardsByProjectId)).toEqual(['project-1']);
    const activityIds = Object.keys(useActivityStore.getState().bySessionId).sort();
    expect(activityIds).toEqual(['sess-1', 'sess-2']);
    expect(useActivityStore.getState().bySessionId['sess-1'].feedStatus).toBe('live');
    expect(useActivityStore.getState().bySessionId['sess-1'].taskId).toBe('task-1');

    // Exactly the live sessions were stream-subscribed.
    const streamSubscribes = stub.messages.filter(
      (message) =>
        message.type === 'capability-request' &&
        message.verb === 'read-stream' &&
        (message.payload as { action?: string }).action === 'subscribe',
    );
    expect(streamSubscribes).toHaveLength(2);

    // A board change drops task-2's session: the debounced re-snapshot
    // reconciles the desired stream set and removes the activity entry.
    boardSnapshot = boardSnapshotFixture({
      projectId: 'project-1',
      tasks: [boardTaskFixture({ id: 'task-1', session_id: 'sess-1' }), boardTaskFixture({ id: 'task-2', session_id: null, position: 1 })],
    });
    stub.emitEvent({ kind: 'board', projectId: 'project-1', payload: { change: 'task-updated', ids: ['task-2'] } });
    await new Promise((resolve) => setTimeout(resolve, 350)); // past the 300ms debounce
    await flushLoopback();

    expect(Object.keys(useActivityStore.getState().bySessionId)).toEqual(['sess-1']);
    const streamUnsubscribes = stub.messages.filter(
      (message) =>
        message.type === 'capability-request' &&
        message.verb === 'read-stream' &&
        (message.payload as { action?: string }).action === 'unsubscribe',
    );
    expect(streamUnsubscribes).toHaveLength(1);
    expect((streamUnsubscribes[0] as CapabilityRequestMessage).payload).toEqual({ sessionId: 'sess-2', action: 'unsubscribe' });
  });
});
