/**
 * A rekey must not lose desktop-to-phone frames (task #109).
 *
 * The phone (Noise responder) installs new keys the moment it writes msg2. The
 * desktop (initiator) keeps sealing under the old keys until msg2 reaches it,
 * a relay round trip later. Before this fix the phone dropped every frame the
 * desktop sent in that window. The desktop repo reproduced it from its side in
 * tests/unit/mobile-bridge/bridge-session-rekey-loss.test.ts, and this file is
 * that file's mirror: the real SessionManager on the phone side, and a
 * desktop-like initiator that behaves the way bridge-session.ts does.
 * - It can hold several initiations outstanding, reads replies oldest first,
 *   and installs the keys of every reply it reads.
 * - It can seal under any saved generation, the way its deadline release
 *   seals under whatever it installed last.
 *
 * LoopbackTransport delivers on a microtask, so msg2 lands before the desktop
 * can send anything and the window is zero. These frames wait in order until
 * a test delivers them, which is what a relay with latency does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createKKHandshake,
  decodeMessage,
  deriveSecretstreamPair,
  encodeMessage,
  generateX25519KeyPair,
  SessionFrameKind,
  unwrapSessionFrame,
  wrapSessionFrame,
  type BridgeMessage,
  type HandshakeState,
  type SecretstreamDirectionPair,
  type Transport,
  type X25519KeyPair,
} from '@kangentic/protocol';
import { SessionManager } from '@/channel/sessionManager';
import { RETIRED_RECEIVE_STREAM_MAX_AGE_MS } from '@/channel/receiveStreams';

const traceMocks = vi.hoisted(() => ({
  traceConnection: vi.fn<(event: string, fields?: Record<string, unknown>) => void>(),
  retiredReceiveStreamsEnabled: vi.fn<() => boolean>(() => true),
  connectionTraceEnabled: vi.fn<() => boolean>(() => false),
}));
vi.mock('@/devsupport/connectionTrace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/devsupport/connectionTrace')>()),
  traceConnection: traceMocks.traceConnection,
  retiredReceiveStreamsEnabled: traceMocks.retiredReceiveStreamsEnabled,
  connectionTraceEnabled: traceMocks.connectionTraceEnabled,
}));

interface DelayedPipe {
  phone: Transport;
  desktop: Transport;
  deliverToPhone: () => void;
  deliverToDesktop: () => void;
  /** One frame, so a test can make the desktop send between two replies it reads. */
  deliverOneToDesktop: () => void;
}

/** Two connected transports whose frames wait, in order, until delivered. */
function createDelayedPipe(): DelayedPipe {
  const toPhone: Uint8Array[] = [];
  const toDesktop: Uint8Array[] = [];
  const phoneListeners = new Set<(frame: Uint8Array) => void>();
  const desktopListeners = new Set<(frame: Uint8Array) => void>();
  const endpoint = (outbox: Uint8Array[], listeners: Set<(frame: Uint8Array) => void>): Transport => ({
    state: 'connected',
    connect: () => Promise.resolve(),
    send: (frame) => {
      outbox.push(frame);
    },
    close: () => undefined,
    onFrame: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onStateChange: () => () => undefined,
  });
  const deliverOne = (queue: Uint8Array[], listeners: Set<(frame: Uint8Array) => void>): void => {
    const frame = queue.shift();
    if (frame) for (const listener of listeners) listener(frame);
  };
  return {
    phone: endpoint(toDesktop, phoneListeners),
    desktop: endpoint(toPhone, desktopListeners),
    deliverToPhone: () => {
      while (toPhone.length > 0) deliverOne(toPhone, phoneListeners);
    },
    deliverToDesktop: () => {
      while (toDesktop.length > 0) deliverOne(toDesktop, desktopListeners);
    },
    deliverOneToDesktop: () => deliverOne(toDesktop, desktopListeners),
  };
}

function response(label: string): BridgeMessage {
  return { type: 'capability-response', requestId: label, ok: true };
}

/**
 * The desktop's half, reduced to what bridge-session.ts does with keys: every
 * msg1 stays outstanding until a reply matches it, replies are read OLDEST
 * first, and each match installs that handshake's streams.
 */
class DesktopLikeInitiator {
  streams: SecretstreamDirectionPair | null = null;
  /** Application messages from the phone that opened under the desktop's CURRENT receive stream. */
  readonly openedFromPhone: BridgeMessage[] = [];
  private outstanding: HandshakeState[] = [];

  constructor(
    private readonly desktopStatic: X25519KeyPair,
    private readonly phoneStaticPublicKey: Uint8Array,
    private readonly transport: Transport,
  ) {
    transport.onFrame((rawFrame) => this.onFrame(rawFrame));
  }

  beginHandshake(): void {
    const handshake = createKKHandshake({ initiator: true, localStatic: this.desktopStatic, remoteStatic: this.phoneStaticPublicKey });
    const { message } = handshake.writeMessage(new Uint8Array(0));
    this.outstanding.push(handshake);
    this.transport.send(wrapSessionFrame(SessionFrameKind.Handshake, message));
  }

  /** Seals under the current streams, or under a saved generation (a deadline release, or a late frame). */
  send(label: string, streams: SecretstreamDirectionPair | null = this.streams): void {
    if (!streams) throw new Error('DesktopLikeInitiator is not established');
    this.sendMessage(response(label), streams);
  }

  /** Any message, sealed under the current streams or a saved generation. */
  sendMessage(message: BridgeMessage, streams: SecretstreamDirectionPair | null = this.streams): void {
    if (!streams) throw new Error('DesktopLikeInitiator is not established');
    this.transport.send(wrapSessionFrame(SessionFrameKind.Application, streams.send.seal(encodeMessage(message))));
  }

  private onFrame(rawFrame: Uint8Array): void {
    const { kind, payload } = unwrapSessionFrame(rawFrame);
    if (kind === SessionFrameKind.Application) {
      // Only what opens under the keys installed so far counts, as on the real desktop.
      if (!this.streams) return;
      try {
        this.openedFromPhone.push(decodeMessage(this.streams.receive.open(payload).plaintext));
      } catch {
        // Sealed under keys this side has not installed (or does not hold).
      }
      return;
    }
    while (this.outstanding.length > 0) {
      const candidate = this.outstanding.shift();
      if (!candidate) return;
      try {
        if (candidate.readMessage(payload).split) {
          this.streams = deriveSecretstreamPair(candidate.getChainingKey(), true);
          return;
        }
      } catch {
        // A superseded initiation; the next one may match.
      }
    }
  }
}

interface Rig {
  phone: SessionManager;
  desktop: DesktopLikeInitiator;
  pipe: DelayedPipe;
  /** requestIds the phone's listeners received, in order. */
  received: string[];
}

function establishedRig(): Rig {
  const phoneIdentity = generateX25519KeyPair();
  const desktopStatic = generateX25519KeyPair();
  const pipe = createDelayedPipe();
  const phone = new SessionManager({ identity: phoneIdentity, remoteStaticPublicKey: desktopStatic.publicKey, transport: pipe.phone });
  phone.start();
  const received: string[] = [];
  phone.onMessage((message) => {
    if (message.type === 'capability-response') received.push(message.requestId);
  });
  const desktop = new DesktopLikeInitiator(desktopStatic, phoneIdentity.publicKey, pipe.desktop);
  desktop.beginHandshake();
  pipe.deliverToPhone();
  pipe.deliverToDesktop();
  if (!phone.isEstablished || !desktop.streams) throw new Error('establishedRig(): the first handshake did not complete');
  return { phone, desktop, pipe, received };
}

function traceEvents(event: string): (Record<string, unknown> | undefined)[] {
  return traceMocks.traceConnection.mock.calls.filter(([name]) => name === event).map(([, fields]) => fields);
}

describe('SessionManager across a rekey (delayed pipe)', () => {
  beforeEach(() => {
    traceMocks.traceConnection.mockClear();
    traceMocks.retiredReceiveStreamsEnabled.mockReturnValue(true);
    traceMocks.connectionTraceEnabled.mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * The bug itself: frames the desktop sealed after sending msg1 and before
   * msg2 reached it. Each one opens under the superseded stream, and each is
   * counted as a rescue.
   *
   * Mutation seen failing: passing `true` (newestOnly) to
   * receiveStreams.open in handleApplicationFrame - received was
   * ['before-rekey', 'after-rekey'], both in-window frames dropped. The same
   * mutation fails every other test here that needs a retired stream.
   */
  it('opens every frame the desktop sealed before msg2 reached it', () => {
    const { desktop, pipe, received } = establishedRig();
    desktop.send('before-rekey');
    pipe.deliverToPhone();

    desktop.beginHandshake();
    desktop.send('during-rekey-1');
    desktop.send('during-rekey-2');
    pipe.deliverToPhone();
    pipe.deliverToDesktop();
    desktop.send('after-rekey');
    pipe.deliverToPhone();

    expect(received).toEqual(['before-rekey', 'during-rekey-1', 'during-rekey-2', 'after-rekey']);
    expect(traceEvents('frame-open-failed')).toEqual([]);
    expect(traceEvents('frame-opened-retired').map((fields) => fields?.generationsBack)).toEqual([1, 1]);
    expect(traceEvents('frame-opened-retired').map((fields) => fields?.retiredOpens)).toEqual([1, 2]);
    expect(typeof traceEvents('frame-opened-retired')[0]?.msSinceRekey).toBe('number');
  });

  /**
   * Pins the assumption the trial order rests on: an attempt under a stream
   * that is wrong for the frame leaves that stream's counter alone. With no
   * frame opened since the rekey, the old-key frame is tried under the NEWEST
   * stream first and fails there; the next frame, sealed at the newest
   * stream's counter 0, must still open. If a failed open advanced the
   * counter, it would be one behind and drop.
   */
  it('a failed trial under the newest stream does not burn its counter', () => {
    const { desktop, pipe, received } = establishedRig();
    desktop.beginHandshake();
    desktop.send('sealed-before-msg2');
    pipe.deliverToPhone();
    pipe.deliverToDesktop();
    desktop.send('sealed-after-msg2');
    pipe.deliverToPhone();

    expect(received).toEqual(['sealed-before-msg2', 'sealed-after-msg2']);
    expect(traceEvents('frame-open-failed')).toEqual([]);
  });

  /**
   * Retirement is evidence-based: once a frame opens under the new keys, an
   * old-key frame can never legitimately arrive (delivery is in order), so it
   * is dropped rather than opened late.
   *
   * Mutation seen failing: deleting the `this.generations = ...slice(...)`
   * line from ReceiveStreams.tryOpen - 'late-old-key' was received.
   */
  it('drops an old-key frame once a frame has opened under the new keys', () => {
    const { desktop, pipe, received } = establishedRig();
    const oldStreams = desktop.streams;
    desktop.beginHandshake();
    pipe.deliverToPhone();
    pipe.deliverToDesktop();
    desktop.send('new-key');
    desktop.send('late-old-key', oldStreams);
    pipe.deliverToPhone();

    expect(received).toEqual(['new-key']);
    expect(traceEvents('frame-open-failed')).toHaveLength(1);
    expect(traceEvents('frame-open-failed')[0]).toMatchObject({ generations: 1, failedOpens: 1 });
  });

  /**
   * The re-probe shape: a reply stalls, the desktop's presence window sends a
   * second msg1, and the phone answers both and ends two generations ahead.
   * The desktop then seals under the old keys (nothing read yet), under A
   * (after reading reply A, before reply B), and under B. A single "previous"
   * slot would lose one of them.
   */
  it('opens frames under the old keys, the intermediate keys and the newest keys when two msg1s are answered', () => {
    const { desktop, pipe, received } = establishedRig();
    desktop.beginHandshake();
    desktop.beginHandshake();
    desktop.send('old-keys');
    pipe.deliverToPhone();

    pipe.deliverOneToDesktop();
    desktop.send('keys-a');
    pipe.deliverOneToDesktop();
    desktop.send('keys-b');
    pipe.deliverToPhone();

    expect(received).toEqual(['old-keys', 'keys-a', 'keys-b']);
    expect(traceEvents('frame-open-failed')).toEqual([]);
  });

  /**
   * The case a "keep only the last stream a frame opened under" rule gets
   * wrong. Rekey A completes while the desktop is idle, so A never opens a
   * frame. Then two msg1s go unanswered past the desktop's 10 s hold, which
   * releases what it held under the keys it holds: A. The phone is on C by
   * then, with A two generations back.
   */
  it('opens a deadline release sealed under keys that were installed but never used', () => {
    const { desktop, pipe, received } = establishedRig();
    desktop.send('under-original');
    pipe.deliverToPhone();
    desktop.beginHandshake();
    pipe.deliverToPhone();
    pipe.deliverToDesktop();

    desktop.beginHandshake();
    desktop.beginHandshake();
    pipe.deliverToPhone();
    desktop.send('deadline-release-under-a');
    pipe.deliverToPhone();
    pipe.deliverToDesktop();
    desktop.send('under-c');
    pipe.deliverToPhone();

    expect(received).toEqual(['under-original', 'deadline-release-under-a', 'under-c']);
    expect(traceEvents('frame-opened-retired').map((fields) => fields?.generationsBack)).toEqual([2]);
  });

  /**
   * The age bound, WireGuard's REJECT_AFTER_TIME: a retired stream opens a
   * frame for 180 s after the rekey that superseded it, and not after. The
   * first frame inside the bound is the control: without it, a stream that was
   * never kept at all would pass the second half.
   *
   * Mutation seen failing: replacing the age comparison in expireRetired with
   * `true` - 'old-keys-past-bound' was received.
   */
  it('stops opening under a retired stream 180 s after the rekey that superseded it', () => {
    vi.useFakeTimers();
    const { desktop, pipe, received } = establishedRig();
    const oldStreams = desktop.streams;
    desktop.beginHandshake();
    pipe.deliverToPhone();

    vi.advanceTimersByTime(RETIRED_RECEIVE_STREAM_MAX_AGE_MS - 1_000);
    desktop.send('old-keys-inside-bound', oldStreams);
    pipe.deliverToPhone();
    vi.advanceTimersByTime(2_000);
    desktop.send('old-keys-past-bound', oldStreams);
    pipe.deliverToPhone();

    expect(received).toEqual(['old-keys-inside-bound']);
    expect(traceEvents('frame-open-failed')).toHaveLength(1);
  });

  /**
   * A reset ends the session: nothing sealed for it may open afterwards,
   * retired streams included, even before a new handshake lands.
   *
   * Mutation seen failing: deleting `this.receiveStreams.clear()` from
   * reset() - 'after-reset' was received.
   */
  it('opens nothing from the previous session after a reset, retired streams included', () => {
    const { phone, desktop, pipe, received } = establishedRig();
    const oldStreams = desktop.streams;
    desktop.beginHandshake();
    pipe.deliverToPhone();

    phone.reset();
    desktop.send('after-reset', oldStreams);
    pipe.deliverToPhone();

    expect(received).toEqual([]);
    expect(phone.isEstablished).toBe(false);
  });

  /**
   * The trace build's switch-off arm, which measures the "before" in the same
   * build: frames in the window are dropped and counted, exactly as before the
   * fix, and the next frame under the new keys still opens.
   */
  it('drops and counts the in-window frames when the retired-streams switch is off', () => {
    traceMocks.retiredReceiveStreamsEnabled.mockReturnValue(false);
    const { desktop, pipe, received } = establishedRig();
    desktop.beginHandshake();
    desktop.send('during-rekey-1');
    desktop.send('during-rekey-2');
    pipe.deliverToPhone();
    pipe.deliverToDesktop();
    desktop.send('after-rekey');
    pipe.deliverToPhone();

    expect(received).toEqual(['after-rekey']);
    expect(traceEvents('frame-open-failed').map((fields) => fields?.failedOpens)).toEqual([1, 2]);
    expect(traceEvents('frame-opened-retired')).toEqual([]);
  });

  /**
   * The trace build stamps when a frame reached JS, before unwrap and decrypt,
   * and hands it to every listener as the second argument (CapabilityClient's
   * request timing reads it). A non-trace build reads no clock and passes null.
   * The clock is pinned, so the stamp must equal it exactly.
   *
   * Mutation seen failing: passing a constant `null` to handleApplicationFrame
   * in onFrame - the trace-build listener received null instead of the pinned
   * 1_700_000_000_000. The false arm fails under the opposite mutation
   * (`Date.now()` unconditionally): it received the number, not null.
   */
  it('stamps arrival time for listeners in a trace build and passes null otherwise', () => {
    vi.useFakeTimers();
    const pinnedNowMs = 1_700_000_000_000;
    vi.setSystemTime(pinnedNowMs);
    const { phone, desktop, pipe } = establishedRig();
    const arrivals: (number | null)[] = [];
    phone.onMessage((_message, arrivedAtMs) => arrivals.push(arrivedAtMs));

    traceMocks.connectionTraceEnabled.mockReturnValue(true);
    desktop.send('traced');
    pipe.deliverToPhone();
    traceMocks.connectionTraceEnabled.mockReturnValue(false);
    vi.setSystemTime(pinnedNowMs + 5_000);
    desktop.send('untraced');
    pipe.deliverToPhone();

    expect(arrivals).toEqual([pinnedNowMs, null]);
  });

  /**
   * A heartbeat the desktop sealed under its OLD keys (it had not read msg2
   * yet) opens under the phone's retired receive stream, and the reply must be
   * sealed under the phone's CURRENT send stream: msg2 is ahead of it on the
   * wire, so the desktop has switched by the time it reads the reply. The
   * desktop here only counts a reply that opens under the streams it installed
   * from msg2.
   *
   * Mutation seen failing, two ways. (1) Passing `{ keepRetired: false }` to
   * the rekey install in handleHandshakeFrame: the heartbeat never opened, so
   * the desktop got no reply (openedFromPhone was []), and
   * no frame-opened-retired line fired either. (2) Keeping the old send stream across a
   * rekey (`this.sendStream = wasEstablished ? this.sendStream : streams.send`):
   * the reply was sealed under the old keys and did not open under the
   * desktop's new receive stream (openedFromPhone was []).
   */
  it('answers a heartbeat that opened under a retired stream with the current send stream', () => {
    const { desktop, pipe } = establishedRig();
    desktop.beginHandshake();
    pipe.deliverToPhone();
    desktop.sendMessage({ type: 'heartbeat' });
    pipe.deliverToPhone();
    pipe.deliverToDesktop();

    expect(desktop.openedFromPhone).toEqual([{ type: 'heartbeat' }]);
    expect(traceEvents('frame-opened-retired').map((fields) => fields?.generationsBack)).toEqual([1]);
  });

  /**
   * Trace state is per establishment. The first session here rekeys, rescues
   * one frame and loses one, so every counter and the rekey clock are set;
   * then a reset and a fresh handshake start a new establishment, and nothing
   * of that history may carry over into its trace lines.
   */
  function sessionWithRekeyHistory(): { phone: SessionManager; desktop: DesktopLikeInitiator; pipe: DelayedPipe; deadStreams: SecretstreamDirectionPair } {
    const rig = establishedRig();
    const { desktop, pipe } = rig;
    const deadStreams = desktop.streams;
    if (!deadStreams) throw new Error('sessionWithRekeyHistory(): not established');
    desktop.beginHandshake();
    desktop.send('in-window', deadStreams);
    pipe.deliverToPhone();
    pipe.deliverToDesktop();
    desktop.send('new-keys');
    desktop.send('late-old-keys', deadStreams);
    pipe.deliverToPhone();
    expect(traceEvents('frame-opened-retired').map((fields) => fields?.retiredOpens)).toEqual([1]);
    expect(traceEvents('frame-open-failed').map((fields) => fields?.failedOpens)).toEqual([1]);

    rig.phone.reset();
    desktop.beginHandshake();
    pipe.deliverToPhone();
    pipe.deliverToDesktop();
    if (!rig.phone.isEstablished) throw new Error('sessionWithRekeyHistory(): the second establishment did not complete');
    return { phone: rig.phone, desktop, pipe, deadStreams };
  }

  /**
   * Mutations seen failing, each on its own in the fresh-establishment branch
   * of handleHandshakeFrame: removing `this.failedOpenCount = 0;` - the
   * post-reset line read failedOpens [1, 2]; removing
   * `this.lastRekeyAtMs = null;` - the post-reset line carried a number for
   * msSinceRekey where this establishment has had no rekey, so null was
   * expected.
   */
  it('restarts the failed-open count and the rekey clock on a fresh establishment', () => {
    const { desktop, pipe, deadStreams } = sessionWithRekeyHistory();

    desktop.send('from-the-dead-session', deadStreams);
    pipe.deliverToPhone();

    const failures = traceEvents('frame-open-failed');
    expect(failures.map((fields) => fields?.failedOpens)).toEqual([1, 1]);
    expect(typeof failures[0]?.msSinceRekey).toBe('number');
    expect(failures[1]?.msSinceRekey).toBeNull();
  });

  /**
   * Mutation seen failing: removing `this.retiredOpenCount = 0;` from the
   * fresh-establishment branch of handleHandshakeFrame - the rescue after the
   * new session's own rekey read retiredOpens [1, 2].
   */
  it('restarts the retired-open count on a fresh establishment', () => {
    const { desktop, pipe } = sessionWithRekeyHistory();

    desktop.beginHandshake();
    desktop.send('in-window-of-second-session');
    pipe.deliverToPhone();

    const rescues = traceEvents('frame-opened-retired');
    expect(rescues.map((fields) => fields?.retiredOpens)).toEqual([1, 1]);
    expect(typeof rescues[1]?.msSinceRekey).toBe('number');
  });
});
