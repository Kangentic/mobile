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
} from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { CapabilityClient } from '@/channel/capabilityClient';
import { VerbClient, type CapabilityError } from '@/channel/verbClient';
import { SubscriptionManager, type SubscriptionSnapshotSinks } from '@/channel/subscriptionManager';
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
  };
}

function defaultResponder(request: CapabilityRequestMessage): CapabilityResponseMessage {
  const payload = request.payload as { sessionId?: string; projectId?: string; taskId?: string; action?: string };
  if (payload.action === 'unsubscribe') return { type: 'capability-response', requestId: request.requestId, ok: true };
  switch (request.verb) {
    case 'read-stream':
      return { type: 'capability-response', requestId: request.requestId, ok: true, payload: streamSnapshotFixture() as unknown as JsonValue };
    case 'read-board':
      return {
        type: 'capability-response',
        requestId: request.requestId,
        ok: true,
        payload: boardSnapshotFixture({ projectId: payload.projectId ?? 'project-1' }) as unknown as JsonValue,
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

  const sinkCalls: Harness['sinkCalls'] = { streamSnapshots: [], streamRejections: [], boardSnapshots: [], diffFileLists: [] };
  const sinks: SubscriptionSnapshotSinks = {
    onStreamSnapshot: (sessionId) => sinkCalls.streamSnapshots.push(sessionId),
    onStreamRejected: (sessionId, error) => sinkCalls.streamRejections.push({ sessionId, error }),
    onBoardSnapshot: (snapshot) => sinkCalls.boardSnapshots.push(snapshot.projectId),
    onDiffFileList: (taskId) => sinkCalls.diffFileLists.push(taskId),
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

describe('SubscriptionManager', () => {
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
