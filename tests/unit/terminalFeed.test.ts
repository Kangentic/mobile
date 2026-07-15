/**
 * terminalFeed: retained-only buffering, byte-capped ring eviction,
 * seed-vs-chunk listener events, and zero-cost non-retained appends.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  appendChunk,
  getBufferedData,
  getTerminalDimensions,
  isTerminalRetained,
  releaseTerminal,
  resetTerminalFeed,
  retainTerminal,
  seedScrollback,
  setTerminalDimensions,
  subscribeChunks,
  type TerminalFeedEvent,
} from '@/state/terminalFeed';

describe('terminalFeed', () => {
  beforeEach(() => {
    resetTerminalFeed();
  });

  it('appends are dropped for non-retained sessions', () => {
    appendChunk('sess-1', 'ignored');
    expect(getBufferedData('sess-1')).toBe('');
    expect(isTerminalRetained('sess-1')).toBe(false);
  });

  it('buffers appends for retained sessions and joins them in order', () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'hello ');
    appendChunk('sess-1', 'world');
    expect(getBufferedData('sess-1')).toBe('hello world');
  });

  it('seedScrollback replaces the buffer and notifies listeners with kind seed', () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'stale');
    const events: TerminalFeedEvent[] = [];
    subscribeChunks('sess-1', (event) => events.push(event));

    seedScrollback('sess-1', 'fresh snapshot');
    appendChunk('sess-1', ' + live');

    expect(getBufferedData('sess-1')).toBe('fresh snapshot + live');
    expect(events).toEqual([
      { kind: 'seed', data: 'fresh snapshot' },
      { kind: 'chunk', data: ' + live' },
    ]);
  });

  it('evicts oldest chunks past the byte cap but always keeps the newest', () => {
    retainTerminal('sess-1');
    const bigChunk = 'x'.repeat(100 * 1024);
    appendChunk('sess-1', bigChunk);
    appendChunk('sess-1', 'y'.repeat(40 * 1024));
    // 140KB > 128KB cap: the first chunk is evicted.
    const buffered = getBufferedData('sess-1');
    expect(buffered).toBe('y'.repeat(40 * 1024));

    // A single oversized chunk is kept (the cap never evicts the last chunk).
    seedScrollback('sess-1', 'z'.repeat(200 * 1024));
    expect(getBufferedData('sess-1')).toHaveLength(200 * 1024);
  });

  it('releaseTerminal drops the ring and detaches listeners', () => {
    retainTerminal('sess-1');
    const events: TerminalFeedEvent[] = [];
    subscribeChunks('sess-1', (event) => events.push(event));
    releaseTerminal('sess-1');

    appendChunk('sess-1', 'after release');
    expect(getBufferedData('sess-1')).toBe('');
    expect(events).toEqual([]);
  });

  it('records dims for retained sessions and notifies listeners only on change', () => {
    setTerminalDimensions('sess-1', { cols: 120, rows: 30 }); // not retained: dropped
    expect(getTerminalDimensions('sess-1')).toBeNull();

    retainTerminal('sess-1');
    const events: TerminalFeedEvent[] = [];
    subscribeChunks('sess-1', (event) => events.push(event));

    setTerminalDimensions('sess-1', { cols: 120, rows: 30 });
    setTerminalDimensions('sess-1', { cols: 120, rows: 30 }); // unchanged: no event
    setTerminalDimensions('sess-1', { cols: 48, rows: 26 });

    expect(getTerminalDimensions('sess-1')).toEqual({ cols: 48, rows: 26 });
    expect(events).toEqual([
      { kind: 'dims', cols: 120, rows: 30 },
      { kind: 'dims', cols: 48, rows: 26 },
    ]);

    // A pre-0.4.0 desktop reports nothing: null clears silently.
    setTerminalDimensions('sess-1', null);
    expect(getTerminalDimensions('sess-1')).toBeNull();
    expect(events).toHaveLength(2);
  });

  it('unsubscribe stops delivery without touching the buffer', () => {
    retainTerminal('sess-1');
    const events: TerminalFeedEvent[] = [];
    const unsubscribe = subscribeChunks('sess-1', (event) => events.push(event));
    appendChunk('sess-1', 'one');
    unsubscribe();
    appendChunk('sess-1', 'two');

    expect(events).toEqual([{ kind: 'chunk', data: 'one' }]);
    expect(getBufferedData('sess-1')).toBe('onetwo');
  });
});
