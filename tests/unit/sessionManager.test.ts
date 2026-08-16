import { describe, expect, it } from 'vitest';
import {
  deriveSecretstreamPair,
  FrameTag,
  generateX25519KeyPair,
  type BridgeMessage,
  type Transport,
  type TransportState,
  type Unsubscribe,
} from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { CapabilityClient } from '@/channel/capabilityClient';
import { createLoopbackPair, type LoopbackTransport } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { flushMicrotasks, waitUntil } from '../helpers/async';

interface SessionRig {
  sessionManager: SessionManager;
  desktop: StubSessionInitiator;
  phoneTransport: LoopbackTransport;
}

/** Connected transports and a started SessionManager, but NO handshake - callers drive establishment themselves. */
async function createConnectedRig(): Promise<SessionRig> {
  const phoneIdentity = generateX25519KeyPair();
  const desktopStatic = generateX25519KeyPair();
  const [phoneTransport, desktopTransport] = createLoopbackPair();

  const sessionManager = new SessionManager({
    identity: phoneIdentity,
    remoteStaticPublicKey: desktopStatic.publicKey,
    transport: phoneTransport,
  });
  sessionManager.start();

  const desktop = new StubSessionInitiator(desktopTransport, {
    desktopStatic,
    phoneStaticPublicKey: phoneIdentity.publicKey,
  });

  await phoneTransport.connect();
  await desktopTransport.connect();

  return { sessionManager, desktop, phoneTransport };
}

/**
 * A LoopbackTransport that can be HELD in a non-'connected' state and then
 * released, which plain LoopbackTransport cannot express: simulateReconnect()
 * flips back to 'connected' in the same tick, leaving no window to send into,
 * and close() is terminal. A real network blip is exactly this shape - the
 * socket stops carrying frames for a while, and nothing resets the session, so
 * the key material stays live throughout.
 */
class FlappableTransport implements Transport {
  private heldState: TransportState | null = null;

  constructor(private readonly inner: LoopbackTransport) {}

  get state(): TransportState {
    return this.heldState ?? this.inner.state;
  }

  holdDisconnected(): void {
    this.heldState = 'reconnecting';
  }

  release(): void {
    this.heldState = null;
  }

  async connect(): Promise<void> {
    await this.inner.connect();
  }

  // Throws rather than no-ops while disconnected, matching RelayTransport.send.
  send(frame: Uint8Array): void {
    if (this.state !== 'connected') throw new Error('FlappableTransport.send() called while not connected');
    this.inner.send(frame);
  }

  close(): void {
    this.inner.close();
  }

  onFrame(listener: (frame: Uint8Array) => void): Unsubscribe {
    return this.inner.onFrame(listener);
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    return this.inner.onStateChange(listener);
  }
}

describe('SessionManager (KK responder)', () => {
  it('establishes a session initiated by the desktop and exchanges application messages', async () => {
    const phoneIdentity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const [phoneTransport, desktopTransport] = createLoopbackPair();

    const sessionManager = new SessionManager({
      identity: phoneIdentity,
      remoteStaticPublicKey: desktopStatic.publicKey,
      transport: phoneTransport,
    });
    sessionManager.start();

    const desktop = new StubSessionInitiator(desktopTransport, {
      desktopStatic,
      phoneStaticPublicKey: phoneIdentity.publicKey,
    });

    const receivedByPhone: BridgeMessage[] = [];
    sessionManager.onMessage((message) => receivedByPhone.push(message));

    await phoneTransport.connect();
    await desktopTransport.connect();
    desktop.beginHandshake();

    await waitUntil(() => sessionManager.isEstablished && desktop.isEstablished);

    desktop.send({ type: 'heartbeat' });
    await waitUntil(() => receivedByPhone.length > 0);
    expect(receivedByPhone[0]).toEqual({ type: 'heartbeat' });

    sessionManager.send({ type: 'heartbeat' });
    await waitUntil(() => desktop.messages.length > 0);
    expect(desktop.messages[0]).toEqual({ type: 'heartbeat' });
  });

  it('re-establishes with fresh keys when the desktop re-initiates the handshake (rekey)', async () => {
    const phoneIdentity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const [phoneTransport, desktopTransport] = createLoopbackPair();

    const sessionManager = new SessionManager({
      identity: phoneIdentity,
      remoteStaticPublicKey: desktopStatic.publicKey,
      transport: phoneTransport,
    });
    sessionManager.start();

    const desktop = new StubSessionInitiator(desktopTransport, {
      desktopStatic,
      phoneStaticPublicKey: phoneIdentity.publicKey,
    });

    await phoneTransport.connect();
    await desktopTransport.connect();
    desktop.beginHandshake();
    await waitUntil(() => sessionManager.isEstablished && desktop.establishedCount === 1);

    let establishedFiredAgain = false;
    sessionManager.onEstablished(() => {
      establishedFiredAgain = true;
    });
    let rekeysObserved = 0;
    sessionManager.onRekey(() => {
      rekeysObserved += 1;
    });

    const received: BridgeMessage[] = [];
    sessionManager.onMessage((message) => received.push(message));

    // Desktop-driven rekey: a brand new handshake on the same connection.
    // Waiting for the desktop's OWN establishedCount to reach 2 is a
    // deterministic proof the rekey round-trip finished on both ends,
    // unlike re-checking isEstablished (which stays true throughout, since
    // it never resets between the old and new key epochs).
    desktop.beginHandshake();
    await waitUntil(() => desktop.establishedCount === 2);

    // onEstablished should not fire again for a rekey (only for the first establishment).
    expect(establishedFiredAgain).toBe(false);
    // ...but a rekey must still be OBSERVABLE. It is the only evidence the
    // periodic re-handshake is happening at all: because onEstablished stays
    // silent here, anything counting rekeys off it reads 0 forever and looks
    // exactly like a rekey that never fired.
    expect(rekeysObserved).toBe(1);

    desktop.send({ type: 'heartbeat' });
    await waitUntil(() => received.length > 0);
    expect(received[0]).toEqual({ type: 'heartbeat' });
  });

  it('rejects pending capability requests when the transport disconnects', async () => {
    const phoneIdentity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const [phoneTransport, desktopTransport] = createLoopbackPair();

    const sessionManager = new SessionManager({
      identity: phoneIdentity,
      remoteStaticPublicKey: desktopStatic.publicKey,
      transport: phoneTransport,
    });
    sessionManager.start();
    const capabilityClient = new CapabilityClient(sessionManager, 5_000);

    const desktop = new StubSessionInitiator(desktopTransport, {
      desktopStatic,
      phoneStaticPublicKey: phoneIdentity.publicKey,
    });
    await phoneTransport.connect();
    await desktopTransport.connect();
    desktop.beginHandshake();
    await waitUntil(() => sessionManager.isEstablished);

    const requestPromise = capabilityClient.request('read-board', null);
    capabilityClient.rejectAllPending('Channel disconnected');

    await expect(requestPromise).rejects.toThrow('Channel disconnected');
  });

  it('seals an empty Final-tagged frame the desktop tells apart from a message', async () => {
    const { sessionManager, desktop } = await createConnectedRig();
    desktop.beginHandshake();
    await waitUntil(() => sessionManager.isEstablished && desktop.isEstablished);

    sessionManager.sendFinalFrame();
    await flushMicrotasks();

    expect(desktop.finalFrameCount).toBe(1);
    // A Final is not a message: routing it down the message path would have
    // thrown inside the stub (decodeMessage rejects empty bytes) rather than
    // landing here.
    expect(desktop.messages).toHaveLength(0);
    // Saying goodbye does not itself tear the session down; dispose does.
    expect(sessionManager.isEstablished).toBe(true);
  });

  it('sendFinalFrame does not throw or send anything when the session was never established', async () => {
    const { sessionManager, desktop } = await createConnectedRig();

    expect(sessionManager.isEstablished).toBe(false);
    expect(() => sessionManager.sendFinalFrame()).not.toThrow();
    await flushMicrotasks();

    expect(desktop.finalFrameCount).toBe(0);
  });

  it('sendFinalFrame does not throw or send anything when the transport is already closed', async () => {
    const { sessionManager, desktop, phoneTransport } = await createConnectedRig();
    desktop.beginHandshake();
    await waitUntil(() => sessionManager.isEstablished);

    phoneTransport.close();
    expect(phoneTransport.state).toBe('closed');

    // Nothing here called session.reset(), so the key material is still
    // live - only the transport-state guard stands between this and a throw.
    expect(() => sessionManager.sendFinalFrame()).not.toThrow();
    await flushMicrotasks();

    expect(desktop.finalFrameCount).toBe(0);
  });

  /**
   * Pins the crypto ASSUMPTION sendFinalFrame's transport-state guard rests
   * on: seal() advances this direction's counter whether or not the bytes ever
   * leave, and the receiver derives its nonce from its OWN counter, so one
   * undelivered frame makes every later frame fail to open.
   *
   * This test operates on raw secretstream pairs and never calls SessionManager,
   * so it does NOT detect a deleted guard - deleting the guard leaves this
   * green. The test below ('does not burn a send-counter slot...') is the one
   * that fails on that mutation; this one exists so that when it does fail, the
   * reason is already written down.
   */
  it('a sealed-but-undelivered frame desyncs the stream, which is why the guard skips the seal', () => {
    const chainingKey = new Uint8Array(32).fill(7);
    // Same derivation the real peers use: the phone is the responder
    // (sessionManager.ts), the desktop the initiator (stubDesktopPeer.ts).
    const phone = deriveSecretstreamPair(chainingKey, false);
    const desktop = deriveSecretstreamPair(chainingKey, true);

    // Positive control FIRST, so the failure below cannot be mistaken for a
    // mis-derived pair in which every open would throw regardless.
    const delivered = phone.send.seal(new Uint8Array([1, 2, 3]));
    expect(desktop.receive.open(delivered).plaintext).toEqual(new Uint8Array([1, 2, 3]));

    // Now a frame the transport rejected: sealed, counter advanced, never sent.
    phone.send.seal(new Uint8Array(0), FrameTag.Final);
    // The next frame a surviving session would send is now one counter ahead
    // of what the receiver derives its nonce from.
    const afterBurn = phone.send.seal(new Uint8Array([4, 5, 6]));

    expect(() => desktop.receive.open(afterBurn)).toThrow();
  });

  /**
   * The red-green test for the guard itself. The three sendFinalFrame tests
   * above cannot catch its deletion: their only assertions are "does not throw"
   * and "finalFrameCount is 0", and sendFinalFrame's own try/catch keeps both
   * true either way. A burned counter is invisible until the NEXT frame goes
   * out on the same stream, which is what this test does.
   *
   * Verified by mutation: delete `if (this.transport.state !== 'connected')
   * return;` from sendFinalFrame and this test fails (the heartbeat no longer
   * opens on the desktop) while every other test in the suite stays green.
   */
  it('does not burn a send-counter slot when the transport cannot carry the goodbye', async () => {
    const phoneIdentity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const [phoneLoopback, desktopTransport] = createLoopbackPair();
    const phoneTransport = new FlappableTransport(phoneLoopback);

    const sessionManager = new SessionManager({
      identity: phoneIdentity,
      remoteStaticPublicKey: desktopStatic.publicKey,
      transport: phoneTransport,
    });
    sessionManager.start();

    const desktop = new StubSessionInitiator(desktopTransport, {
      desktopStatic,
      phoneStaticPublicKey: phoneIdentity.publicKey,
    });

    await phoneTransport.connect();
    await desktopTransport.connect();
    desktop.beginHandshake();
    await waitUntil(() => sessionManager.isEstablished && desktop.isEstablished);

    // A blip, not a teardown: the session is still established (nothing called
    // reset(), so the key material is live) but the socket cannot carry a frame
    // right now. This is the only state in which the guard does any work.
    phoneTransport.holdDisconnected();
    sessionManager.sendFinalFrame();
    phoneTransport.release();

    sessionManager.send({ type: 'heartbeat' });
    await flushMicrotasks();

    // Guard present: nothing was sealed, the counters still line up, and the
    // heartbeat opens. Guard deleted: sendFinalFrame sealed a frame the
    // transport rejected, so the desktop's receive counter is one behind and
    // this frame fails to open and is dropped.
    expect(desktop.messages).toEqual([{ type: 'heartbeat' }]);
    expect(desktop.finalFrameCount).toBe(0);
  });

  /**
   * The receive side of the goodbye: an inbound Final fires onRemoteClosed
   * and nothing else. The session-level contract deliberately leaves the
   * streams intact (mirroring the desktop's bridge-session) - what to DO
   * about a goodbye is connectionManager's decision, not this layer's.
   */
  it('fires onRemoteClosed when an inbound Final arrives on an established session', async () => {
    const { sessionManager, desktop } = await createConnectedRig();
    const receivedByPhone: BridgeMessage[] = [];
    sessionManager.onMessage((message) => receivedByPhone.push(message));
    let remoteClosedCount = 0;
    sessionManager.onRemoteClosed(() => {
      remoteClosedCount += 1;
    });

    desktop.beginHandshake();
    await waitUntil(() => sessionManager.isEstablished && desktop.isEstablished);

    desktop.sendFinalFrame();
    await waitUntil(() => remoteClosedCount === 1);

    expect(sessionManager.isEstablished).toBe(true);
    expect(receivedByPhone).toEqual([]);
  });

  it('drops a Final that arrives while the session is not established', async () => {
    const { sessionManager, desktop } = await createConnectedRig();
    let remoteClosedCount = 0;
    sessionManager.onRemoteClosed(() => {
      remoteClosedCount += 1;
    });

    desktop.beginHandshake();
    await waitUntil(() => sessionManager.isEstablished && desktop.isEstablished);

    // A backgrounding teardown resets the phone's session while the desktop
    // still holds streams: a goodbye landing in that window must be dropped
    // (no streams to open it under), never fired.
    sessionManager.reset();
    desktop.sendFinalFrame();
    await flushMicrotasks();

    expect(remoteClosedCount).toBe(0);
    expect(sessionManager.isEstablished).toBe(false);
  });
});
