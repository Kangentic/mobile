import type { Unsubscribe, X25519KeyPair } from '@kangentic/protocol';
import { RelayTransport } from './relayTransport';
import { SessionManager } from './sessionManager';
import { CapabilityClient } from './capabilityClient';
import { FeedRouter } from './feedRouter';
import { VerbClient } from './verbClient';
import { deriveSlotId } from './slot';

export interface ChannelControllerOptions {
  identity: X25519KeyPair;
  /** Pinned from the trust anchor at pairing time - never trust-on-first-use. */
  desktopStaticPublicKey: Uint8Array;
  relayUrl: string;
}

/**
 * Composes the relay transport, the KK session (responder), and capability
 * request/response correlation into the one object a screen needs. Wires
 * the "transport resumes, crypto restarts" reconnect model: whenever the
 * transport leaves 'connected', session key material is dropped and every
 * in-flight capability request is rejected, since a fresh handshake
 * invalidates both.
 */
export class ChannelController {
  readonly transport: RelayTransport;
  readonly session: SessionManager;
  readonly capabilities: CapabilityClient;
  readonly feed: FeedRouter;
  readonly verbs: VerbClient;

  private readonly unsubscribeTransportState: Unsubscribe;
  private started = false;

  constructor(options: ChannelControllerOptions) {
    const slotId = deriveSlotId({
      kind: 'session',
      desktopStaticPublicKey: options.desktopStaticPublicKey,
      phoneStaticPublicKey: options.identity.publicKey,
    });
    this.transport = new RelayTransport({ relayUrl: options.relayUrl, slotId });
    this.session = new SessionManager({
      identity: options.identity,
      remoteStaticPublicKey: options.desktopStaticPublicKey,
      transport: this.transport,
    });
    this.capabilities = new CapabilityClient(this.session);
    this.feed = new FeedRouter(this.session);
    this.verbs = new VerbClient(this.capabilities);

    this.unsubscribeTransportState = this.transport.onStateChange((state) => {
      if (state !== 'connected') {
        this.session.reset();
        this.capabilities.rejectAllPending('Channel disconnected');
      }
    });
  }

  async connect(): Promise<void> {
    // session.start() throws if called twice; a retry-connect should only
    // re-dial the transport, not re-arm the already-running session.
    if (!this.started) {
      this.session.start();
      this.started = true;
    }
    await this.transport.connect();
  }

  dispose(): void {
    this.unsubscribeTransportState();
    this.feed.dispose();
    this.capabilities.dispose();
    this.session.dispose();
    this.transport.close();
  }
}

export { RelayTransport, type RelayTransportOptions } from './relayTransport';
export { SessionManager, type SessionManagerOptions } from './sessionManager';
export { CapabilityClient } from './capabilityClient';
export { FeedRouter } from './feedRouter';
export { VerbClient, CapabilityError, type ReadDiffFileListInput, type ReadDiffFileContentInput } from './verbClient';
export { SubscriptionManager, type SubscriptionManagerOptions, type SubscriptionSnapshotSinks } from './subscriptionManager';
export { deriveSlotId, type SlotContext } from './slot';
