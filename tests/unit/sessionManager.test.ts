import { describe, expect, it } from 'vitest';
import { deriveSecretstreamPair, FrameTag, generateX25519KeyPair, type BridgeMessage, type Transport } from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { CapabilityClient } from '@/channel/capabilityClient';
import { createLoopbackPair, type LoopbackTransport } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { flushMicrotasks, waitUntil } from '../helpers/async';
import { ArmableTransport, FlappableTransport, RecordingTransport } from '../helpers/transports';

interface SessionRig<PhoneTransport extends Transport = LoopbackTransport> {
  sessionManager: SessionManager;
  desktop: StubSessionInitiator;
  phoneTransport: PhoneTransport;
}

/**
 * Connected transports and a started SessionManager, but NO handshake -
 * callers drive establishment themselves. The phone's side of the loopback
 * goes through `wrap` (FlappableTransport, ArmableTransport) so a test can
 * stage the one socket failure it is about, with the wrapper still behaving
 * normally at return.
 */
async function createConnectedWrappedRig<PhoneTransport extends Transport>(
  wrap: (inner: LoopbackTransport) => PhoneTransport,
): Promise<SessionRig<PhoneTransport>> {
  const phoneIdentity = generateX25519KeyPair();
  const desktopStatic = generateX25519KeyPair();
  const [phoneLoopback, desktopTransport] = createLoopbackPair();
  const phoneTransport = wrap(phoneLoopback);

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

/** The unwrapped rig: a plain loopback on the phone's side, still NO handshake. */
function createConnectedRig(): Promise<SessionRig> {
  return createConnectedWrappedRig((inner) => inner);
}

/** Like createConnectedWrappedRig, with the session ESTABLISHED at return. */
async function createEstablishedWrappedRig<PhoneTransport extends Transport>(
  wrap: (inner: LoopbackTransport) => PhoneTransport,
): Promise<SessionRig<PhoneTransport>> {
  const rig = await createConnectedWrappedRig(wrap);
  rig.desktop.beginHandshake();
  await waitUntil(() => rig.sessionManager.isEstablished && rig.desktop.isEstablished);
  return rig;
}

/**
 * A phone-to-desktop message that is NOT a heartbeat. The session answers
 * every inbound heartbeat with a heartbeat of its own, so a test that sends
 * one from the phone after delivering one to it cannot tell its own frame
 * from the reply in desktop.messages. The stub records a request it has no
 * handler for without answering it.
 */
const probeRequest: BridgeMessage = { type: 'capability-request', requestId: 'probe-1', verb: 'read-board', payload: null };

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

    // Phone to desktop first, and not a heartbeat: this used to send a
    // heartbeat AFTER receiving one, and once the session began answering
    // heartbeats the assertion on desktop.messages[0] stayed green while
    // reading the reply instead of the frame under test.
    sessionManager.send(probeRequest);
    await waitUntil(() => desktop.messages.length > 0);
    expect(desktop.messages).toEqual([probeRequest]);

    desktop.send({ type: 'heartbeat' });
    await waitUntil(() => receivedByPhone.length > 0);
    expect(receivedByPhone).toEqual([{ type: 'heartbeat' }]);
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
   * return;` from sendBestEffort (the guarded send sendFinalFrame delegates
   * to) and this test fails (the probe no longer opens on the desktop) while
   * every test not about that guard stays green.
   */
  it('does not burn a send-counter slot when the transport cannot carry the goodbye', async () => {
    const { sessionManager, desktop, phoneTransport } = await createEstablishedWrappedRig((inner) => new FlappableTransport(inner));

    // A blip, not a teardown: the session is still established (nothing called
    // reset(), so the key material is live) but the socket cannot carry a frame
    // right now. This is the only state in which the guard does any work.
    phoneTransport.holdDisconnected();
    sessionManager.sendFinalFrame();
    phoneTransport.release();

    sessionManager.send(probeRequest);
    await flushMicrotasks();

    // Guard present: nothing was sealed, the counters still line up, and the
    // probe opens. Guard deleted: sendFinalFrame sealed a frame the
    // transport rejected, so the desktop's receive counter is one behind and
    // this frame fails to open and is dropped.
    expect(desktop.messages).toEqual([probeRequest]);
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

/**
 * The desktop's cheap liveness probe. Its only answered probe used to be a KK
 * msg1 (a rekey), which bounds dead-socket detection to the ~120s rekey
 * cadence plus the presence budget and costs any request in flight. A
 * heartbeat is one sealed frame each way on the streams already up.
 */
describe('SessionManager heartbeat reply', () => {
  /**
   * Nothing is sent from this test body, so the one frame the desktop opens
   * can only be the session's own reply. Red first: comment out the
   * `if (message.type === 'heartbeat')` line in handleApplicationFrame and
   * the waitUntil times out with desktop.messages empty.
   */
  it('answers an inbound heartbeat with exactly one heartbeat, on the streams already up', async () => {
    const { sessionManager, desktop } = await createConnectedRig();
    const receivedByPhone: BridgeMessage[] = [];
    sessionManager.onMessage((message) => receivedByPhone.push(message));
    desktop.beginHandshake();
    await waitUntil(() => sessionManager.isEstablished && desktop.establishedCount === 1);

    desktop.send({ type: 'heartbeat' });
    await waitUntil(() => desktop.messages.length > 0, { label: 'heartbeat reply' });
    await flushMicrotasks();

    expect(desktop.messages).toEqual([{ type: 'heartbeat' }]);
    // The reply opened under the streams the probe arrived on: no handshake
    // round happened, and it was a message, not a goodbye.
    expect(desktop.establishedCount).toBe(1);
    expect(desktop.finalFrameCount).toBe(0);
    // The probe still reaches subscribers after the reply, so a future
    // liveness observer on the phone can see it too.
    expect(receivedByPhone).toEqual([{ type: 'heartbeat' }]);
  });

  it('answers under the keys a rekey just installed', async () => {
    const { sessionManager, desktop } = await createConnectedRig();
    desktop.beginHandshake();
    await waitUntil(() => sessionManager.isEstablished && desktop.establishedCount === 1);
    desktop.beginHandshake();
    await waitUntil(() => desktop.establishedCount === 2);

    // A reply sealed under the retired streams would fail to open on the
    // desktop and be dropped, leaving desktop.messages empty.
    desktop.send({ type: 'heartbeat' });
    await waitUntil(() => desktop.messages.length > 0, { label: 'heartbeat reply after rekey' });
    await flushMicrotasks();

    expect(desktop.messages).toEqual([{ type: 'heartbeat' }]);
    expect(desktop.establishedCount).toBe(2);
  });

  /**
   * Mirror of the goodbye guard test above, for the reply path. The probe
   * itself still arrives while held (FlappableTransport holds only the
   * outbound direction), and receivedByPhone proves it did, so the test
   * cannot pass vacuously on a probe that never reached the session.
   *
   * Verified by mutation: delete `if (this.transport.state !== 'connected')
   * return;` from sendBestEffort and this test fails (the probe request no
   * longer opens on the desktop, because the reply's seal burned a counter
   * slot on a frame the transport rejected).
   */
  it('does not burn a send-counter slot when the transport cannot carry the reply', async () => {
    const { sessionManager, desktop, phoneTransport } = await createEstablishedWrappedRig((inner) => new FlappableTransport(inner));
    const receivedByPhone: BridgeMessage[] = [];
    sessionManager.onMessage((message) => receivedByPhone.push(message));

    phoneTransport.holdDisconnected();
    desktop.send({ type: 'heartbeat' });
    await waitUntil(() => receivedByPhone.length === 1, { label: 'probe delivered while held' });
    phoneTransport.release();

    sessionManager.send(probeRequest);
    await flushMicrotasks();

    // The reply was skipped, not sealed-and-lost: the next frame still opens,
    // and no heartbeat ever reached the desktop.
    expect(desktop.messages).toEqual([probeRequest]);
  });

  /**
   * The other failure the guarded send exists for: transport.send throws
   * while `state` still reads 'connected'. The reply fires inside the
   * session's own frame handler, BEFORE the onMessage fan-out, so an escaping
   * throw would abort delivery to every subscriber (FeedRouter,
   * CapabilityClient) for that frame - and under LoopbackTransport's
   * queueMicrotask delivery it surfaces as an unhandled error, which is how
   * vitest reports this test failing under mutation: delete sendBestEffort's
   * try/catch and receivedByPhone stays empty.
   *
   * The phone's SEND counter is one ahead after this (the seal happened, the
   * bytes did not leave), which is the real socket-drop case: the transport
   * leaves 'connected' next and ChannelController resets the session. Only
   * the RECEIVE direction is asserted intact here.
   */
  it('a reply whose send throws does not abort delivery to message listeners', async () => {
    const { sessionManager, desktop, phoneTransport } = await createEstablishedWrappedRig((inner) => new ArmableTransport(inner));
    const receivedByPhone: BridgeMessage[] = [];
    sessionManager.onMessage((message) => receivedByPhone.push(message));

    phoneTransport.armThrowOnNextSend();
    desktop.send({ type: 'heartbeat' });
    await waitUntil(() => receivedByPhone.length === 1, { label: 'probe delivered despite the throwing reply' });

    expect(receivedByPhone).toEqual([{ type: 'heartbeat' }]);
    expect(desktop.messages).toEqual([]);

    // Inbound keeps flowing: the throw touched nothing on the receive side.
    desktop.emitEvent({ kind: 'diff', taskId: 'task-1', payload: null });
    await waitUntil(() => receivedByPhone.length === 2, { label: 'next inbound frame after the throw' });
    expect(receivedByPhone[1]).toEqual({ type: 'event', event: { kind: 'diff', taskId: 'task-1', payload: null } });
  });

  /**
   * Pins the ORDER the code comment on the heartbeat line claims, not just the
   * eventual outcome: the reply must leave the transport BEFORE any message
   * listener runs, so a throwing or slow subscriber cannot suppress it. A
   * RecordingTransport counts send() calls; the listener records that count
   * the moment it runs, and desktop.messages proves the one send counted was
   * the reply itself (nothing else was sent in this test).
   *
   * Verified by mutation: swap the two lines in handleApplicationFrame (the
   * fan-out loop before the sendBestEffort call). The listener then runs
   * before the reply is sealed, so the recorded count equals the baseline
   * instead of baseline + 1, and the test fails on
   * `expect(sendCountWhenListenerRan).toBe(sendCountBeforeProbe + 1)`.
   */
  it('sends the heartbeat reply before the message fan-out reaches any listener', async () => {
    const { sessionManager, desktop, phoneTransport } = await createEstablishedWrappedRig((inner) => new RecordingTransport(inner));
    // Baseline AFTER establishment: the handshake reply itself is one send on
    // this same transport, so the probe's effect has to be measured as a
    // delta from here, not as an absolute count.
    const sendCountBeforeProbe = phoneTransport.sendCount;
    let sendCountWhenListenerRan: number | null = null;
    sessionManager.onMessage(() => {
      sendCountWhenListenerRan = phoneTransport.sendCount;
    });

    desktop.send({ type: 'heartbeat' });
    await waitUntil(() => sendCountWhenListenerRan !== null, { label: 'listener observed the probe' });

    expect(sendCountWhenListenerRan).toBe(sendCountBeforeProbe + 1);
    // Proves the one send the listener saw was the reply, not some other frame.
    expect(desktop.messages).toEqual([{ type: 'heartbeat' }]);
  });

  /**
   * The false branch of `message.type === 'heartbeat'`: every existing test
   * that checks desktop.messages after a desktop-to-phone frame sends a
   * heartbeat, so this guard has never been exercised with a message that
   * is not one. A non-heartbeat inbound message must still reach the
   * listener fan-out, and must produce no reply at all.
   *
   * Verified by mutation: drop the `if (message.type === 'heartbeat')` guard
   * (make the sendBestEffort call unconditional). desktop.messages then
   * holds `[{ type: 'heartbeat' }]` instead of `[]`, and the test fails on
   * `expect(desktop.messages).toEqual([])` with "expected [{ type:
   * 'heartbeat' }] to equal []".
   */
  it('does not reply to a non-heartbeat inbound message', async () => {
    const { sessionManager, desktop } = await createConnectedRig();
    const receivedByPhone: BridgeMessage[] = [];
    sessionManager.onMessage((message) => receivedByPhone.push(message));
    desktop.beginHandshake();
    await waitUntil(() => sessionManager.isEstablished && desktop.establishedCount === 1);

    desktop.emitEvent({ kind: 'diff', taskId: 'task-1', payload: null });
    await waitUntil(() => receivedByPhone.length > 0, { label: 'non-heartbeat delivered to the phone' });
    await flushMicrotasks();

    expect(desktop.messages).toEqual([]);
    expect(desktop.finalFrameCount).toBe(0);
  });
});
