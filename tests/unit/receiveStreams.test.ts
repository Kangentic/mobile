/**
 * ReceiveStreams in isolation: the generation cap, the order streams are
 * tried in, and the switch-off arm. The rekey behaviour end to end, against a
 * desktop-like initiator, is tests/unit/sessionManagerRekeyLoss.test.ts.
 *
 * Each generation here is a real secretstream pair derived from its own
 * chaining key: `desktop` seals what the phone's `receive` must open.
 */
import { describe, expect, it, vi } from 'vitest';
import { deriveSecretstreamPair, type SecretstreamDirectionPair } from '@kangentic/protocol';
import { MAX_RETIRED_RECEIVE_STREAMS, ReceiveStreams, RETIRED_RECEIVE_STREAM_MAX_AGE_MS } from '@/channel/receiveStreams';

interface Generation {
  phone: SecretstreamDirectionPair;
  desktop: SecretstreamDirectionPair;
}

function generation(seed: number): Generation {
  const chainingKey = new Uint8Array(32).fill(seed);
  return { phone: deriveSecretstreamPair(chainingKey, false), desktop: deriveSecretstreamPair(chainingKey, true) };
}

function sealFrom(source: Generation, byte: number): Uint8Array {
  return source.desktop.send.seal(new Uint8Array([byte]));
}

describe('ReceiveStreams', () => {
  /**
   * The cap: one newest plus MAX_RETIRED_RECEIVE_STREAMS retired. The stream
   * one past the cap is gone, and the oldest one still inside it opens, which
   * proves the trim drops from the OLD end.
   *
   * Mutation seen failing: changing the trim to `.slice(0, MAX_RETIRED_RECEIVE_STREAMS)`
   * (one fewer) - "expected 8 to be 9" on the size.
   */
  it('keeps the newest stream plus the cap of retired ones, dropping the oldest first', () => {
    const streams = new ReceiveStreams(() => 0);
    const generations = Array.from({ length: MAX_RETIRED_RECEIVE_STREAMS + 2 }, (_, index) => generation(index + 1));
    for (const each of generations) streams.install(each.phone.receive, { keepRetired: true });

    expect(streams.size).toBe(1 + MAX_RETIRED_RECEIVE_STREAMS);
    expect(streams.open(sealFrom(generations[0], 1))).toBeNull();
    expect(streams.open(sealFrom(generations[1], 2))?.generationsBack).toBe(MAX_RETIRED_RECEIVE_STREAMS);
  });

  /**
   * Frames arrive in runs under one key, so the stream that opened the last
   * frame is tried first: inside a rekey window, every old-key frame after the
   * first costs no failed trial under the newest stream.
   *
   * Mutation seen failing: making trialOrder() return `this.generations`
   * unconditionally - the newest stream's open was called once per frame,
   * "expected "open" to be called 1 times, but got 3 times".
   */
  it('tries the stream that opened the last frame before any other', () => {
    const streams = new ReceiveStreams(() => 0);
    const original = generation(1);
    const rekeyed = generation(2);
    streams.install(original.phone.receive, { keepRetired: true });
    streams.install(rekeyed.phone.receive, { keepRetired: true });
    const newestOpen = vi.spyOn(rekeyed.phone.receive, 'open');

    // The first old-key frame has nothing to go on and tries newest first.
    expect(streams.open(sealFrom(original, 1))?.generationsBack).toBe(1);
    expect(newestOpen).toHaveBeenCalledTimes(1);
    // The next ones go straight to the stream that just opened one.
    expect(streams.open(sealFrom(original, 2))?.generationsBack).toBe(1);
    expect(streams.open(sealFrom(original, 3))?.generationsBack).toBe(1);
    expect(newestOpen).toHaveBeenCalledTimes(1);
  });

  it('opens only under the newest stream in the switch-off arm, leaving the retired ones in place', () => {
    const streams = new ReceiveStreams(() => 0);
    const original = generation(1);
    const rekeyed = generation(2);
    streams.install(original.phone.receive, { keepRetired: true });
    streams.install(rekeyed.phone.receive, { keepRetired: true });

    // The same bytes both times: sealing again would move the desktop's
    // counter past the frame the first attempt left unopened.
    const oldKeyFrame = sealFrom(original, 1);
    expect(streams.open(oldKeyFrame, { newestOnly: true })).toBeNull();
    expect(streams.size).toBe(2);
    expect(streams.open(oldKeyFrame)?.generationsBack).toBe(1);
  });

  it('keeps nothing retired when installed with keepRetired false, and nothing at all after clear()', () => {
    const streams = new ReceiveStreams(() => 0);
    const original = generation(1);
    const rekeyed = generation(2);
    streams.install(original.phone.receive, { keepRetired: true });
    streams.install(rekeyed.phone.receive, { keepRetired: false });
    expect(streams.size).toBe(1);
    expect(streams.open(sealFrom(original, 1))).toBeNull();

    streams.clear();
    expect(streams.isEmpty).toBe(true);
    expect(streams.open(sealFrom(rekeyed, 1))).toBeNull();
  });

  /**
   * The age bound is inclusive: a retired stream still opens at exactly
   * RETIRED_RECEIVE_STREAM_MAX_AGE_MS after it was superseded, and is gone one
   * millisecond later. Two fresh setups, so the second does not inherit the
   * first's expiry decision.
   *
   * Mutation seen failing: changing `<=` to `<` in expireRetired - the
   * at-the-bound open returned null, "expected undefined to be 1".
   */
  it('opens an old-key frame at exactly the retired max age and not one millisecond later', () => {
    const supersededAtMs = 5_000;

    const atBoundClock = { nowMs: 0 };
    const atBound = new ReceiveStreams(() => atBoundClock.nowMs);
    const atBoundOriginal = generation(1);
    atBound.install(atBoundOriginal.phone.receive, { keepRetired: true });
    atBoundClock.nowMs = supersededAtMs;
    atBound.install(generation(2).phone.receive, { keepRetired: true });
    atBoundClock.nowMs = supersededAtMs + RETIRED_RECEIVE_STREAM_MAX_AGE_MS;
    expect(atBound.open(sealFrom(atBoundOriginal, 1))?.generationsBack).toBe(1);

    const pastBoundClock = { nowMs: 0 };
    const pastBound = new ReceiveStreams(() => pastBoundClock.nowMs);
    const pastBoundOriginal = generation(1);
    pastBound.install(pastBoundOriginal.phone.receive, { keepRetired: true });
    pastBoundClock.nowMs = supersededAtMs;
    pastBound.install(generation(2).phone.receive, { keepRetired: true });
    pastBoundClock.nowMs = supersededAtMs + RETIRED_RECEIVE_STREAM_MAX_AGE_MS + 1;
    expect(pastBound.open(sealFrom(pastBoundOriginal, 1))).toBeNull();
    expect(pastBound.size).toBe(1);
  });

  /**
   * lastOpened must never outlive its generation: trialOrder() would put a
   * dropped stream back at the front of the trial, and the old-key frame would
   * open under keys the phone had discarded. Here gen1 opens a frame (so it is
   * lastOpened), a keepRetired false install drops it, and a later keepRetired
   * true install makes the trial order matter again.
   *
   * Mutation seen failing: removing the `this.lastOpened = null` line from
   * keep() - the gen1 frame opened under the dropped stream (generationsBack
   * -1, it is in no kept list), "expected { opened: ..., generationsBack: -1 }
   * to be null".
   */
  it('does not reopen a dropped stream through a stale lastOpened after a keepRetired false install', () => {
    const streams = new ReceiveStreams(() => 0);
    const first = generation(1);
    streams.install(first.phone.receive, { keepRetired: true });
    streams.install(generation(2).phone.receive, { keepRetired: true });
    expect(streams.open(sealFrom(first, 1))?.generationsBack).toBe(1);

    streams.install(generation(3).phone.receive, { keepRetired: false });
    expect(streams.size).toBe(1);
    streams.install(generation(4).phone.receive, { keepRetired: true });
    expect(streams.size).toBe(2);

    expect(streams.open(sealFrom(first, 2))).toBeNull();
  });
});
