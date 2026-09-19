/**
 * RelayTransport's reconnect ladder and the foreground kick (redialNow).
 *
 * Board task #70: a phone that comes back to the foreground with its relay
 * socket dead used to wait out the remainder of an already-ratcheted backoff
 * (up to MAX_BACKOFF_MS, 15 s) before the first dial, because nothing in the
 * app dialed on 'active' - connectionManager kept the connection it had, and
 * the transport's own timer was the only thing that would. The kick abandons
 * that wait. This file pins both the ladder that produces the wait and the
 * kick that ends it.
 *
 * The ladder cannot be held at its cap against a real socket without real
 * seconds passing, so this file replaces the global WebSocket with a fake the
 * test drives by hand (fire onopen / onclose directly) under a fake clock.
 * relayTransport.ts resolves `WebSocket` from the global at call time, and
 * vitest isolates globals per file, so tests/unit/relayTransport.test.ts (the
 * real `ws` server) is untouched. The fake covers exactly the surface the
 * transport uses: a one-argument constructor, `binaryType`, the four `on*`
 * handlers, `send`, `close`. onclose reads only `event.code`.
 *
 * Every close here is 1006 (abnormal), never 4408 or 4409: those carry a
 * SLOW_RETRY floor that would make the "re-arms at 500" assertions fail for
 * the wrong reason. The floor itself is pinned in its own test.
 *
 * Seen failing first (regression-tests-fail-first.md), each against a named
 * mutation of relayTransport.ts recorded on the test it belongs to.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayTransport } from '@/channel/relayTransport';

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  binaryType = 'blob';
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((event: { code?: number }) => void) | null = null;
  closeCalls = 0;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(): void {}

  close(): void {
    this.closeCalls += 1;
  }

  /** The relay accepted the upgrade. */
  open(): void {
    this.onopen?.();
  }

  /** The socket died (or the dial never completed) with this close code. */
  fail(code: number): void {
    this.onclose?.({ code });
  }
}

function socketCount(): number {
  return FakeWebSocket.instances.length;
}

function latestSocket(): FakeWebSocket {
  const socket = FakeWebSocket.instances.at(-1);
  if (!socket) throw new Error('no WebSocket has been constructed yet');
  return socket;
}

function createTransport(): RelayTransport {
  return new RelayTransport({ relayUrl: 'ws://relay.test', slotId: 'a'.repeat(32) });
}

async function connectAndOpen(): Promise<RelayTransport> {
  const transport = createTransport();
  const connecting = transport.connect();
  latestSocket().open();
  await connecting;
  expect(transport.state).toBe('connected');
  expect(socketCount()).toBe(1);
  return transport;
}

/**
 * Drops the open socket and fails the next five dials at each rung of the
 * ladder (500, 1000, 2000, 4000, 8000 ms), which leaves the SIXTH retry armed
 * at the 15 s cap. Straddles every boundary by one millisecond, the way
 * connectionManagerBootstrapRetry.test.ts pins its own retry delays, so a
 * ladder that fired early or late would fail on the rung, not at the end.
 */
async function ratchetToCap(): Promise<void> {
  latestSocket().fail(1006);
  for (const delayMs of [500, 1000, 2000, 4000, 8000]) {
    const before = socketCount();
    await vi.advanceTimersByTimeAsync(delayMs - 1);
    expect(socketCount()).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(socketCount()).toBe(before + 1);
    latestSocket().fail(1006);
  }
  expect(socketCount()).toBe(6);
}

describe('RelayTransport reconnect ladder', () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  /**
   * The doubling and the cap, pinned separately: a ladder that kept doubling
   * past 15 s would pass the rungs and fail here.
   */
  it('doubles the backoff to a 15 s cap and holds it there', async () => {
    const transport = await connectAndOpen();
    await ratchetToCap();
    expect(transport.state).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(14_999);
    expect(socketCount()).toBe(6);
    await vi.advanceTimersByTimeAsync(1);
    expect(socketCount()).toBe(7);

    latestSocket().fail(1006);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(socketCount()).toBe(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(socketCount()).toBe(8);
  });

  /**
   * THE regression test for #70. With the sixth retry armed at the cap, the
   * kick has to construct a socket synchronously - not after the remainder.
   * The second half is the hazard the fix must not introduce: the stale timer
   * has to be cleared, or fifteen seconds later a second dial lands on top of
   * the kicked one and the loser's onclose nulls the winner.
   *
   * Mutations seen failing: an empty redialNow body fails the first assertion
   * ("expected 7, received 6"); dropping the clearTimeout inside redialNow
   * fails the second ("expected 7, received 8").
   */
  it('dials at once when kicked mid-backoff, and the stale timer never fires', async () => {
    const transport = await connectAndOpen();
    await ratchetToCap();
    await vi.advanceTimersByTimeAsync(1);
    expect(socketCount()).toBe(6);

    transport.redialNow();
    expect(socketCount()).toBe(7);
    expect(transport.state).toBe('reconnecting');

    // The kicked socket stays CONNECTING the whole time, so any further
    // socket here can only be the stale timer firing.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socketCount()).toBe(7);

    latestSocket().open();
    expect(transport.state).toBe('connected');
  });

  /**
   * The kick resets the ladder, not just the timer: a kicked dial that fails
   * retries at the floor, not at the cap it was abandoned from. Mutation seen
   * failing: dropping the `reconnectBackoffMs = INITIAL_BACKOFF_MS` line
   * ("expected 8, received 7" after 500 ms).
   */
  it('restarts the ladder at 500 ms after a kick', async () => {
    const transport = await connectAndOpen();
    await ratchetToCap();
    await vi.advanceTimersByTimeAsync(1);
    transport.redialNow();
    expect(socketCount()).toBe(7);

    latestSocket().fail(1006);
    await vi.advanceTimersByTimeAsync(499);
    expect(socketCount()).toBe(7);
    await vi.advanceTimersByTimeAsync(1);
    expect(socketCount()).toBe(8);
  });

  /**
   * The kick must be safe to call from the 'active' branch unconditionally,
   * which means every state where a dial would be wrong is a no-op: never
   * connected (nothing to resume), explicitly closed (torn down), healthy
   * (nothing to fix), and a dial already in flight (a second socket is the
   * two-live-sockets hazard).
   */
  it('is a no-op when idle, closed, connected, or mid-dial', async () => {
    const idle = createTransport();
    idle.redialNow();
    expect(socketCount()).toBe(0);
    expect(idle.state).toBe('idle');

    const closed = await connectAndOpen();
    closed.close();
    closed.redialNow();
    expect(socketCount()).toBe(1);
    expect(closed.state).toBe('closed');
    FakeWebSocket.instances = [];

    const healthy = await connectAndOpen();
    healthy.redialNow();
    expect(socketCount()).toBe(1);
    expect(healthy.state).toBe('connected');
    expect(latestSocket().closeCalls).toBe(0);
    FakeWebSocket.instances = [];

    const midDial = createTransport();
    void midDial.connect().catch(() => {});
    expect(socketCount()).toBe(1);
    midDial.redialNow();
    expect(socketCount()).toBe(1);
    expect(midDial.state).toBe('connecting');
    midDial.close();
  });

  /**
   * scheduleReconnect arms its timer BEFORE notifying state listeners, so a
   * listener that reacts by kicking clears that timer rather than racing it.
   * Mutation seen failing: moving the setState('reconnecting') back above the
   * setTimeout ("expected 2, received 3" after the advance).
   */
  it('a kick from inside a state listener does not leave a second dial armed', async () => {
    const transport = await connectAndOpen();
    transport.onStateChange((state) => {
      if (state === 'reconnecting') transport.redialNow();
    });

    latestSocket().fail(1006);
    expect(socketCount()).toBe(2);

    await vi.advanceTimersByTimeAsync(15_000);
    expect(socketCount()).toBe(2);
  });

  /**
   * The forced variant, for the foreground probe: a socket that reads open
   * but carries nothing. The abandoned socket's handlers come off BEFORE it is
   * closed, so its own late onclose (a real socket fires one for close()) can
   * neither null the socket the forced dial installs nor arm a reconnect on
   * top of it. Mutation seen failing: skipping the handler detach in
   * abandonSocket ("expected 2, received 3" once the abandoned socket reports
   * its close and the ladder fires).
   */
  it('force-redials over an open socket and ignores that socket afterwards', async () => {
    const transport = await connectAndOpen();
    const abandoned = latestSocket();

    transport.redialNow({ force: true });
    expect(abandoned.closeCalls).toBe(1);
    expect(socketCount()).toBe(2);
    expect(transport.state).toBe('reconnecting');

    // The abandoned socket reports its close late, as a real one would.
    abandoned.fail(1006);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(socketCount()).toBe(2);

    latestSocket().open();
    expect(transport.state).toBe('connected');
  });

  /**
   * The force branch's OTHER duty: a socket abandoned mid-dial (never
   * opened) must reject the promise `connect()` handed the caller, not leave
   * it hanging forever. The force test above starts from an already OPEN
   * socket (`connectAndOpen()`), so `pendingDialReject` is already null by
   * the time it kicks and the rejection branch inside `abandonSocket()` is
   * never reached. This test starts the kick before `onopen` ever fires, so
   * that branch is the one actually exercised.
   *
   * Mutation seen failing: deleting the `if (this.pendingDialReject) { ... }`
   * block from `abandonSocket()` left `connecting` permanently unsettled -
   * the awaited rejection below never resolved and the test failed on
   * vitest's own "Test timed out in 5000ms" rather than an assertion.
   */
  it('rejects the pending dial promise when a forced redial abandons a socket mid-dial', async () => {
    const transport = createTransport();
    const connecting = transport.connect();
    expect(socketCount()).toBe(1);

    transport.redialNow({ force: true });

    expect(socketCount()).toBe(2);
    await expect(connecting).rejects.toThrow('Relay connection abandoned by a forced redial');
  });

  /**
   * A park timeout means nobody is home on the slot, and the 5 s floor keeps
   * the phone from hammering an empty rendezvous. Pinned so the value is a
   * deliberate edit rather than drift.
   */
  it('retries no sooner than 5 s after a park-timeout close', async () => {
    await connectAndOpen();
    latestSocket().fail(4408);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(socketCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socketCount()).toBe(2);
  });

  /**
   * Slot busy used to share the 5 s floor. On a slot this phone itself just
   * held, the 4409 is the relay probing the phone's own zombie socket
   * (rendezvous.ts probePairedSlot, a 2 s window), after which the zombie is
   * terminated and the slot is free. Measured on task #70's forced-redial
   * path, the phone was waiting 5 s for a slot that had been free for 3.
   */
  it('retries just past the relay contention probe after a slot-busy close', async () => {
    await connectAndOpen();
    latestSocket().fail(4409);
    await vi.advanceTimersByTimeAsync(2_499);
    expect(socketCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(socketCount()).toBe(2);
  });

  /**
   * The dial URL is the relay's wire contract: `slot` is the rendezvous label
   * and `role=mobile` is the metrics hint the relay attributes its
   * waiting-peer gauge by (kangentic-relay's src/guards/peerRole.ts, an exact
   * literal match that collapses anything else to 'unknown'). Neither client
   * sent a role during the 2026-09-18 router-restart incident, so the
   * dashboard could not tell the phone's parked socket from the desktop's.
   * Pinned on all three dial paths - the first dial, a ladder rung and the
   * foreground kick - because they only share the value by all going through
   * dial(); a second construction site would drift silently. The URL is
   * string-built (no `new URL()` normalisation, so no slash is inserted after
   * a bare host), and the one branch in that build is the separator: a relay
   * address that already carries a query string joins `slot` with '&', and
   * `role` has to land correctly on that branch too.
   *
   * Mutation seen failing: dropping `&role=mobile` from the template literal
   * in dial() fails the first assertion (Expected
   * "ws://relay.test?slot=aaa...&role=mobile", Received
   * "ws://relay.test?slot=aaa...").
   */
  it('dials ?slot=<id>&role=mobile on the first dial, a reconnect rung and the foreground kick', async () => {
    const expectedUrl = `ws://relay.test?slot=${'a'.repeat(32)}&role=mobile`;

    const transport = await connectAndOpen();
    expect(latestSocket().url).toBe(expectedUrl);

    // A ladder rung.
    latestSocket().fail(1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(socketCount()).toBe(2);
    expect(latestSocket().url).toBe(expectedUrl);

    // The foreground kick, mid-backoff (the ladder is at 1000 ms now).
    latestSocket().fail(1006);
    expect(socketCount()).toBe(2);
    transport.redialNow();
    expect(socketCount()).toBe(3);
    expect(latestSocket().url).toBe(expectedUrl);
  });

  /**
   * The separator branch is the one part of the URL build the test above
   * cannot see: `ws://relay.test` carries no query string, so a separator
   * hard-coded to '?' is right there by accident. This relay address already
   * has one, so only the '&' branch passes.
   *
   * Mutation seen failing: replacing the separator ternary in dial() with
   * `const separator = '?'` fails this test alone (Expected
   * "ws://relay.test/path?x=1&slot=aaa...&role=mobile", Received
   * "ws://relay.test/path?x=1?slot=aaa...&role=mobile") while the test above
   * stays green, which is why this one exists.
   */
  it('appends role after slot with & when the relay address already has a query string', async () => {
    const transport = new RelayTransport({ relayUrl: 'ws://relay.test/path?x=1', slotId: 'a'.repeat(32) });
    void transport.connect().catch(() => {});
    expect(latestSocket().url).toBe(`ws://relay.test/path?x=1&slot=${'a'.repeat(32)}&role=mobile`);
    transport.close();
  });
});
