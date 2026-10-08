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
  type SecretstreamState,
  type Transport,
  type Unsubscribe,
  type X25519KeyPair,
} from '@kangentic/protocol';
import { connectionTraceEnabled, retiredReceiveStreamsEnabled, traceConnection } from '@/devsupport/connectionTrace';
import { ReceiveStreams } from './receiveStreams';

/**
 * A decoded inbound message plus, in a trace build only, when its frame reached
 * JS (Date.now() at the top of onFrame, before unwrap and decrypt). Null in
 * every other build, so a store build adds no per-frame clock read. It is the
 * T4 of RFC 5905's round-trip delay, read by CapabilityClient's request
 * timing. React Native's WebSocket base64-decodes a binary message before
 * onmessage runs and carries no native timestamp, so the native-to-JS queue
 * wait falls on the wire side of this stamp, not the phone side.
 */
export type MessageListener = (message: BridgeMessage, arrivedAtMs: number | null) => void;

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
 *
 * It also answers the desktop's heartbeats (handleApplicationFrame), so the
 * desktop can probe liveness with one sealed frame instead of a rekey.
 *
 * The two directions switch keys at different moments. SEND switches the
 * moment msg2 is written: in-order delivery puts msg2 ahead of anything sealed
 * after it, so the desktop has always installed the new keys before it reads
 * one. RECEIVE keeps the superseded streams too (ReceiveStreams), because the
 * desktop goes on sealing under the old keys until msg2 reaches it.
 */
export class SessionManager {
  private readonly identity: X25519KeyPair;
  private readonly remoteStaticPublicKey: Uint8Array;
  private readonly transport: Transport;

  private sendStream: SecretstreamState | null = null;
  private readonly receiveStreams = new ReceiveStreams();
  /**
   * Trace-line state, all of it per establishment: zeroed by every fresh
   * handshake, so a count never carries over from a session that is gone.
   * `lastRekeyAtMs` stays null until a rekey lands on this establishment.
   */
  private lastRekeyAtMs: number | null = null;
  private retiredOpenCount = 0;
  private failedOpenCount = 0;
  private unsubscribeFrame: Unsubscribe | null = null;
  private readonly messageListeners = new Set<MessageListener>();
  private readonly establishedListeners = new Set<() => void>();
  private readonly rekeyListeners = new Set<() => void>();
  private readonly remoteClosedListeners = new Set<() => void>();

  constructor(options: SessionManagerOptions) {
    this.identity = options.identity;
    this.remoteStaticPublicKey = options.remoteStaticPublicKey;
    this.transport = options.transport;
  }

  get isEstablished(): boolean {
    return this.sendStream !== null;
  }

  start(): void {
    if (this.unsubscribeFrame) throw new Error('SessionManager.start() called twice');
    this.unsubscribeFrame = this.transport.onFrame((frame) => this.onFrame(frame));
  }

  onMessage(listener: MessageListener): Unsubscribe {
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
    if (!this.sendStream) throw new Error('SessionManager is not established yet');
    const encoded = encodeMessage(message);
    if (encoded.length > MAX_FRAME_LENGTH) {
      throw new Error(`Message exceeds MAX_FRAME_LENGTH (${encoded.length} > ${MAX_FRAME_LENGTH})`);
    }
    const frame = this.sendStream.seal(encoded);
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
   * bytes), and a teardown needs the never-throws, unestablished-tolerant
   * send that sendBestEffort documents, not send()'s contract.
   *
   * Never throws. It runs as the first line of a dispose chain, and an
   * escaping error would abandon the rest of that teardown with the transport
   * still live - see the orphan-connection failure connectionManager.ts
   * documents around its teardownThisAttempt.
   */
  sendFinalFrame(): void {
    this.sendBestEffort(new Uint8Array(0), FrameTag.Final);
  }

  /**
   * The never-throws send that sendFinalFrame and the heartbeat reply share:
   * both fire from a path that must survive whatever the transport is doing
   * (a dispose chain, the inbound frame handler). No MAX_FRAME_LENGTH check,
   * vacuous for the zero-byte Final and the ~20-byte heartbeat, and no throw
   * when unestablished - a frame with no streams to seal it under is simply
   * not sent.
   */
  private sendBestEffort(plaintext: Uint8Array, tag?: FrameTag): void {
    if (!this.sendStream) return;
    // Only seal when the frame can actually leave: seal advances this
    // direction's counter, and burning a counter slot on a frame the
    // transport rejects desyncs us from the desktop's receive counter.
    if (this.transport.state !== 'connected') return;
    try {
      const frame = this.sendStream.seal(plaintext, tag);
      this.transport.send(wrapSessionFrame(SessionFrameKind.Application, frame));
    } catch {
      // The socket dropped between the state check and the send. Nothing
      // productive to retry - the desktop's probes cover this exact case.
      // Same swallow as handleHandshakeFrame's transport.send below.
    }
  }

  /**
   * Drops session key material without touching the transport - call this when
   * the transport disconnects, before a reconnect drives a fresh handshake.
   * The retired receive streams go with it: a frame sealed for a session that
   * is gone must never open in the next one.
   */
  reset(): void {
    this.sendStream = null;
    this.receiveStreams.clear();
  }

  dispose(): void {
    this.unsubscribeFrame?.();
    this.unsubscribeFrame = null;
    this.sendStream = null;
    this.receiveStreams.clear();
  }

  private onFrame(rawFrame: Uint8Array): void {
    const arrivedAtMs = connectionTraceEnabled() ? Date.now() : null;
    let unwrapped: { kind: SessionFrameKind; payload: Uint8Array };
    try {
      unwrapped = unwrapSessionFrame(rawFrame);
    } catch {
      return;
    }
    if (unwrapped.kind === SessionFrameKind.Handshake) {
      this.handleHandshakeFrame(unwrapped.payload);
    } else {
      this.handleApplicationFrame(unwrapped.payload, arrivedAtMs);
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

    const streams = deriveSecretstreamPair(handshake.getChainingKey(), false);
    const wasEstablished = this.sendStream !== null;
    this.sendStream = streams.send;
    if (!wasEstablished) {
      // A fresh session keeps no retired stream: nothing sealed before it may
      // open in it (reset() has already cleared them; this makes it certain).
      this.receiveStreams.install(streams.receive, { keepRetired: false });
      this.lastRekeyAtMs = null;
      this.retiredOpenCount = 0;
      this.failedOpenCount = 0;
      for (const listener of this.establishedListeners) listener();
      return;
    }
    // A rekey: new key epoch on a session that was already up. Deliberately
    // NOT reported through onEstablished - subscriptions and streams survive
    // a rekey untouched, and re-firing it would reset them (see
    // subscriptionManager). This is the only signal a rekey happened at all.
    this.receiveStreams.install(streams.receive, { keepRetired: retiredReceiveStreamsEnabled() });
    this.lastRekeyAtMs = Date.now();
    for (const listener of this.rekeyListeners) listener();
  }

  private handleApplicationFrame(payload: Uint8Array, arrivedAtMs: number | null): void {
    if (this.receiveStreams.isEmpty) return;
    const result = this.receiveStreams.open(payload, { newestOnly: !retiredReceiveStreamsEnabled() });
    if (!result) {
      // Nothing kept could open it. Since the retired streams exist this
      // should be rare (a frame sealed for keys more than 180 s or 8
      // generations old, a relay-forged frame, or the A/B switch off), so it
      // is counted: it is the "before" of task #109's rekey-loss measurement.
      this.failedOpenCount += 1;
      traceConnection('frame-open-failed', {
        msSinceRekey: this.msSinceLastRekey(),
        generations: this.receiveStreams.size,
        failedOpens: this.failedOpenCount,
      });
      return;
    }
    if (result.generationsBack > 0) {
      // Each of these is a frame the phone used to drop: the desktop sealed it
      // before msg2 reached it.
      this.retiredOpenCount += 1;
      traceConnection('frame-opened-retired', {
        msSinceRekey: this.msSinceLastRekey(),
        generationsBack: result.generationsBack,
        retiredOpens: this.retiredOpenCount,
      });
    }
    const { opened } = result;
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
    // A desktop heartbeat is a liveness probe, answered here rather than by
    // a subscriber, because only this layer holds the two guards the reply
    // needs. The reply is sealed under the CURRENT send stream even when the
    // probe opened under a retired receive stream (the desktop sealed it
    // before our msg2 reached it): msg2 is ahead of the reply on the wire, so
    // the desktop has switched by the time it reads the reply. It is the cheap
    // probe the rekey is not: one sealed frame each way, no verb dispatch, and
    // no new keys for anything in flight to cross. Sent BEFORE the fan-out so
    // a throwing listener cannot suppress the liveness answer. The phone
    // ANSWERS heartbeats and never originates one - that asymmetry is what
    // makes an echo loop impossible; two peers that both auto-replied would
    // ping-pong at wire speed.
    if (message.type === 'heartbeat') this.sendBestEffort(encodeMessage({ type: 'heartbeat' }));
    for (const listener of this.messageListeners) listener(message, arrivedAtMs);
  }

  /** For the trace lines: null until a rekey lands on this establishment. */
  private msSinceLastRekey(): number | null {
    return this.lastRekeyAtMs === null ? null : Date.now() - this.lastRekeyAtMs;
  }
}
