import { bytesToHex, randomBytes, type CapabilityResponseMessage, type CapabilityVerb, type JsonValue } from '@kangentic/protocol';
import type { SessionManager } from './sessionManager';

interface PendingRequest {
  resolve: (response: CapabilityResponseMessage) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Request/response correlation over a SessionManager's BridgeMessage
 * stream. Request ids do not survive a fresh handshake (see
 * SessionManager.reset()) - callers should re-issue a request after a
 * reconnect rather than expect it to resume.
 */
export class CapabilityClient {
  private readonly sessionManager: SessionManager;
  private readonly timeoutMs: number;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly unsubscribeMessage: () => void;

  constructor(sessionManager: SessionManager, timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.sessionManager = sessionManager;
    this.timeoutMs = timeoutMs;
    this.unsubscribeMessage = sessionManager.onMessage((message) => {
      if (message.type === 'capability-response') this.resolvePending(message);
    });
  }

  request(verb: CapabilityVerb, payload: JsonValue): Promise<CapabilityResponseMessage> {
    const requestId = bytesToHex(randomBytes(16));
    return new Promise<CapabilityResponseMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new Error(`Capability request "${verb}" timed out`));
      }, this.timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout });

      try {
        this.sessionManager.send({ type: 'capability-request', requestId, verb, payload });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(requestId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /** Rejects every in-flight request - call this when the transport drops, since a fresh handshake invalidates all pending request ids. */
  rejectAllPending(reason: string): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timeout);
      entry.reject(new Error(reason));
    }
    this.pending.clear();
  }

  dispose(): void {
    this.rejectAllPending('CapabilityClient disposed');
    this.unsubscribeMessage();
  }

  private resolvePending(message: CapabilityResponseMessage): void {
    const entry = this.pending.get(message.requestId);
    if (!entry) return;
    clearTimeout(entry.timeout);
    this.pending.delete(message.requestId);
    entry.resolve(message);
  }
}
