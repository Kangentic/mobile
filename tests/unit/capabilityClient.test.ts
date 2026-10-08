import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeMessage, CapabilityRequestMessage } from '@kangentic/protocol';
import { CapabilityClient, CapabilityTimeoutError, ChannelDisconnectedError } from '@/channel/capabilityClient';
import type { MessageListener, SessionManager } from '@/channel/sessionManager';

/**
 * The trace gate and sink, so the request-timing tests below can turn the
 * trace build on. Off by default, which is what every store build reads and
 * what the typed-rejection tests run under.
 */
const traceMocks = vi.hoisted(() => ({
  connectionTraceEnabled: vi.fn<() => boolean>(() => false),
  traceConnection: vi.fn<(event: string, fields?: Record<string, unknown>) => void>(),
}));
vi.mock('@/devsupport/connectionTrace', () => traceMocks);

/**
 * The two typed rejections the handled-error door relies on. Without a class
 * for the mid-request socket drop, the door would have nothing to exclude for
 * the single most common normal condition on a phone, and a message match
 * would creep back in; without one for the timeout, the verb it carries could
 * only be read out of the message. Messages stay byte-for-byte what they were.
 */

/** Only the two members CapabilityClient touches; the rest of SessionManager is irrelevant here. */
function stubSessionManager(): SessionManager {
  const stub: Pick<SessionManager, 'onMessage' | 'send'> = {
    onMessage: vi.fn(() => () => undefined),
    send: vi.fn(),
  };
  return stub as SessionManager;
}

describe('CapabilityClient typed rejections', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('rejects a timed-out request with CapabilityTimeoutError carrying the verb', async () => {
    const client = new CapabilityClient(stubSessionManager(), 50);
    const request = client.request('read-board', {});
    // Attach the handler before the timer fires, so the rejection is observed
    // rather than reported as unhandled.
    const outcome = request.then(
      () => 'resolved',
      (error: unknown) => error,
    );

    vi.advanceTimersByTime(50);
    const error = await outcome;

    expect(error).toBeInstanceOf(CapabilityTimeoutError);
    expect(error).toBeInstanceOf(Error);
    expect((error as CapabilityTimeoutError).verb).toBe('read-board');
    expect((error as Error).name).toBe('CapabilityTimeoutError');
    expect((error as Error).message).toBe('Capability request "read-board" timed out');
  });

  it('rejects every in-flight request with ChannelDisconnectedError when the transport drops', async () => {
    const client = new CapabilityClient(stubSessionManager());
    const outcomes = [client.request('read-board', {}), client.request('move-task', {})].map((request) =>
      request.then(
        () => 'resolved',
        (error: unknown) => error,
      ),
    );

    client.rejectAllPending('Channel disconnected');
    const errors = await Promise.all(outcomes);

    for (const error of errors) {
      expect(error).toBeInstanceOf(ChannelDisconnectedError);
      expect((error as Error).name).toBe('ChannelDisconnectedError');
      expect((error as Error).message).toBe('Channel disconnected');
    }
  });
});

/** A SessionManager stand-in that hands the test its message listener and the requests sent. */
function wiredSessionManager(): { session: SessionManager; sent: BridgeMessage[]; deliver: MessageListener } {
  const sent: BridgeMessage[] = [];
  let listener: MessageListener | null = null;
  const stub: Pick<SessionManager, 'onMessage' | 'send'> = {
    onMessage: (registered) => {
      listener = registered;
      return () => undefined;
    },
    send: (message) => {
      sent.push(message);
    },
  };
  return {
    session: stub as SessionManager,
    sent,
    deliver: (message, arrivedAtMs) => listener?.(message, arrivedAtMs),
  };
}

/**
 * Task #109's request timing: T1 when the sealed request left, T4 when its
 * response's frame reached JS (SessionManager's stamp), and the dispatch
 * instant, keyed by the full requestId so the line joins the desktop's
 * `[mobile-bridge] slow request` line for the same round trip.
 */
describe('CapabilityClient request timing (trace build)', () => {
  const startMs = 1_000_000;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(startMs);
    traceMocks.connectionTraceEnabled.mockReturnValue(true);
    traceMocks.traceConnection.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    traceMocks.connectionTraceEnabled.mockReturnValue(false);
  });

  /**
   * Mutation seen failing: computing `roundTripMs` from `dispatchedAtMs`
   * instead of `arrivedAtMs` folded the phone's 7 ms into the wire - the
   * diff read `roundTripMs: 100` against the expected 93.
   */
  it('traces T1, T4 and the dispatch instant under the full requestId', async () => {
    const { session, sent, deliver } = wiredSessionManager();
    const client = new CapabilityClient(session);
    const response = client.request('read-board', {});
    const requestId = (sent[0] as CapabilityRequestMessage).requestId;

    vi.setSystemTime(startMs + 100);
    deliver({ type: 'capability-response', requestId, ok: true }, startMs + 93);
    await response;

    const timing = traceMocks.traceConnection.mock.calls.find(([event]) => event === 'request-timing')?.[1];
    expect(timing).toEqual({
      requestId,
      verb: 'read-board',
      ok: true,
      sentAtMs: startMs,
      arrivedAtMs: startMs + 93,
      dispatchedAtMs: startMs + 100,
      roundTripMs: 93,
      phoneMs: 7,
    });
    // The full id, never a prefix: the desktop logs it whole.
    expect(requestId).toHaveLength(32);
  });

  it('traces request-timeout with the full requestId and the verb when nothing answers', async () => {
    const { session, sent } = wiredSessionManager();
    const client = new CapabilityClient(session, 50);
    const outcome = client.request('move-task', {}).catch((error: unknown) => error);
    const requestId = (sent[0] as CapabilityRequestMessage).requestId;

    vi.advanceTimersByTime(50);
    expect(await outcome).toBeInstanceOf(CapabilityTimeoutError);

    expect(traceMocks.traceConnection).toHaveBeenCalledWith('request-timeout', { requestId, verb: 'move-task', timeoutMs: 50 });
  });

  it('traces no timing outside a trace build, where nothing is stamped', async () => {
    traceMocks.connectionTraceEnabled.mockReturnValue(false);
    const { session, sent, deliver } = wiredSessionManager();
    const client = new CapabilityClient(session);
    const response = client.request('read-board', {});
    const requestId = (sent[0] as CapabilityRequestMessage).requestId;

    deliver({ type: 'capability-response', requestId, ok: true }, null);
    await response;

    expect(traceMocks.traceConnection.mock.calls.filter(([event]) => event === 'request-timing')).toEqual([]);
  });

  /**
   * Mutation seen failing: narrowing the guard in `resolvePending` to
   * `arrivedAtMs !== null` alone emitted a `request-timing` line for a request
   * that was never stamped at send time: the line read `sentAtMs: null` and
   * `roundTripMs: 1000093` (arrivedAtMs minus null), where the expected result
   * was no `request-timing` line at all.
   */
  it('traces no timing when the request was sent with the trace gate off, even if the response is stamped', async () => {
    traceMocks.connectionTraceEnabled.mockReturnValue(false);
    const { session, sent, deliver } = wiredSessionManager();
    const client = new CapabilityClient(session);
    const response = client.request('read-board', {});
    const requestId = (sent[0] as CapabilityRequestMessage).requestId;

    // The gate flips on before the answer lands; the request itself was never stamped.
    traceMocks.connectionTraceEnabled.mockReturnValue(true);
    vi.setSystemTime(startMs + 100);
    const answer = { type: 'capability-response', requestId, ok: true } as const;
    deliver(answer, startMs + 93);

    await expect(response).resolves.toEqual(answer);
    expect(traceMocks.traceConnection.mock.calls.filter(([event]) => event === 'request-timing')).toEqual([]);
  });

  /**
   * Mutation seen failing: narrowing the guard in `resolvePending` to
   * `entry.sentAtMs !== null` alone emitted a `request-timing` line with
   * `arrivedAtMs: null` and a meaningless `roundTripMs: -1000000`, where the
   * expected result was no `request-timing` line at all.
   */
  it('traces no timing when the request was stamped but the response carries no arrival stamp', async () => {
    const { session, sent, deliver } = wiredSessionManager();
    const client = new CapabilityClient(session);
    const response = client.request('read-board', {});
    const requestId = (sent[0] as CapabilityRequestMessage).requestId;

    vi.setSystemTime(startMs + 100);
    const answer = { type: 'capability-response', requestId, ok: true } as const;
    deliver(answer, null);

    await expect(response).resolves.toEqual(answer);
    expect(traceMocks.traceConnection.mock.calls.filter(([event]) => event === 'request-timing')).toEqual([]);
  });
});
