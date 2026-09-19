/**
 * Transport wrappers for the vitest tier: two ways a real socket misbehaves
 * that a plain LoopbackTransport cannot express. Both wrap a connected
 * loopback and forward everything except the one failure they stage, so a
 * real SessionManager runs over them unchanged.
 *
 * They are inverses of each other, and the difference is the whole point:
 * FlappableTransport fails while `state` reads NOT connected (the guard's
 * territory), ArmableTransport fails while `state` still reads 'connected'
 * (the try/catch's territory). A test picking the wrong one exercises the
 * wrong line.
 */
import type { Transport, TransportState, Unsubscribe } from '@kangentic/protocol';
import type { LoopbackTransport } from '@/devsupport/loopbackTransport';

/**
 * A LoopbackTransport that can be HELD in a non-'connected' state and then
 * released, which plain LoopbackTransport cannot express: simulateReconnect()
 * flips back to 'connected' in the same tick, leaving no window to send into,
 * and close() is terminal. A real network blip is exactly this shape - the
 * socket stops carrying frames for a while, and nothing resets the session, so
 * the key material stays live throughout.
 *
 * Only the OUTBOUND direction is held: onFrame delegates to the inner
 * loopback, so a frame the peer sends while held still arrives. That is what
 * lets a test deliver an inbound probe into a session whose reply cannot
 * leave.
 */
export class FlappableTransport implements Transport {
  private heldState: TransportState | null = null;

  constructor(private readonly inner: LoopbackTransport) {}

  get state(): TransportState {
    return this.heldState ?? this.inner.state;
  }

  holdDisconnected(): void {
    this.heldState = 'reconnecting';
  }

  release(): void {
    this.heldState = null;
  }

  async connect(): Promise<void> {
    await this.inner.connect();
  }

  // Throws rather than no-ops while disconnected, matching RelayTransport.send.
  send(frame: Uint8Array): void {
    if (this.state !== 'connected') throw new Error('FlappableTransport.send() called while not connected');
    this.inner.send(frame);
  }

  close(): void {
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
 * A LoopbackTransport wrapper that counts send() calls and otherwise passes
 * everything through unchanged. Exists to let a test read transport activity
 * from INSIDE a listener callback: a send count captured at the moment a
 * listener runs pins WHEN a reply left relative to that listener, which no
 * assertion on the eventual delivered message alone can pin.
 */
export class RecordingTransport implements Transport {
  sendCount = 0;

  constructor(private readonly inner: LoopbackTransport) {}

  get state(): TransportState {
    return this.inner.state;
  }

  async connect(): Promise<void> {
    await this.inner.connect();
  }

  send(frame: Uint8Array): void {
    this.sendCount += 1;
    this.inner.send(frame);
  }

  close(): void {
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
 * Wraps a real (connected) LoopbackTransport and, once armed, makes exactly
 * ONE send() throw instead of forwarding - "the socket dropped between the
 * state check and the send" that sendBestEffort's own catch comment names.
 * Deliberately the inverse of FlappableTransport, which throws while NOT
 * connected; this one throws while `state` still reads 'connected', which is
 * the only way to drive a guarded send's seal call to succeed and its
 * transport.send() call to fail.
 */
export class ArmableTransport implements Transport {
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
