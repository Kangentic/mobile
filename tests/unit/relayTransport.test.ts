/**
 * RelayTransport over a REAL WebSocket, against a real in-process ws server.
 *
 * Every other channel test runs on LoopbackTransport, which models delivery
 * with queueMicrotask and therefore cannot say anything about a real socket.
 * That leaves one load-bearing premise untested: the deliberate-teardown
 * goodbye (SessionManager.sendFinalFrame) is written and then the socket is
 * closed on the very next line, so if close() dropped queued data instead of
 * flushing it, the Final would never reach the desktop and the feature would
 * silently do nothing while every loopback test stayed green.
 *
 * Node 22 ships a global WebSocket client, and RelayTransport constructs it
 * directly (relayTransport.ts), so pointing it at a `ws` server exercises the
 * production class unchanged.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { RelayTransport } from '@/channel/relayTransport';
import { waitUntil } from '../helpers/async';

type ServerEvent = { kind: 'frame'; bytes: Uint8Array } | { kind: 'close' };

interface RelayServerRig {
  relayUrl: string;
  events: ServerEvent[];
  /**
   * Waits until the server has observed the socket close, so ordering
   * assertions are not racing it. Bounded on purpose: a bare promise that
   * never settles fails as an anonymous "test timed out in 5000ms", and then
   * afterEach's server.close() stalls too, because `ws` withholds its callback
   * while a client is still attached. One named failure beats two nameless
   * ones - the same argument tests/helpers/async.ts makes.
   */
  waitForClose: () => Promise<void>;
  dispose: () => Promise<void>;
}

let activeRig: RelayServerRig | null = null;

async function startRelayServer(): Promise<RelayServerRig> {
  const server = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('expected an AddressInfo from ws');

  const events: ServerEvent[] = [];

  server.on('connection', (socket) => {
    socket.on('message', (data: Buffer) => {
      events.push({ kind: 'frame', bytes: new Uint8Array(data) });
    });
    socket.on('close', () => {
      events.push({ kind: 'close' });
    });
  });

  const rig: RelayServerRig = {
    relayUrl: `ws://127.0.0.1:${address.port}`,
    events,
    waitForClose: () =>
      waitUntil(() => events.some((event) => event.kind === 'close'), {
        label: 'the relay server observed the socket close',
      }),
    dispose: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  activeRig = rig;
  return rig;
}

afterEach(async () => {
  await activeRig?.dispose();
  activeRig = null;
});

describe('RelayTransport over a real socket', () => {
  it('flushes a frame written immediately before close() - the guarantee the Final goodbye rides on', async () => {
    const rig = await startRelayServer();
    const transport = new RelayTransport({ relayUrl: rig.relayUrl, slotId: 'test-slot' });
    await transport.connect();

    // Exactly ChannelController.dispose()'s sequence: seal-and-send, then
    // close on the very next line, with nothing awaited in between.
    const goodbye = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
    transport.send(goodbye);
    transport.close();

    await rig.waitForClose();

    // The frame must arrive, and it must arrive BEFORE the close - a server
    // that saw only the close is the exact silent failure this test exists
    // to catch.
    expect(rig.events.map((event) => event.kind)).toEqual(['frame', 'close']);
    const firstEvent = rig.events[0];
    if (firstEvent.kind !== 'frame') throw new Error('unreachable');
    expect(firstEvent.bytes).toEqual(goodbye);
  });

  it('throws rather than silently dropping a frame written after close()', async () => {
    const rig = await startRelayServer();
    const transport = new RelayTransport({ relayUrl: rig.relayUrl, slotId: 'test-slot' });
    await transport.connect();

    transport.close();
    expect(transport.state).toBe('closed');

    // This is why sendFinalFrame guards on transport.state AND wraps the send
    // in a try/catch: a late write is a throw, not a no-op, and an escaping
    // one would abandon the rest of the dispose chain.
    // Asserting the MESSAGE, not merely that something threw: with the guard
    // deleted this still throws, but as an incidental TypeError on a nulled
    // socket, which would let a bare .toThrow() pass over a deleted guard.
    expect(() => transport.send(new Uint8Array([1]))).toThrow('RelayTransport.send() called while not connected');

    await rig.waitForClose();
    expect(rig.events.map((event) => event.kind)).toEqual(['close']);
  });
});
