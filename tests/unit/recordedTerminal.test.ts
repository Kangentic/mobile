/**
 * The recorded-capture replay engine.
 *
 * `playRecordedTerminal` arrived with the mock's terminal rebuild and had no
 * tests: the only thing exercising it was the committed capture, which is a
 * single chunk at offset 0 and therefore cannot reach the batching, the
 * scheduling, or `stop()` at all. Everything interesting about this function
 * only happens on a capture with several chunks spread over time, so these use
 * a synthetic one and fake timers.
 *
 * `stop()` in particular is load-bearing rather than hygiene: mockDesktop
 * restarts the replay on every terminal-bearing subscribe, and stops it when
 * the session ends or respawns. A `stop()` that left one more chunk queued
 * would write the dead session's bytes into the successor's terminal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { playRecordedTerminal, type RecordedTerminalCapture } from '@/devsupport/recordedTerminal';

function captureWithChunks(chunks: { offsetMs: number; data: string }[]): RecordedTerminalCapture {
  return { cols: 44, rows: 38, seedFrame: 'seed', chunks };
}

describe('playRecordedTerminal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits each chunk at its recorded offset, and not before', () => {
    const received: string[] = [];
    playRecordedTerminal(
      captureWithChunks([
        { offsetMs: 0, data: 'first' },
        { offsetMs: 100, data: 'second' },
        { offsetMs: 250, data: 'third' },
      ]),
      (data) => received.push(data),
    );

    vi.advanceTimersByTime(0);
    expect(received).toEqual(['first']);
    vi.advanceTimersByTime(99);
    // Still 99ms in: the second chunk is due at 100 and must not have fired.
    expect(received).toEqual(['first']);
    vi.advanceTimersByTime(1);
    expect(received).toEqual(['first', 'second']);
    vi.advanceTimersByTime(150);
    expect(received).toEqual(['first', 'second', 'third']);
  });

  it('batches every chunk that came due into ONE write', () => {
    // The reason a single self-rescheduling timer exists rather than one timer
    // per chunk: a real capture bursts, and a PTY read loop routinely records
    // several writes on the same millisecond. They must arrive as one write,
    // not as a stutter.
    //
    // Same offset rather than merely close offsets, deliberately. A stepped
    // fake clock lands exactly on each scheduled wake-up, so 0/1/2ms would
    // pump three times and prove nothing about the drain loop. Identical
    // offsets are due together on any clock.
    const received: string[] = [];
    playRecordedTerminal(
      captureWithChunks([
        { offsetMs: 0, data: 'a' },
        { offsetMs: 0, data: 'b' },
        { offsetMs: 120, data: 'c' },
        { offsetMs: 120, data: 'd' },
      ]),
      (data) => received.push(data),
    );

    vi.advanceTimersByTime(0);
    expect(received).toEqual(['ab']);
    vi.advanceTimersByTime(200);
    expect(received).toEqual(['ab', 'cd']);
  });

  it('never calls back with an empty string', () => {
    const received: string[] = [];
    playRecordedTerminal(captureWithChunks([{ offsetMs: 500, data: 'late' }]), (data) => received.push(data));

    // A pump that finds nothing due must reschedule silently. An empty write
    // reaches the WebView bridge as a real message and costs a round trip.
    vi.advanceTimersByTime(100);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(400);
    expect(received).toEqual(['late']);
  });

  it('stops emitting the moment stop() is called', () => {
    const received: string[] = [];
    const playback = playRecordedTerminal(
      captureWithChunks([
        { offsetMs: 0, data: 'before' },
        { offsetMs: 100, data: 'after' },
      ]),
      (data) => received.push(data),
    );

    vi.advanceTimersByTime(0);
    expect(received).toEqual(['before']);
    playback.stop();
    vi.advanceTimersByTime(10_000);
    expect(received).toEqual(['before']);
  });

  it('stops cleanly before anything has been emitted at all', () => {
    const received: string[] = [];
    const playback = playRecordedTerminal(
      captureWithChunks([{ offsetMs: 0, data: 'never' }]),
      (data) => received.push(data),
    );

    playback.stop();
    vi.advanceTimersByTime(10_000);
    expect(received).toEqual([]);
  });

  it('survives stop() called twice, and after the replay has finished', () => {
    const playback = playRecordedTerminal(captureWithChunks([{ offsetMs: 0, data: 'only' }]), () => {});

    vi.advanceTimersByTime(100);
    expect(() => playback.stop()).not.toThrow();
    expect(() => playback.stop()).not.toThrow();
  });

  it('leaves no timer pending once the last chunk has played', () => {
    // mockDesktop keeps a reference to the playback for the life of a session.
    // A replay that reschedules past its final chunk would hold a timer open
    // for as long as the mock desktop lives.
    playRecordedTerminal(captureWithChunks([{ offsetMs: 0, data: 'one' }, { offsetMs: 10, data: 'two' }]), () => {});

    vi.advanceTimersByTime(50);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('handles an empty capture without scheduling anything', () => {
    const received: string[] = [];
    playRecordedTerminal(captureWithChunks([]), (data) => received.push(data));

    vi.advanceTimersByTime(1000);
    expect(received).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('delays the whole replay by startDelayMs without shifting the offsets apart', () => {
    const received: string[] = [];
    playRecordedTerminal(
      captureWithChunks([
        { offsetMs: 0, data: 'first' },
        { offsetMs: 100, data: 'second' },
      ]),
      (data) => received.push(data),
      { startDelayMs: 500 },
    );

    vi.advanceTimersByTime(499);
    expect(received).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(received).toEqual(['first']);
    // The gap between the two chunks is preserved, not collapsed: the delay
    // moves the origin, it does not fast-forward what follows it.
    vi.advanceTimersByTime(99);
    expect(received).toEqual(['first']);
    vi.advanceTimersByTime(1);
    expect(received).toEqual(['first', 'second']);
  });
});
