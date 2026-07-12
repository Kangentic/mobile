import { describe, expect, it } from 'vitest';
import { generateX25519KeyPair, type BridgeMessage } from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { CapabilityClient } from '@/channel/capabilityClient';
import { createLoopbackPair } from './helpers/loopbackTransport';
import { StubSessionInitiator } from './helpers/stubDesktopPeer';

function waitFor(predicate: () => boolean): Promise<void> {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve) => {
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      }
    }, 5);
  });
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

    await waitFor(() => sessionManager.isEstablished && desktop.isEstablished);

    desktop.send({ type: 'heartbeat' });
    await waitFor(() => receivedByPhone.length > 0);
    expect(receivedByPhone[0]).toEqual({ type: 'heartbeat' });

    sessionManager.send({ type: 'heartbeat' });
    await waitFor(() => desktop.messages.length > 0);
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
    await waitFor(() => sessionManager.isEstablished && desktop.establishedCount === 1);

    let establishedFiredAgain = false;
    sessionManager.onEstablished(() => {
      establishedFiredAgain = true;
    });

    const received: BridgeMessage[] = [];
    sessionManager.onMessage((message) => received.push(message));

    // Desktop-driven rekey: a brand new handshake on the same connection.
    // Waiting for the desktop's OWN establishedCount to reach 2 is a
    // deterministic proof the rekey round-trip finished on both ends,
    // unlike re-checking isEstablished (which stays true throughout, since
    // it never resets between the old and new key epochs).
    desktop.beginHandshake();
    await waitFor(() => desktop.establishedCount === 2);

    // onEstablished should not fire again for a rekey (only for the first establishment).
    expect(establishedFiredAgain).toBe(false);

    desktop.send({ type: 'heartbeat' });
    await waitFor(() => received.length > 0);
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
    await waitFor(() => sessionManager.isEstablished);

    const requestPromise = capabilityClient.request('read-board', null);
    capabilityClient.rejectAllPending('Channel disconnected');

    await expect(requestPromise).rejects.toThrow('Channel disconnected');
  });
});
