import type { SecretstreamState } from '@kangentic/protocol';

/**
 * How long a superseded receive stream may still open a frame: WireGuard's
 * REJECT_AFTER_TIME (https://www.wireguard.com/protocol/). The desktop holds
 * its frames for at most 10 s across a rekey (REKEY_HOLD_MAX_MS in its
 * bridge-session.ts) and older desktops do not hold at all, so anything it
 * sealed under the old keys arrives within that hold plus a relay round trip,
 * or not at all (read from the desktop source; task #109's rig saw releases at
 * the 10 s deadline and none later). 180 s is WireGuard's bound, not a
 * measured one: it covers that window with a wide margin, and still bounds how
 * long a retired key stays useful to anyone who later compromises the phone.
 */
export const RETIRED_RECEIVE_STREAM_MAX_AGE_MS = 180_000;

/**
 * How many superseded receive streams are kept. The desktop stops initiating
 * at 8 outstanding handshakes (MAX_OUTSTANDING_HANDSHAKES in its
 * bridge-session.ts), and it installs the keys of every reply it reads, so the
 * keys it seals under are never more than 8 generations behind the newest one
 * this phone has answered. The deepest task #109's rig measured was two
 * generations back (a rekey msg1 plus the desktop's 5 s re-probe msg1).
 */
export const MAX_RETIRED_RECEIVE_STREAMS = 8;

interface ReceiveGeneration {
  stream: SecretstreamState;
  /** When a newer handshake replaced this one; null while it is the newest. */
  supersededAtMs: number | null;
}

export interface OpenedFrame {
  opened: ReturnType<SecretstreamState['open']>;
  /** 0 when the frame opened under the newest stream, N when under the Nth one before it. */
  generationsBack: number;
}

/**
 * The receive side of a session across rekeys, as the KK responder.
 *
 * The phone installs new keys the moment it writes msg2, but the desktop keeps
 * sealing under the old ones until msg2 reaches it, a relay round trip later.
 * Every frame it sends in that window used to fail to open and be dropped: a
 * lost capability response (the caller waits out its whole timeout) or a lost
 * terminal delta (the grid stays wrong until the next repaint). WireGuard's
 * rule for the responder is the fix: it "must wait to use the new session
 * until it has recieved one encrypted session packet from the initiator", and
 * meanwhile keeps the previous one (https://www.wireguard.com/protocol/;
 * wireguard-go keeps current, previous and next keypairs in
 * device/keypair.go). Only the RECEIVE direction needs this: in-order delivery
 * puts msg2 ahead of anything the phone seals under the new keys, so the
 * desktop has always switched before it reads one.
 *
 * Trying a stream that is wrong for the frame has no side effect:
 * SecretstreamState.open advances its counter only after the frame
 * authenticates, so a failed trial leaves the stream exactly where it was. Its
 * CPU cost is one failed authentication, paid only while a retired stream is
 * kept (read from source, not measured).
 *
 * Retirement is evidence-based. When a frame opens under a generation, every
 * OLDER generation is dropped, because delivery is in order and the desktop's
 * keys only ever move forward through the replies it reads. A frame that opens
 * under the newest stream therefore leaves exactly one, so the steady state
 * keeps one stream and makes one open attempt per frame.
 */
export class ReceiveStreams {
  private readonly clock: () => number;
  /** Newest first. Empty until the first handshake. */
  private generations: ReceiveGeneration[] = [];
  /** The generation that opened the last frame, tried first: frames arrive in runs under one key. */
  private lastOpened: ReceiveGeneration | null = null;

  /** `clock` is read only on a rekey and while a retired stream exists, never per frame in the steady state. */
  constructor(clock: () => number = () => Date.now()) {
    this.clock = clock;
  }

  get isEmpty(): boolean {
    return this.generations.length === 0;
  }

  /** How many streams a frame could currently open under, newest included. */
  get size(): number {
    return this.generations.length;
  }

  /**
   * A completed handshake's receive stream. On a rekey the previous newest is
   * kept as a retired candidate, unless `keepRetired` is false, in which case
   * only the new stream remains (a fresh establishment, and the pre-fix
   * behaviour kept for the trace build's A/B switch).
   */
  install(stream: SecretstreamState, options: { keepRetired: boolean }): void {
    const previousNewest = this.generations[0];
    if (previousNewest) previousNewest.supersededAtMs = this.clock();
    const fresh: ReceiveGeneration = { stream, supersededAtMs: null };
    this.keep(options.keepRetired ? [fresh, ...this.generations].slice(0, 1 + MAX_RETIRED_RECEIVE_STREAMS) : [fresh]);
  }

  /**
   * Opens one frame under whichever kept stream authenticates it, or returns
   * null when none does. `newestOnly` restricts the trial to the newest stream
   * (the A/B switch's off arm); the retired ones are left in place either way.
   */
  open(payload: Uint8Array, options: { newestOnly: boolean } = { newestOnly: false }): OpenedFrame | null {
    if (this.generations.length > 1) this.expireRetired(this.clock());
    const newest = this.generations[0];
    if (!newest) return null;
    // The steady state, one stream between rekeys: no trial order to build.
    if (options.newestOnly || this.generations.length === 1) return this.tryOpen(newest, payload);
    for (const generation of this.trialOrder()) {
      const result = this.tryOpen(generation, payload);
      if (result) return result;
    }
    return null;
  }

  /** Forgets every stream. A frame from a session that is gone must never open in the next one. */
  clear(): void {
    this.generations = [];
    this.lastOpened = null;
  }

  private tryOpen(generation: ReceiveGeneration, payload: Uint8Array): OpenedFrame | null {
    let opened: OpenedFrame['opened'];
    try {
      opened = generation.stream.open(payload);
    } catch {
      return null;
    }
    const generationsBack = this.generations.indexOf(generation);
    if (generationsBack < this.generations.length - 1) this.keep(this.generations.slice(0, generationsBack + 1));
    this.lastOpened = generation;
    return { opened, generationsBack };
  }

  /**
   * The one place `generations` is replaced, so `lastOpened` can never point
   * at a generation that is gone: trialOrder() would put it back in the trial.
   */
  private keep(next: ReceiveGeneration[]): void {
    this.generations = next;
    if (this.lastOpened && !next.includes(this.lastOpened)) this.lastOpened = null;
  }

  /** The stream that opened the last frame, then the rest newest first. */
  private trialOrder(): ReceiveGeneration[] {
    const lastOpened = this.lastOpened;
    if (!lastOpened) return this.generations;
    return [lastOpened, ...this.generations.filter((generation) => generation !== lastOpened)];
  }

  /** Lazy, so no timer has to run on a backgrounded phone for the bound to hold. */
  private expireRetired(nowMs: number): void {
    const kept = this.generations.filter(
      (generation) => generation.supersededAtMs === null || nowMs - generation.supersededAtMs <= RETIRED_RECEIVE_STREAM_MAX_AGE_MS,
    );
    if (kept.length !== this.generations.length) this.keep(kept);
  }
}
