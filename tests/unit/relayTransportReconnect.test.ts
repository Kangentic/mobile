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
import { isRelayDialId } from '@/observability/reportVocabulary';

/**
 * The dev connection trace is a no-op unless an env flag is set, so replacing
 * it with a recorder changes nothing for the other tests in this file. The
 * dial id tests below read back what the transport asked it to log.
 */
const traceState = vi.hoisted(() => ({ traceConnection: vi.fn() }));
vi.mock('@/devsupport/connectionTrace', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/devsupport/connectionTrace')>()),
  traceConnection: traceState.traceConnection,
}));

/** The `dial` field of every trace line of one event name, in order. */
function tracedDials(eventName: string): unknown[] {
  return traceState.traceConnection.mock.calls
    .filter(([name]) => name === eventName)
    .map(([, fields]) => (fields as Record<string, unknown> | undefined)?.dial);
}

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
   * The dial URL is the relay's wire contract: `slot` is the rendezvous label,
   * `role=mobile` is the metrics hint the relay attributes its waiting-peer
   * gauge by (kangentic-relay's src/guards/peerRole.ts, an exact literal match
   * that collapses anything else to 'unknown'), and `dial` is the per-attempt
   * id that joins a crash report to the relay's record of the dial (the
   * desktop repo's docs/integrations/mobile-bridge/relay-transport.md owns
   * that contract). Neither client
   * sent a role during the 2026-09-18 router-restart incident, so the
   * dashboard could not tell the phone's parked socket from the desktop's.
   * Pinned on all three dial paths - the first dial, a ladder rung and the
   * foreground kick - because they only share the value by all going through
   * dial(); a second construction site would drift silently. The URL is
   * string-built (no `new URL()` normalisation, so no slash is inserted after
   * a bare host), and the one branch in that build is the separator: a relay
   * address that already carries a query string joins `slot` with '&', and
   * `role` and `dial` have to land correctly on that branch too.
   *
   * The dial id must be NEW on every one of the three, never per install,
   * pairing or transport: a persistent id would let the relay's logs link one
   * phone's connections over time.
   *
   * Mutations seen failing: dropping `&role=mobile` from the template literal
   * in dial() fails the shape assertion on the first dial; minting the id once
   * in the constructor instead of in dial() fails the distinct-ids assertion
   * (Expected 3 distinct ids, Received 1).
   */
  it('dials ?slot=<id>&role=mobile&dial=<fresh id> on the first dial, a reconnect rung and the foreground kick', async () => {
    const expectedShape = new RegExp(`^ws://relay\\.test\\?slot=${'a'.repeat(32)}&role=mobile&dial=[0-9a-f]{16}$`);

    const transport = await connectAndOpen();
    expect(latestSocket().url).toMatch(expectedShape);

    // A ladder rung.
    latestSocket().fail(1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(socketCount()).toBe(2);
    expect(latestSocket().url).toMatch(expectedShape);

    // The foreground kick, mid-backoff (the ladder is at 1000 ms now).
    latestSocket().fail(1006);
    expect(socketCount()).toBe(2);
    transport.redialNow();
    expect(socketCount()).toBe(3);
    expect(latestSocket().url).toMatch(expectedShape);

    const dialIds = FakeWebSocket.instances.map((socket) => dialIdOf(socket.url));
    expect(new Set(dialIds).size).toBe(3);
  });

  /**
   * The separator branch is the one part of the URL build the test above
   * cannot see: `ws://relay.test` carries no query string, so a separator
   * hard-coded to '?' is right there by accident. This relay address already
   * has one, so only the '&' branch passes.
   *
   * Mutation seen failing: replacing the separator ternary in dial() with
   * `const separator = '?'` fails this test alone (Received
   * "ws://relay.test/path?x=1?slot=aaa...&role=mobile&dial=...") while the
   * test above stays green, which is why this one exists.
   */
  it('appends role and dial after slot with & when the relay address already has a query string', async () => {
    const transport = new RelayTransport({ relayUrl: 'ws://relay.test/path?x=1', slotId: 'a'.repeat(32) });
    void transport.connect().catch(() => {});
    expect(latestSocket().url).toMatch(
      new RegExp(`^ws://relay\\.test/path\\?x=1&slot=${'a'.repeat(32)}&role=mobile&dial=[0-9a-f]{16}$`),
    );
    transport.close();
  });
});

/** The `dial` parameter of a dial URL. Throws when it is missing, so a test cannot pass on `undefined`. */
function dialIdOf(url: string): string {
  const match = /[?&]dial=([^&]*)$/.exec(url);
  if (!match?.[1]) throw new Error(`no dial parameter in ${url}`);
  return match[1];
}

/**
 * The dial id as the rest of the app sees it: `relayDialId` and `onDial`,
 * which connectionManager feeds into the store and from there onto the crash
 * report's `relay_dial_id` tag (src/state/connectionBreadcrumbs.ts).
 */
describe('RelayTransport dial id', () => {
  beforeEach(() => {
    traceState.traceConnection.mockClear();
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('has no dial id before the first dial', () => {
    expect(createTransport().relayDialId).toBeNull();
  });

  /**
   * The id announced, the id held and the id on the wire are one value, and it
   * is announced BEFORE the dial's state change, so a store listener that
   * reacts to 'connecting' already holds the id of the dial that caused it.
   * The minted id also passes the door's own format check, which is declared
   * separately (src/observability/reportVocabulary.ts) because neither
   * directory may import the other.
   *
   * Mutation seen failing: moving the listener loop below
   * `this.setState(...)` in dial() fails the order assertion (Expected
   * ['dial', 'state:connecting'], Received ['state:connecting', 'dial']).
   */
  it('announces each dial id before that dial changes state, and it is the id on the wire', () => {
    const transport = createTransport();
    const events: string[] = [];
    const announced: string[] = [];
    transport.onDial((dialId) => {
      events.push('dial');
      announced.push(dialId);
    });
    transport.onStateChange((state) => events.push(`state:${state}`));

    void transport.connect().catch(() => {});

    expect(events).toEqual(['dial', 'state:connecting']);
    expect(announced).toHaveLength(1);
    expect(announced[0]).toBe(dialIdOf(latestSocket().url));
    expect(transport.relayDialId).toBe(announced[0]);
    expect(isRelayDialId(announced[0])).toBe(true);
    transport.close();
  });

  /**
   * The reason `onDial` exists rather than reading the id on a state change: in
   * a failing retry loop the transport sits in 'reconnecting' and every redial
   * after the first raises NO state event, yet each is a separate dial the
   * relay records under its own id.
   *
   * Mutation seen failing: notifying dial listeners from setState() instead of
   * from dial() fails it (Expected length 5, Received 1: only the one real
   * state change announced anything).
   */
  it('announces every redial of a failing loop, though the state stays reconnecting', async () => {
    const transport = await connectAndOpen();
    const announced: string[] = [];
    const states: string[] = [];
    transport.onDial((dialId) => announced.push(dialId));
    transport.onStateChange((state) => states.push(state));

    latestSocket().fail(1006);
    for (const delayMs of [500, 1000, 2000, 4000, 8000]) {
      await vi.advanceTimersByTimeAsync(delayMs);
      latestSocket().fail(1006);
    }

    expect(states).toEqual(['reconnecting']);
    expect(announced).toHaveLength(5);
    expect(new Set(announced).size).toBe(5);
    expect(announced).toEqual(FakeWebSocket.instances.slice(1).map((socket) => dialIdOf(socket.url)));
    expect(transport.relayDialId).toBe(announced.at(-1));
    transport.close();
  });

  it('names a dial whose socket constructor throws, which is still an attempt', () => {
    vi.stubGlobal(
      'WebSocket',
      class ThrowingWebSocket {
        constructor() {
          throw new Error('bad url');
        }
      },
    );
    const transport = createTransport();
    const announced: string[] = [];
    transport.onDial((dialId) => announced.push(dialId));

    void transport.connect().catch(() => {});

    expect(announced).toHaveLength(1);
    expect(transport.relayDialId).toBe(announced[0]);
    transport.close();
  });

  /**
   * The dev trace's dial, open and close lines each name THEIR socket's dial,
   * which is what lets a logcat timeline be joined to the relay's record. The
   * close line is the one that can lie: a socket's late onclose can land after
   * a newer dial replaced `currentDialId`, and it must still carry its own id
   * (the one captured in dial()'s closure). A forced redial cannot make that
   * case, because abandonSocket() nulls the old onclose first, so this one
   * closes the transport, dials again and then lets the OLD socket report.
   *
   * Mutation seen failing: tracing `dial: this.currentDialId` instead of
   * `dial: dialId` in the onclose handler fails the close assertion
   * (Expected the first socket's id, Received the second socket's id).
   */
  it('traces dial, open and close with their own socket dial id, even for a late close after a newer dial', async () => {
    const transport = await connectAndOpen();
    const firstSocket = latestSocket();
    const firstDialId = dialIdOf(firstSocket.url);

    transport.close();
    void transport.connect().catch(() => {});
    expect(socketCount()).toBe(2);
    const secondDialId = dialIdOf(latestSocket().url);
    expect(secondDialId).not.toBe(firstDialId);
    expect(transport.relayDialId).toBe(secondDialId);

    // The first socket reports its close only now, after the second dial.
    firstSocket.fail(1006);

    expect(tracedDials('dial')).toEqual([firstDialId, secondDialId]);
    expect(tracedDials('open')).toEqual([firstDialId]);
    expect(tracedDials('close')).toEqual([firstDialId]);

    transport.close();
  });

  /**
   * dial() is not async, so a listener that throws used to escape
   * synchronously: from the reconnect timer that is an uncaught error with no
   * socket and no re-armed timer, which ends the retry ladder. Each listener
   * call is isolated, so an observer's failure never costs the dial.
   *
   * Mutation seen failing: replacing the try/catch around `listener(dialId)`
   * in dial() with a bare `listener(dialId);` fails the first-dial assertion
   * (connect() is async, so the throw becomes a rejection and no socket is
   * built: Expected 1, Received 0). The next test covers the timer path.
   */
  it('still dials, first and on every redial, when a dial listener throws', async () => {
    const transport = createTransport();
    transport.onDial(() => {
      throw new Error('listener failure');
    });

    let connecting: Promise<void> | undefined;
    expect(() => {
      connecting = transport.connect();
    }).not.toThrow();
    connecting?.catch(() => {});
    expect(socketCount()).toBe(1);
    const firstDialId = dialIdOf(latestSocket().url);
    latestSocket().open();
    await connecting;

    latestSocket().fail(1006);
    await vi.advanceTimersByTimeAsync(500);

    expect(socketCount()).toBe(2);
    const secondDialId = dialIdOf(latestSocket().url);
    expect(isRelayDialId(secondDialId)).toBe(true);
    expect(secondDialId).not.toBe(firstDialId);
    expect(transport.relayDialId).toBe(secondDialId);

    // The ladder is still armed: a further failure still redials.
    latestSocket().fail(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(socketCount()).toBe(3);
    transport.close();
  });

  /**
   * The reconnect-timer path on its own: the listener behaves for the first
   * dial and throws from the second on, so only the timer's dial() is
   * exposed. Unguarded, that throw escapes the timer callback (an uncaught
   * error) before any socket is constructed.
   *
   * Mutation seen failing: the bare `listener(dialId);` in dial() fails this
   * test with the listener's own error surfacing from the timer callback.
   */
  it('keeps the retry ladder alive when a dial listener throws only on a redial', async () => {
    const transport = createTransport();
    let calls = 0;
    transport.onDial(() => {
      calls += 1;
      if (calls > 1) throw new Error('listener failure');
    });
    const connecting = transport.connect();
    latestSocket().open();
    await connecting;

    latestSocket().fail(1006);
    await vi.advanceTimersByTimeAsync(500);
    expect(socketCount()).toBe(2);
    expect(isRelayDialId(dialIdOf(latestSocket().url))).toBe(true);

    latestSocket().fail(1006);
    await vi.advanceTimersByTimeAsync(1000);
    expect(socketCount()).toBe(3);
    transport.close();
  });

  it('stops announcing to a listener that unsubscribed', async () => {
    const transport = await connectAndOpen();
    const announced: string[] = [];
    const unsubscribe = transport.onDial((dialId) => announced.push(dialId));
    unsubscribe();

    latestSocket().fail(1006);
    await vi.advanceTimersByTimeAsync(500);

    expect(socketCount()).toBe(2);
    expect(announced).toEqual([]);
    transport.close();
  });
});
