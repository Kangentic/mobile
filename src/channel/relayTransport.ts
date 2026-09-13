import type { Transport, TransportState, Unsubscribe } from '@kangentic/protocol';
import { traceConnection } from '@/devsupport/connectionTrace';

const INITIAL_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 15_000;
const BACKOFF_MULTIPLIER = 2;

/**
 * relay close codes (see the relay repo's src/closeCodes.ts).
 * PARK_TIMEOUT means "the desktop peer never showed up on this slot" - from
 * the phone's perspective indistinguishable from the desktop being offline,
 * so it gets a slower retry rather than a fast loop against an empty slot.
 * SLOT_BUSY used to share that floor, but on a slot this phone itself just
 * occupied it means something else: the relay is pinging the phone's own
 * zombie socket (rendezvous.ts probePairedSlot) and will terminate it when
 * the probe window closes, so the right retry is just past that window.
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
/**
 * Just past the relay's contention probe (CONTENTION_PROBE_TIMEOUT_MS, 2 s in
 * the relay repo's config.ts). A newcomer on a paired slot is rejected with
 * 4409 at once while both incumbents are pinged; whichever stays silent for
 * the window is terminated, which also closes its peer with PEER_CLOSED so
 * the desktop re-parks within its own 500 ms. The phone that re-dials at
 * 2.5 s therefore finds the slot free. The 5 s it used to wait was the
 * PARK_TIMEOUT floor applied to a code that does not mean "nobody home".
 */
const SLOT_BUSY_RETRY_BACKOFF_MS = 2_500;

export interface RelayTransportOptions {
  relayUrl: string;
  slotId: string;
}

export interface RedialOptions {
  /**
   * Abandon a socket that exists, open or mid-dial, and dial afresh. For a
   * caller that has PROVEN the socket dead: the foreground liveness probe in
   * connectionManager, which sends one request and gets nothing back. A
   * socket can read open and carry nothing indefinitely (a network stall the
   * OS never reports), and only the application layer can tell.
   */
  force?: boolean;
}

/**
 * A Transport that can be told to abandon its reconnect backoff and dial at
 * once. Deliberately an extension local to this app rather than a member of
 * the protocol package's Transport: the one caller is the AppState 'active'
 * transition, which the desktop has no analogue for. Extending by
 * composition is what protocol-types-from-package.md allows, and it keeps a
 * cross-repo protocol release out of a mobile-only fix. The precedent for a
 * RelayTransport-only member the interface lacks is `relayCloseCode`.
 */
export interface RedialableTransport extends Transport {
  redialNow(options?: RedialOptions): void;
}

export function isRedialableTransport(transport: Transport): transport is RedialableTransport {
  return typeof (transport as Partial<RedialableTransport>).redialNow === 'function';
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
export class RelayTransport implements RedialableTransport {
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

  /**
   * The foreground kick. A phone that dozed with its socket dead comes back
   * with `reconnectBackoffMs` ratcheted to the cap and a reconnect timer
   * armed for up to fifteen seconds, and nothing else in the app dials:
   * connectionManager's 'active' branch keeps the connection it already has.
   * This abandons that wait: clear the armed timer, reset the ladder, dial.
   *
   * No-op when a socket exists, open or mid-dial. `this.socket` is assigned
   * right after construction and nulled only by `onclose` and `close()`, so
   * non-null means exactly "a dial is in flight or the socket is open", and a
   * second dial on top of it is the two-live-sockets hazard `connect()` has
   * (the loser's onclose nulls the winner). A dial hung in CONNECTING is
   * therefore not rescued, on purpose: the OS connect timeout bounds it, and
   * the backoff reset below makes its failure retry at the floor rather than
   * the cap.
   *
   * Must not be called from inside an onStateChange listener: scheduleReconnect
   * arms its timer before notifying, so a synchronous re-entrant kick is safe
   * there today, but the AppState transition is a macrotask and that is the
   * contract this method is written for.
   */
  redialNow(options: RedialOptions = {}): void {
    if (this.explicitlyClosed || this.currentState === 'idle') return;
    this.reconnectBackoffMs = INITIAL_BACKOFF_MS;
    if (this.socket !== null) {
      if (!options.force) {
        traceConnection('redial-now', { state: this.currentState, dialed: false });
        return;
      }
      this.abandonSocket();
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    traceConnection('redial-now', { state: this.currentState, dialed: true, forced: options.force === true });
    this.dial().catch(() => {
      // dial() already scheduled the next attempt on failure.
    });
  }

  /**
   * Drops the current socket without letting it schedule anything: the
   * handlers come off FIRST, so the abandoned socket's own late onclose can
   * neither null the socket the forced dial is about to install nor arm a
   * reconnect on top of it. Its dial promise, if still pending, is rejected
   * the way close() rejects one.
   */
  private abandonSocket(): void {
    const abandoned = this.socket;
    if (!abandoned) return;
    abandoned.onopen = null;
    abandoned.onmessage = null;
    abandoned.onerror = null;
    abandoned.onclose = null;
    try {
      abandoned.close();
    } catch {
      // best-effort
    }
    this.socket = null;
    if (this.pendingDialReject) {
      const rejectPending = this.pendingDialReject;
      this.pendingDialReject = null;
      rejectPending(new Error('Relay connection abandoned by a forced redial'));
    }
  }

  private dial(): Promise<void> {
    traceConnection('dial', { stateBefore: this.currentState });
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
        traceConnection('open');
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
        traceConnection('close', { code: event.code ?? null, stateBefore: this.currentState });
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
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    const backoffMs = Math.max(this.reconnectBackoffMs, minimumBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.dial().catch(() => {
        // dial() already scheduled the next attempt on failure.
      });
    }, backoffMs);
    this.reconnectBackoffMs = Math.min(this.reconnectBackoffMs * BACKOFF_MULTIPLIER, MAX_BACKOFF_MS);
    traceConnection('schedule-reconnect', { delayMs: backoffMs, nextBackoffMs: this.reconnectBackoffMs });
    // Notify AFTER the timer is armed. A listener that reacts by calling
    // redialNow() then clears this timer instead of racing it, which is what
    // keeps a re-entrant kick from ending up with two live sockets.
    this.setState('reconnecting');
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
      return SLOT_BUSY_RETRY_BACKOFF_MS;
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
