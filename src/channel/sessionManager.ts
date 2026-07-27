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
  private readonly rekeyListeners = new Set<() => void>();
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

  /**
   * Fires on every re-handshake that lands on an already-established session
   * (the desktop's ~2 minute WireGuard-style rekey). Separate from
   * onEstablished on purpose: a rekey must not look like a fresh connection.
   */
  onRekey(listener: () => void): Unsubscribe {
    this.rekeyListeners.add(listener);
    return () => this.rekeyListeners.delete(listener);
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

  /**
   * Best-effort goodbye on a DELIBERATE teardown: an empty Final-tagged frame
   * tells the desktop this phone is leaving on purpose, so its Mobile Devices
   * badge flips to Offline at once instead of waiting out the reconnect grace
   * plus two presence probes (~12s). An involuntary teardown (app killed,
   * phone off, network gone) cannot reach here at all, which is exactly why
   * the desktop's probe path stays load-bearing.
   *
   * Deliberately NOT a tag parameter on send(): a Final carries no
   * BridgeMessage (its plaintext is empty, and decodeMessage throws on empty
   * bytes), send() throws by contract when unestablished - the opposite of
   * what a teardown path needs - and MAX_FRAME_LENGTH is vacuous for zero
   * bytes. Three of send()'s four behaviours are wrong here.
   *
   * Never throws. It runs as the first line of a dispose chain, and an
   * escaping error would abandon the rest of that teardown with the transport
   * still live - see the orphan-connection failure connectionManager.ts
   * documents around its teardownThisAttempt.
   */
  sendFinalFrame(): void {
    if (!this.streams) return;
    // Only seal when the frame can actually leave: seal advances this
    // direction's counter, and burning a counter slot on a frame the
    // transport rejects desyncs us from the desktop's receive counter.
    if (this.transport.state !== 'connected') return;
    try {
      const frame = this.streams.send.seal(new Uint8Array(0), FrameTag.Final);
      this.transport.send(wrapSessionFrame(SessionFrameKind.Application, frame));
    } catch {
      // The socket dropped between the state check and the send. Nothing
      // productive to retry - the desktop's probes cover this exact case.
      // Same swallow as handleHandshakeFrame's transport.send below.
    }
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
      return;
    }
    // A rekey: new key epoch on a session that was already up. Deliberately
    // NOT reported through onEstablished - subscriptions and streams survive
    // a rekey untouched, and re-firing it would reset them (see
    // subscriptionManager). This is the only signal a rekey happened at all.
    for (const listener of this.rekeyListeners) listener();
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
