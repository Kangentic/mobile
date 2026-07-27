import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair } from '@kangentic/protocol';
import { ChannelController } from '@/channel';
import { createLoopbackPair } from '@/devsupport/loopbackTransport';
import { StubSessionInitiator } from '@/devsupport/stubDesktopPeer';
import { flushMicrotasks, waitUntil } from '../helpers/async';

interface ControllerRig {
  controller: ChannelController;
  desktop: StubSessionInitiator;
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
});
