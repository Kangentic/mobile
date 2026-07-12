import {
  createKKHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  encodeMessage,
  FrameTag,
  MAX_FRAME_LENGTH,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
  type BridgeMessage,
  type SecretstreamDirectionPair,
  type Transport,
  type Unsubscribe,
  type X25519KeyPair,
} from '@kangentic/protocol';

export interface SessionManagerOptions {
  identity: X25519KeyPair;
  /** The desktop's static public key, pinned from the trust anchor - never trust-on-first-use. */
  remoteStaticPublicKey: Uint8Array;
  transport: Transport;
}

/**
 * The ongoing-session KK driver, as the RESPONDER: the desktop always
 * initiates the handshake and owns the ~2 minute re-handshake timer
 * (src/main/mobile-bridge/session/bridge-session.ts), so the phone only
 * ever reacts to an inbound Handshake frame - the very first one and every
 * later peer-initiated rekey look identical from here. Each round
 * completes synchronously within one onFrame call (KK is exactly two
 * messages), so there is no persistent in-progress handshake state to
 * track between frames.
 */
export class SessionManager {
  private readonly identity: X25519KeyPair;
  private readonly remoteStaticPublicKey: Uint8Array;
  private readonly transport: Transport;

  private streams: SecretstreamDirectionPair | null = null;
  private unsubscribeFrame: Unsubscribe | null = null;
  private readonly messageListeners = new Set<(message: BridgeMessage) => void>();
  private readonly establishedListeners = new Set<() => void>();
  private readonly remoteClosedListeners = new Set<() => void>();

  constructor(options: SessionManagerOptions) {
    this.identity = options.identity;
    this.remoteStaticPublicKey = options.remoteStaticPublicKey;
    this.transport = options.transport;
  }

  get isEstablished(): boolean {
    return this.streams !== null;
  }

  start(): void {
    if (this.unsubscribeFrame) throw new Error('SessionManager.start() called twice');
    this.unsubscribeFrame = this.transport.onFrame((frame) => this.onFrame(frame));
  }

  onMessage(listener: (message: BridgeMessage) => void): Unsubscribe {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onEstablished(listener: () => void): Unsubscribe {
    this.establishedListeners.add(listener);
    return () => this.establishedListeners.delete(listener);
  }

  onRemoteClosed(listener: () => void): Unsubscribe {
    this.remoteClosedListeners.add(listener);
    return () => this.remoteClosedListeners.delete(listener);
  }

  send(message: BridgeMessage): void {
    if (!this.streams) throw new Error('SessionManager is not established yet');
    const encoded = encodeMessage(message);
    if (encoded.length > MAX_FRAME_LENGTH) {
      throw new Error(`Message exceeds MAX_FRAME_LENGTH (${encoded.length} > ${MAX_FRAME_LENGTH})`);
    }
    const frame = this.streams.send.seal(encoded);
    this.transport.send(wrapSessionFrame(SessionFrameKind.Application, frame));
  }

  /** Drops session key material without touching the transport - call this when the transport disconnects, before a reconnect drives a fresh handshake. */
  reset(): void {
    this.streams = null;
  }

  dispose(): void {
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = null;
    this.streams = null;
  }

  private onFrame(rawFrame: Uint8Array): void {
    let unwrapped: { kind: SessionFrameKind; payload: Uint8Array };
    try {
      unwrapped = unwrapSessionFrame(rawFrame);
    } catch {
      return;
    }
    if (unwrapped.kind === SessionFrameKind.Handshake) {
      this.handleHandshakeFrame(unwrapped.payload);
    } else {
      this.handleApplicationFrame(unwrapped.payload);
    }
  }

  private handleHandshakeFrame(payload: Uint8Array): void {
    const handshake = createKKHandshake({
      initiator: false,
      localStatic: this.identity,
      remoteStatic: this.remoteStaticPublicKey,
    });

    try {
      handshake.readMessage(payload);
    } catch {
      // Malformed or unauthenticated message 1 - drop silently. The
      // desktop drives re-handshakes on its own timer, so there is
      // nothing productive to retry from here.
      return;
    }

    let writeResult: ReturnType<typeof handshake.writeMessage>;
    try {
      writeResult = handshake.writeMessage(new Uint8Array(0));
    } catch {
      return;
    }
    try {
      this.transport.send(wrapSessionFrame(SessionFrameKind.Handshake, writeResult.message));
    } catch {
      // Transport dropped between reading message 1 and writing the reply;
      // drop silently, consistent with the rest of this method. The desktop
      // re-drives the handshake on reconnect.
      return;
    }

    if (!writeResult.split) {
      // KK is exactly two messages; the responder's message 2 write always splits.
      return;
    }

    const chainingKey = handshake.getChainingKey();
    const wasEstablished = this.streams !== null;
    this.streams = deriveSecretstreamPair(chainingKey, false);
    if (!wasEstablished) {
      for (const listener of this.establishedListeners) listener();
    }
  }

  private handleApplicationFrame(payload: Uint8Array): void {
    if (!this.streams) return;
    let opened: ReturnType<SecretstreamDirectionPair['receive']['open']>;
    try {
      opened = this.streams.receive.open(payload);
    } catch {
      return;
    }
    if (opened.tag === FrameTag.Final) {
      for (const listener of this.remoteClosedListeners) listener();
      return;
    }
    let message: BridgeMessage;
    try {
      message = decodeMessage(opened.plaintext);
    } catch {
      return;
    }
    for (const listener of this.messageListeners) listener(message);
  }
}
