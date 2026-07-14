import {
  createKKHandshake,
  createPairingResponderHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  deriveShortAuthenticationString,
  encodeMessage,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
  type BridgeEvent,
  type BridgeMessage,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type HandshakeState,
  type SecretstreamDirectionPair,
  type ShortAuthenticationString,
  type Transport,
  type Unsubscribe,
  type X25519KeyPair,
} from '@kangentic/protocol';

/**
 * A desktop counterpart built on the real @kangentic/protocol, run in the
 * same Node process over a loopback Transport. Because the protocol runs
 * identically on Node and Hermes, this is a faithful stand-in for the
 * desktop's mobile-bridge, not a mock - it mirrors
 * src/main/mobile-bridge/pairing/pairing-service.ts (pairing) and
 * src/main/mobile-bridge/session/bridge-session.ts (session) from the
 * desktop repo.
 */
export interface StubPairingResponderOptions {
  desktopStatic: X25519KeyPair;
  pairingToken: Uint8Array;
}

export class StubPairingResponder {
  private readonly transport: Transport;
  private handshake: HandshakeState;
  private readonly unsubscribe: Unsubscribe;
  private sas: ShortAuthenticationString | null = null;

  constructor(transport: Transport, options: StubPairingResponderOptions) {
    this.transport = transport;
    this.handshake = createPairingResponderHandshake({
      localStatic: options.desktopStatic,
      pairingToken: options.pairingToken,
    });
    this.unsubscribe = transport.onFrame((frame) => this.onFrame(frame));
  }

  private onFrame(frame: Uint8Array): void {
    try {
      this.handshake.readMessage(frame);
    } catch {
      // Mirrors PairingService.fail() + mobile-bridge-service's transport.close()
      // on a bad token or tampered message: the real desktop closes the
      // connection rather than replying, so a wrong-token attempt and a
      // truly absent desktop look identical to the phone.
      this.unsubscribe();
      this.transport.close();
      return;
    }
    const { message } = this.handshake.writeMessage(new Uint8Array(0));
    this.transport.send(message);
    this.sas = deriveShortAuthenticationString(this.handshake.getHandshakeHash());
  }

  getSas(): ShortAuthenticationString | null {
    return this.sas;
  }

  dispose(): void {
    this.unsubscribe();
  }
}

export interface StubSessionInitiatorOptions {
  desktopStatic: X25519KeyPair;
  phoneStaticPublicKey: Uint8Array;
}

/**
 * The desktop always initiates the ongoing-session KK handshake and owns
 * the rekey timer (bridge-session.ts) - the phone is the KK responder. This
 * stub lets tests exercise the phone's sessionManager as a real responder
 * against a real initiator, including a manually triggered rekey.
 */
export class StubSessionInitiator {
  private readonly transport: Transport;
  private readonly desktopStatic: X25519KeyPair;
  private readonly phoneStaticPublicKey: Uint8Array;
  private handshake: HandshakeState | null = null;
  private streams: SecretstreamDirectionPair | null = null;
  private readonly unsubscribe: Unsubscribe;
  private readonly receivedMessages: BridgeMessage[] = [];
  private establishedCountValue = 0;
  private requestHandler: ((request: CapabilityRequestMessage) => CapabilityResponseMessage | null) | null = null;

  constructor(transport: Transport, options: StubSessionInitiatorOptions) {
    this.transport = transport;
    this.desktopStatic = options.desktopStatic;
    this.phoneStaticPublicKey = options.phoneStaticPublicKey;
    this.unsubscribe = transport.onFrame((frame) => this.onFrame(frame));
  }

  get isEstablished(): boolean {
    return this.streams !== null;
  }

  /** Increments every time a handshake round (initial or rekey) completes - a deterministic signal tests can wait on. */
  get establishedCount(): number {
    return this.establishedCountValue;
  }

  get messages(): readonly BridgeMessage[] {
    return this.receivedMessages;
  }

  beginHandshake(): void {
    this.handshake = createKKHandshake({
      initiator: true,
      localStatic: this.desktopStatic,
      remoteStatic: this.phoneStaticPublicKey,
    });
    const { message } = this.handshake.writeMessage(new Uint8Array(0));
    this.transport.send(wrapSessionFrame(SessionFrameKind.Handshake, message));
  }

  send(message: BridgeMessage): void {
    if (!this.streams) throw new Error('StubSessionInitiator is not established yet');
    const frame = this.streams.send.seal(encodeMessage(message));
    this.transport.send(wrapSessionFrame(SessionFrameKind.Application, frame));
  }

  /** Pushes one feed event to the phone, the way the desktop's sendEvent() does. */
  emitEvent(event: BridgeEvent): void {
    this.send({ type: 'event', event });
  }

  /**
   * Auto-answers decoded capability-requests, mirroring the desktop's
   * CapabilityRouter dispatch. Return null to leave a request unanswered
   * (for timeout tests). Requests still land in `messages` either way.
   */
  setRequestHandler(handler: ((request: CapabilityRequestMessage) => CapabilityResponseMessage | null) | null): void {
    this.requestHandler = handler;
  }

  private onFrame(rawFrame: Uint8Array): void {
    const { kind, payload } = unwrapSessionFrame(rawFrame);
    if (kind === SessionFrameKind.Handshake) {
      this.handleHandshakeFrame(payload);
    } else {
      this.handleApplicationFrame(payload);
    }
  }

  private handleHandshakeFrame(payload: Uint8Array): void {
    if (!this.handshake) return;
    const result = this.handshake.readMessage(payload);
    if (!result.split) return;
    const chainingKey = this.handshake.getChainingKey();
    this.streams = deriveSecretstreamPair(chainingKey, true);
    this.handshake = null;
    this.establishedCountValue += 1;
  }

  private handleApplicationFrame(payload: Uint8Array): void {
    if (!this.streams) return;
    const opened = this.streams.receive.open(payload);
    const message = decodeMessage(opened.plaintext);
    this.receivedMessages.push(message);
    if (message.type === 'capability-request' && this.requestHandler) {
      const response = this.requestHandler(message);
      if (response) this.send(response);
    }
  }

  dispose(): void {
    this.unsubscribe();
  }
}
