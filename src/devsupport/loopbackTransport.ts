import type { Transport, TransportState, Unsubscribe } from '@kangentic/protocol';

/**
 * Two linked in-memory Transports: unit tests and the in-app mock desktop
 * peer (src/connection/mockDesktopPeer.ts) both run pairing/session code
 * over these with no relay and no network. Delivery is scheduled on a
 * microtask (not synchronous) so consumers exercise the same "send doesn't
 * synchronously invoke the peer's listener" ordering a real transport has,
 * without needing a real socket.
 *
 * KNOWN TRAP - a synchronous peer close EATS undelivered frames. Because
 * send() re-checks `peer.currentState` when its microtask drains (below), any
 * code that sends and then synchronously closes the PEER loses the frame. That
 * is exactly what connectionManager's teardownThisAttempt does:
 * `controller.dispose()` then `mockDesktop?.dispose()`, and the latter closes
 * the desktop transport before the queue drains. So a lifecycle-level test
 * asserting that a frame reached the mock desktop during teardown reads zero
 * NO MATTER WHETHER THE PRODUCTION CODE IS CORRECT.
 *
 * The danger is not a false pass, it is a false FAIL that invites "fixing"
 * correct code. Assert wire-level behaviour on a plain loopback pair with no
 * mockDesktop wrapper (tests/unit/channelController.test.ts), where close()
 * queues the peer close AFTER the send-delivery microtask; at the lifecycle
 * level, spy on the sender instead (tests/unit/connectionManagerBootstrapRetry.test.ts).
 */
export class LoopbackTransport implements Transport {
  private peer: LoopbackTransport | null = null;
  private currentState: TransportState = 'idle';
  private readonly frameListeners = new Set<(frame: Uint8Array) => void>();
  private readonly stateListeners = new Set<(state: TransportState) => void>();

  get state(): TransportState {
    return this.currentState;
  }

  linkTo(peer: LoopbackTransport): void {
    this.peer = peer;
  }

  async connect(): Promise<void> {
    this.setState('connected');
  }

  /**
   * Drop the socket the way a real relay client does: 'reconnecting', then
   * back to 'connected', WITHOUT ever passing through 'closed'. That path is
   * the one a network blip actually takes, and code which only watches for
   * 'closed' treats it as if nothing happened - so it needs to be expressible
   * here to be testable at all.
   */
  simulateReconnect(): void {
    this.setState('reconnecting');
    this.setState('connected');
  }

  send(frame: Uint8Array): void {
    if (this.currentState !== 'connected') {
      throw new Error('LoopbackTransport.send() called while not connected');
    }
    const peer = this.peer;
    if (!peer) return;
    queueMicrotask(() => {
      if (peer.currentState !== 'connected') return;
      for (const listener of peer.frameListeners) listener(frame);
    });
  }

  close(): void {
    if (this.currentState === 'closed') return;
    this.setState('closed');
    // Mirrors a real socket: closing one end delivers a close to the peer too.
    queueMicrotask(() => this.peer?.close());
  }

  onFrame(listener: (frame: Uint8Array) => void): Unsubscribe {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onStateChange(listener: (state: TransportState) => void): Unsubscribe {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: TransportState): void {
    if (this.currentState === state) return;
    this.currentState = state;
    for (const listener of this.stateListeners) listener(state);
  }
}

// Returns the concrete type, not the bare Transport interface: the pair is a
// TEST double, and simulateReconnect is only reachable if callers can see it.
export function createLoopbackPair(): [LoopbackTransport, LoopbackTransport] {
  const a = new LoopbackTransport();
  const b = new LoopbackTransport();
  a.linkTo(b);
  b.linkTo(a);
  return [a, b];
}
