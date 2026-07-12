import type { Unsubscribe, X25519KeyPair } from '@kangentic/protocol';
import { RelayTransport } from './relayTransport';
import { SessionManager } from './sessionManager';
import { CapabilityClient } from './capabilityClient';
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

  private readonly unsubscribeTransportState: Unsubscribe;
  private started = false;

  constructor(options: ChannelControllerOptions) {
    const slotId = deriveSlotId({ kind: 'session', desktopStaticPublicKey: options.desktopStaticPublicKey });
    this.transport = new RelayTransport({ relayUrl: options.relayUrl, slotId });
    this.session = new SessionManager({
      identity: options.identity,
      remoteStaticPublicKey: options.desktopStaticPublicKey,
      transport: this.transport,
    });
    this.capabilities = new CapabilityClient(this.session);

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
    this.capabilities.dispose();
    this.session.dispose();
    this.transport.close();
  }
}

export { RelayTransport, type RelayTransportOptions } from './relayTransport';
export { SessionManager, type SessionManagerOptions } from './sessionManager';
export { CapabilityClient } from './capabilityClient';
export { deriveSlotId, type SlotContext } from './slot';
