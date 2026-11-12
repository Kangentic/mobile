import { describe, expect, it } from 'vitest';
import { PRIORITY_FALLBACK_COLOR, type PriorityLevelWire } from '@kangentic/protocol';
import { priorityLevelFor } from '../../src/lib/priority';

const SCALE: PriorityLevelWire[] = [
  { label: 'None', color: '#888888' },
  { label: 'Low', color: '#22aa44' },
  { label: 'Urgent', color: '#ff0000' },
];

describe('priorityLevelFor', () => {
  it('is null with no scale', () => {
    expect(priorityLevelFor(2, null)).toBeNull();
  });

  it('draws nothing for the bottom, negatives, fractions and absent values', () => {
    expect(priorityLevelFor(0, SCALE)).toBeNull();
    expect(priorityLevelFor(-1, SCALE)).toBeNull();
    expect(priorityLevelFor(1.5, SCALE)).toBeNull();
    expect(priorityLevelFor(undefined, SCALE)).toBeNull();
    expect(priorityLevelFor(null, SCALE)).toBeNull();
  });

  it('returns the level at the index', () => {
    expect(priorityLevelFor(1, SCALE)).toEqual(SCALE[1]);
    expect(priorityLevelFor(2, SCALE)).toEqual(SCALE[2]);
  });

  it('draws P<n> in the fallback gray past the end of the scale', () => {
    expect(priorityLevelFor(7, SCALE)).toEqual({ label: 'P7', color: PRIORITY_FALLBACK_COLOR });
  });

  it('keeps the label but swaps a malformed color for the fallback', () => {
    const scale: PriorityLevelWire[] = [SCALE[0], { label: 'Odd', color: 'red' }];
    expect(priorityLevelFor(1, scale)).toEqual({ label: 'Odd', color: PRIORITY_FALLBACK_COLOR });
  });
});
