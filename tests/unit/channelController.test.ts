import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair, type Transport, type TransportState, type Unsubscribe } from '@kangentic/protocol';
import { ChannelController } from '@/channel';
import { createLoopbackPair, type LoopbackTransport } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { flushMicrotasks, waitUntil } from '../helpers/async';

interface ControllerRig {
  controller: ChannelController;
  desktop: StubSessionInitiator;
}

/**
 * Wraps a real (connected) LoopbackTransport and, once armed, makes exactly
 * ONE send() throw instead of forwarding - "the socket dropped between the
 * state check and the send" that sendFinalFrame's own doc comment names.
 * Deliberately the inverse of sessionManager.test.ts's FlappableTransport,
 * which throws while NOT connected; this one throws while `state` still
 * reads 'connected', which is the only way to drive sendFinalFrame's seal
 * call to succeed and its transport.send() call to fail.
 */
class ArmableTransport implements Transport {
  private armed = false;
  closeCalled = false;

  constructor(private readonly inner: LoopbackTransport) {}

  get state(): TransportState {
    return this.inner.state;
  }

  armThrowOnNextSend(): void {
    this.armed = true;
  }

  async connect(): Promise<void> {
    await this.inner.connect();
  }

  send(frame: Uint8Array): void {
    if (this.armed) {
      this.armed = false;
      throw new Error('ArmableTransport: simulated socket drop between the state check and the send');
    }
    this.inner.send(frame);
  }

  close(): void {
    this.closeCalled = true;
    this.inner.close();
  }

  onFrame(listener: (frame: Uint8Array) => void): Unsubscribe {
    return this.inner.onFrame(listener);
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    return this.inner.onStateChange(listener);
  }
}

/**
 * Establishes a ChannelController over a plain loopback pair (no mockDesktop
 * wrapper): LoopbackTransport.close() queues the peer's close AFTER the
 * send-delivery microtask, so a Final sealed just before dispose() still
 * lands. This is deliberately NOT the mockDesktop-based rig used elsewhere -
 * mockDesktop.dispose() closes the desktop transport synchronously and would
 * swallow the very frame these tests exist to prove.
 */
async function createEstablishedController(): Promise<ControllerRig> {
  const identity = generateX25519KeyPair();
  const desktopStatic = generateX25519KeyPair();
  const [phoneTransport, desktopTransport] = createLoopbackPair();

  const controller = new ChannelController({
    identity,
    desktopStaticPublicKey: desktopStatic.publicKey,
    relayUrl: 'loopback://test',
    transport: phoneTransport,
  });

  const desktop = new StubSessionInitiator(desktopTransport, {
    desktopStatic,
    phoneStaticPublicKey: identity.publicKey,
  });

  await controller.connect();
  await desktopTransport.connect();
  desktop.beginHandshake();
  await waitUntil(() => controller.session.isEstablished && desktop.isEstablished, {
    label: 'controller and stub desktop both established',
  });

  return { controller, desktop };
}

describe('ChannelController.dispose', () => {
  it('sends a Final frame before the transport closes when the teardown is deliberate', async () => {
    const { controller, desktop } = await createEstablishedController();

    controller.dispose({ sendFinalFrame: true });
    await flushMicrotasks();

    expect(desktop.finalFrameCount).toBe(1);
    expect(desktop.messages).toHaveLength(0);
  });

  it('sends nothing on an ordinary dispose', async () => {
    const { controller, desktop } = await createEstablishedController();

    controller.dispose();
    await flushMicrotasks();

    expect(desktop.finalFrameCount).toBe(0);
  });

  it('does not throw when a deliberate dispose lands on a connection that never established', async () => {
    const identity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const [phoneTransport] = createLoopbackPair();

    const controller = new ChannelController({
      identity,
      desktopStaticPublicKey: desktopStatic.publicKey,
      relayUrl: 'loopback://test',
      transport: phoneTransport,
    });

    expect(() => controller.dispose({ sendFinalFrame: true })).not.toThrow();
  });

  it('is safe to dispose twice', async () => {
    const { controller, desktop } = await createEstablishedController();

    controller.dispose({ sendFinalFrame: true });
    await flushMicrotasks();
    expect(() => controller.dispose({ sendFinalFrame: true })).not.toThrow();
    await flushMicrotasks();

    expect(desktop.finalFrameCount).toBe(1);
  });

  /**
   * None of the tests above ever reach sendFinalFrame's try/catch: "never
   * established" and "transport already closed" both return at an earlier
   * guard, and the happy path's seal-and-send both succeed. This is the one
   * that drives the socket-drops-between-the-check-and-the-send case the
   * catch's own comment names, and it is a real dispose-chain hazard, not a
   * hypothetical: without the catch, the escaping error would abandon
   * everything after sendFinalFrame() in ChannelController.dispose() - the
   * transport would never close and the session's key material would never
   * be dropped, which is exactly the orphan-connection shape
   * connectionManager.ts's teardownThisAttempt comment warns about.
   *
   * Verified by mutation: delete the try/catch in sendFinalFrame (keep the
   * two statements in its body unwrapped) and this test fails - the seal
   * succeeds, transport.send() throws, and the throw now escapes dispose()
   * uncaught, so the `.not.toThrow()` assertion below reddens (which is also
   * why close() would never run and isEstablished would stay true, though
   * those two assertions never get the chance to execute once the first
   * one fails). Revert restores green.
   */
  it('does not throw and still completes the dispose chain when the socket drops between the state check and the send', async () => {
    const identity = generateX25519KeyPair();
    const desktopStatic = generateX25519KeyPair();
    const [phoneLoopback, desktopTransport] = createLoopbackPair();
    const phoneTransport = new ArmableTransport(phoneLoopback);

    const controller = new ChannelController({
      identity,
      desktopStaticPublicKey: desktopStatic.publicKey,
      relayUrl: 'loopback://test',
      transport: phoneTransport,
    });

    const desktop = new StubSessionInitiator(desktopTransport, {
      desktopStatic,
      phoneStaticPublicKey: identity.publicKey,
    });

    await controller.connect();
    await desktopTransport.connect();
    desktop.beginHandshake();
    await waitUntil(() => controller.session.isEstablished && desktop.isEstablished, {
      label: 'controller and stub desktop both established',
    });

    // state still reads 'connected' (the guard passes and the seal succeeds),
    // but the very next transport.send() - the goodbye itself - throws.
    phoneTransport.armThrowOnNextSend();

    expect(() => controller.dispose({ sendFinalFrame: true })).not.toThrow();

    // The rest of the dispose chain ran despite the swallowed throw.
    expect(phoneTransport.closeCalled).toBe(true);
    expect(controller.session.isEstablished).toBe(false);
  });
});
