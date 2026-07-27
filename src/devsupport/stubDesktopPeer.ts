import {
  createKKHandshake,
  createPairingResponderHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  deriveShortAuthenticationString,
  encodeMessage,
  FrameTag,
  openPairingConfirm,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
  type BridgeEvent,
  type BridgeMessage,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type CipherState,
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
  /** Set once message 2 is written; the phone's confirm frame opens under it. */
  private initiatorToResponder: CipherState | null = null;
  private confirmed = false;

  constructor(transport: Transport, options: StubPairingResponderOptions) {
    this.transport = transport;
    this.handshake = createPairingResponderHandshake({
      localStatic: options.desktopStatic,
      pairingToken: options.pairingToken,
    });
    this.unsubscribe = transport.onFrame((frame) => this.onFrame(frame));
  }

  private onFrame(frame: Uint8Array): void {
    // Phase 2, mirroring PairingService's 'sas-pending': the desktop enrolls
    // the phone only when this sealed frame OPENS, because that is what
    // proves both sides ran the same handshake transcript. Omitting this
    // phase is how a phone that never sent a confirm frame passed every test
    // here while the real desktop waited forever.
    if (this.initiatorToResponder) {
      this.confirmed = openPairingConfirm(this.initiatorToResponder, frame);
      return;
    }
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
    const { message, split } = this.handshake.writeMessage(new Uint8Array(0));
    this.transport.send(message);
    this.sas = deriveShortAuthenticationString(this.handshake.getHandshakeHash());
    if (split) this.initiatorToResponder = split[0];
  }

  getSas(): ShortAuthenticationString | null {
    return this.sas;
  }

  /** True once the phone's confirm frame has arrived AND opened - the desktop's actual "this device is paired" condition. */
  isConfirmed(): boolean {
    return this.confirmed;
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
  private finalFrameCountValue = 0;
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

  /** Counts inbound FrameTag.Final frames - the phone's deliberate goodbye, which the desktop turns into an immediate Offline. */
  get finalFrameCount(): number {
    return this.finalFrameCountValue;
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
    let opened: ReturnType<SecretstreamDirectionPair['receive']['open']>;
    try {
      opened = this.streams.receive.open(payload);
    } catch {
      // A frame that will not open is DROPPED, matching both the real receiver
      // (SessionManager.handleApplicationFrame) and scripts/stubDesktopPeer.mjs.
      // Letting it throw instead would surface a counter desync as an unhandled
      // exception from inside LoopbackTransport's queueMicrotask - which vitest
      // reports as "might cause false positive tests" and which buries the
      // assertion that actually explains the failure.
      return;
    }
    // A Final's plaintext is empty and decodeMessage throws on empty bytes, so
    // without this branch a goodbye frame crashes the peer - and because
    // LoopbackTransport delivers inside queueMicrotask, that throw becomes an
    // unhandled rejection that takes the remaining listeners with it. The real
    // desktop and scripts/stubDesktopPeer.mjs both branch here.
    if (opened.tag === FrameTag.Final) {
      this.finalFrameCountValue += 1;
      return;
    }
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
