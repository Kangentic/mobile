import type { Transport, TransportState, Unsubscribe } from '@kangentic/protocol';

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const BACKOFF_MULTIPLIER = 2;

/**
 * relay close codes (see the relay repo's src/closeCodes.ts).
 * SLOT_BUSY and PARK_TIMEOUT both mean "the desktop peer never showed up
 * on this slot" - from the phone's perspective that is indistinguishable
 * from the desktop being offline, so both get the same slower retry
 * treatment rather than a fast reconnect loop against an empty slot.
 */
const RELAY_CLOSE_CODE = {
  peerClosed: 4000,
  parkTimeout: 4408,
  badSlot: 4400,
  slotBusy: 4409,
  idleTimeout: 4410,
  backpressure: 4431,
  sessionByteCap: 4432,
  sessionConnectionCap: 4433,
  shuttingDown: 4503,
} as const;

const SLOW_RETRY_BACKOFF_MS = 5_000;

export interface RelayTransportOptions {
  relayUrl: string;
  slotId: string;
}

/**
 * The relay WebSocket client, implementing the protocol's Transport
 * interface (@kangentic/protocol) so a future WebRTC data channel can slot
 * in behind the exact same seam (Phase 4). Dials
 * `${relayUrl}?slot=<slotId>` and reconnects with capped exponential
 * backoff; the desktop's RelayClient
 * (src/main/mobile-bridge/transport/relay-client.ts) is the wire contract
 * this mirrors.
 */
export class RelayTransport implements Transport {
  private readonly relayUrl: string;
  private readonly slotId: string;

  private socket: WebSocket | null = null;
  private currentState: TransportState = 'idle';
  private reconnectBackoffMs = INITIAL_BACKOFF_MS;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private explicitlyClosed = false;
  private pendingDialReject: ((error: Error) => void) | null = null;
  /**
   * The last close code the relay sent, for diagnosis. A dropped socket is
   * reported to callers as a bare state change, which cannot distinguish
   * "the peer left" (4000) from "this slot already has two peers" (4409) or
   * "nobody joined in time" (4408) - and those have completely different
   * causes. See RELAY_CLOSE_CODE above.
   */
  private lastRelayCloseCode: number | null = null;

  private readonly frameListeners = new Set<(frame: Uint8Array) => void>();
  private readonly stateListeners = new Set<(state: TransportState) => void>();

  constructor(options: RelayTransportOptions) {
    this.relayUrl = options.relayUrl;
    this.slotId = options.slotId;
  }

  get state(): TransportState {
    return this.currentState;
  }

  /** The relay's last close code, or null if the socket has never closed. */
  get relayCloseCode(): number | null {
    return this.lastRelayCloseCode;
  }

  async connect(): Promise<void> {
    this.explicitlyClosed = false;
    return this.dial();
  }

  private dial(): Promise<void> {
    this.setState(this.currentState === 'idle' ? 'connecting' : 'reconnecting');
    const separator = this.relayUrl.includes('?') ? '&' : '?';
    const url = `${this.relayUrl}${separator}slot=${encodeURIComponent(this.slotId)}`;

    return new Promise<void>((resolve, reject) => {
      const settle = () => {
        this.pendingDialReject = null;
      };
      const resolveOnce = () => {
        settle();
        resolve();
      };
      const rejectOnce = (error: Error) => {
        settle();
        reject(error);
      };
      this.pendingDialReject = rejectOnce;

      let socket: WebSocket;
      try {
        socket = new WebSocket(url);
      } catch (error) {
        this.scheduleReconnect(INITIAL_BACKOFF_MS);
        rejectOnce(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      // RN WebSocket defaults binaryType to 'blob' on some platforms; the
      // whole protocol assumes raw bytes.
      socket.binaryType = 'arraybuffer';
      this.socket = socket;

      socket.onopen = () => {
        this.reconnectBackoffMs = INITIAL_BACKOFF_MS;
        this.setState('connected');
        resolveOnce();
      };

      socket.onmessage = (event: WebSocketMessageEvent) => {
        const frame = toUint8Array(event.data);
        if (frame) for (const listener of this.frameListeners) listener(frame);
      };

      socket.onerror = () => {
        // The corresponding onclose fires right after in every
        // browser-compatible WebSocket implementation; reconnect logic
        // lives there, not here.
      };

      socket.onclose = (event: WebSocketCloseEvent) => {
        this.socket = null;
        this.lastRelayCloseCode = event.code ?? null;
        if (this.explicitlyClosed) {
          this.setState('closed');
          rejectOnce(new Error('Relay connection closed before it opened'));
          return;
        }
        this.scheduleReconnect(backoffForCloseCode(event.code ?? 0));
        if (this.currentState !== 'connected') {
          rejectOnce(new Error(`Relay connection closed before it opened (code ${event.code})`));
        }
      };
    });
  }

  private scheduleReconnect(minimumBackoffMs: number): void {
    if (this.explicitlyClosed) return;
    this.setState('reconnecting');
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const backoffMs = Math.max(this.reconnectBackoffMs, minimumBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial().catch(() => {
        // dial() already scheduled the next attempt on failure.
      });
    }, backoffMs);
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
  }

  send(frame: Uint8Array): void {
    if (!this.socket || this.currentState !== 'connected') {
      throw new Error('RelayTransport.send() called while not connected');
    }
    // Copy out just this view's bytes: a Uint8Array with a non-zero
    // byteOffset shares its underlying buffer with neighboring data, which
    // WebSocket.send() would otherwise ship in full.
    this.socket.send(frame.slice().buffer);
  }

  close(): void {
    this.explicitlyClosed = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.socket) {
      try {
        this.socket.close();
      } catch {
        // best-effort
      }
      this.socket = null;
    }
    this.setState('closed');
    if (this.pendingDialReject) {
      const rejectPending = this.pendingDialReject;
      this.pendingDialReject = null;
      rejectPending(new Error('Relay connection closed before it opened'));
    }
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

function backoffForCloseCode(code: number): number {
  switch (code) {
    case RELAY_CLOSE_CODE.slotBusy:
    case RELAY_CLOSE_CODE.parkTimeout:
      // The desktop peer never showed up on this slot - retry slower
      // rather than hammering an empty rendezvous.
      return SLOW_RETRY_BACKOFF_MS;
    default:
      return INITIAL_BACKOFF_MS;
  }
}

function toUint8Array(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
