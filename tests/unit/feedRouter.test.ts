/**
 * FeedRouter routes unsolicited EventMessages by kind over a REAL
 * established session (loopback transport + real-protocol stub initiator),
 * drops malformed events, and ignores non-event messages.
 */
import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair, type BridgeEvent, type TerminalEvent, type TerminalResizeEvent } from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { FeedRouter } from '@/channel/feedRouter';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';

async function establishedPair(): Promise<{ session: SessionManager; stub: StubSessionInitiator }> {
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
  stub.beginHandshake();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(session.isEstablished).toBe(true);
  return { session, stub };
}

function terminalEventFixture(data: string): TerminalEvent {
  return { kind: 'terminal', sessionId: 'sess-1', taskId: 'task-1', payload: { data } };
}

describe('FeedRouter', () => {
  it('routes events to the listener registered for their kind only', async () => {
    const { session, stub } = await establishedPair();
    const router = new FeedRouter(session);
    const terminalEvents: TerminalEvent[] = [];
    const diffTaskIds: string[] = [];
    router.on('terminal', (event) => terminalEvents.push(event));
    router.on('diff', (event) => diffTaskIds.push(event.taskId));

    stub.emitEvent(terminalEventFixture('chunk-1'));
    stub.emitEvent({ kind: 'diff', taskId: 'task-9', payload: null });
    stub.emitEvent({ kind: 'activity', sessionId: 'sess-1', taskId: 'task-1', payload: { type: 'permission', promptId: 'p-1', pending: true } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(terminalEvents.map((event) => event.payload.data)).toEqual(['chunk-1']);
    expect(diffTaskIds).toEqual(['task-9']);
  });

  it('routes terminal-resize events (0.4.0 grid changes) to their own listener, dropping a malformed grid', async () => {
    const { session, stub } = await establishedPair();
    const router = new FeedRouter(session);
    const resizes: TerminalResizeEvent[] = [];
    router.on('terminal-resize', (event) => resizes.push(event));

    stub.emitEvent({ kind: 'terminal-resize', sessionId: 'sess-1', taskId: 'task-1', payload: { cols: 48, rows: 26 } });
    // A malformed grid (cols below the floor) is dropped by isBridgeEvent.
    stub.send({
      type: 'event',
      event: { kind: 'terminal-resize', sessionId: 'sess-1', taskId: 'task-1', payload: { cols: 0, rows: 26 } } as unknown as BridgeEvent,
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(resizes).toEqual([{ kind: 'terminal-resize', sessionId: 'sess-1', taskId: 'task-1', payload: { cols: 48, rows: 26 } }]);
  });

  it('drops a structurally malformed event silently', async () => {
    const { session, stub } = await establishedPair();
    const router = new FeedRouter(session);
    const received: BridgeEvent[] = [];
    router.on('terminal', (event) => received.push(event));

    // decodeMessage's envelope validation passes (kind/ids present, payload
    // is JSON) but isBridgeEvent's payload check rejects data: 42.
    stub.send({
      type: 'event',
      event: { kind: 'terminal', sessionId: 'sess-1', taskId: 'task-1', payload: { data: 42 } } as unknown as BridgeEvent,
    });
    stub.emitEvent(terminalEventFixture('good'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toHaveLength(1);
    expect((received[0] as TerminalEvent).payload.data).toBe('good');
  });

  it('ignores heartbeats and unsubscribe stops delivery', async () => {
    const { session, stub } = await establishedPair();
    const router = new FeedRouter(session);
    const received: string[] = [];
    const unsubscribe = router.on('terminal', (event) => received.push(event.payload.data));

    stub.send({ type: 'heartbeat' });
    stub.emitEvent(terminalEventFixture('first'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    unsubscribe();
    stub.emitEvent(terminalEventFixture('second'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(received).toEqual(['first']);
  });

  it('dispose detaches from the session message stream', async () => {
    const { session, stub } = await establishedPair();
    const router = new FeedRouter(session);
    const received: string[] = [];
    router.on('terminal', (event) => received.push(event.payload.data));
    router.dispose();

    stub.emitEvent(terminalEventFixture('after-dispose'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toEqual([]);
  });
});
