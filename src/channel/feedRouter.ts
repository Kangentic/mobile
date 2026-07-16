import { isBridgeEvent, type BridgeEvent, type Unsubscribe } from '@kangentic/protocol';
import type { SessionManager } from './sessionManager';

type BridgeEventKind = BridgeEvent['kind'];

/**
 * Routes unsolicited EventMessages off a SessionManager's message stream to
 * per-kind listeners. `isBridgeEvent` (the protocol package's structural
 * guard, envelope AND payload shape) is the trust boundary: a malformed
 * event is dropped silently, the same drop-quietly posture SessionManager
 * takes toward malformed frames. Heartbeats and capability-responses pass
 * through untouched (CapabilityClient owns responses; nothing owns
 * heartbeats).
 */
export class FeedRouter {
  private readonly listenersByKind = new Map<BridgeEventKind, Set<(event: BridgeEvent) => void>>();
  private readonly unsubscribeMessage: Unsubscribe;

  constructor(sessionManager: SessionManager) {
    this.unsubscribeMessage = sessionManager.onMessage((message) => {
      if (message.type !== 'event') return;
      if (!isBridgeEvent(message.event)) return;
      this.dispatch(message.event);
    });
  }

  on<Kind extends BridgeEventKind>(kind: Kind, listener: (event: Extract<BridgeEvent, { kind: Kind }>) => void): Unsubscribe {
    let listeners = this.listenersByKind.get(kind);
    if (!listeners) {
      listeners = new Set();
      this.listenersByKind.set(kind, listeners);
    }
    // Safe: dispatch() only ever hands this listener an event whose kind
    // matched the key it is registered under.
    const registered = listener as (event: BridgeEvent) => void;
    listeners.add(registered);
    return () => {
      listeners.delete(registered);
    };
  }

  dispose(): void {
    this.unsubscribeMessage();
    this.listenersByKind.clear();
  }

  private dispatch(event: BridgeEvent): void {
    const listeners = this.listenersByKind.get(event.kind);
    if (!listeners) return;
    // Iterate a copy so a listener unsubscribing (itself or a sibling)
    // mid-dispatch cannot skip or double-deliver.
    for (const listener of [...listeners]) listener(event);
  }
}
