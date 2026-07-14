import type { Transport, TransportState, Unsubscribe } from '@kangentic/protocol';

/**
 * Two linked in-memory Transports: unit tests and the in-app mock desktop
 * peer (src/connection/mockDesktopPeer.ts) both run pairing/session code
 * over these with no relay and no network. Delivery is scheduled on a
 * microtask (not synchronous) so consumers exercise the same "send doesn't
 * synchronously invoke the peer's listener" ordering a real transport has,
 * without needing a real socket.
 */
class LoopbackTransport implements Transport {
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

export function createLoopbackPair(): [Transport, Transport] {
  const a = new LoopbackTransport();
  const b = new LoopbackTransport();
  a.linkTo(b);
  b.linkTo(a);
  return [a, b];
}
