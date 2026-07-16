/**
 * Shape and invariants of the generated Overseer mascot frame data
 * (src/brand/overseerFrames.generated.ts, produced by scripts/syncBranding.mjs).
 * Guards the parse contract the later Overseer component renders against:
 * a fixed integer grid, in-bounds rects, and the three semantic roles.
 */
import { describe, expect, it } from 'vitest';
import {
  OVERSEER_GRID_COLUMNS,
  OVERSEER_GRID_ROWS,
  overseerFrames,
  type OverseerFrameName,
} from '@/brand/overseerFrames.generated';

const FRAME_NAMES: OverseerFrameName[] = ['canonical', 'blink', 'wave'];
const VALID_ROLES = new Set(['body', 'ink', 'highlight']);

describe('overseerFrames', () => {
  it('uses the 18x12 mascot grid', () => {
    expect(OVERSEER_GRID_COLUMNS).toBe(18);
    expect(OVERSEER_GRID_ROWS).toBe(12);
  });

  it('ships all three frames with rects', () => {
    for (const frameName of FRAME_NAMES) {
      expect(overseerFrames[frameName].length, `${frameName} frame must have rects`).toBeGreaterThan(0);
    }
  });

  it('keeps every rect integral, in-bounds, and role-typed', () => {
    for (const frameName of FRAME_NAMES) {
      for (const rect of overseerFrames[frameName]) {
        const rectLabel = `${frameName} rect at (${rect.x}, ${rect.y})`;
        expect(Number.isInteger(rect.x), `${rectLabel} x`).toBe(true);
        expect(Number.isInteger(rect.y), `${rectLabel} y`).toBe(true);
        expect(Number.isInteger(rect.width), `${rectLabel} width`).toBe(true);
        expect(Number.isInteger(rect.height), `${rectLabel} height`).toBe(true);
        expect(rect.width, `${rectLabel} width`).toBeGreaterThan(0);
        expect(rect.height, `${rectLabel} height`).toBeGreaterThan(0);
        expect(rect.x, `${rectLabel} left edge`).toBeGreaterThanOrEqual(0);
        expect(rect.y, `${rectLabel} top edge`).toBeGreaterThanOrEqual(0);
        expect(rect.x + rect.width, `${rectLabel} right edge`).toBeLessThanOrEqual(OVERSEER_GRID_COLUMNS);
        expect(rect.y + rect.height, `${rectLabel} bottom edge`).toBeLessThanOrEqual(OVERSEER_GRID_ROWS);
        expect(VALID_ROLES.has(rect.role), `${rectLabel} role ${rect.role}`).toBe(true);
      }
    }
  });

  it('has open eyes (highlights) on canonical and wave, closed eyes on blink', () => {
    const highlightCount = (frameName: OverseerFrameName): number =>
      overseerFrames[frameName].filter((rect) => rect.role === 'highlight').length;
    expect(highlightCount('canonical')).toBeGreaterThan(0);
    expect(highlightCount('wave')).toBeGreaterThan(0);
    expect(highlightCount('blink')).toBe(0);
  });

  it('keeps the three frames distinct (stepped animation has something to step)', () => {
    const serialized = FRAME_NAMES.map((frameName) => JSON.stringify(overseerFrames[frameName]));
    expect(serialized[0]).not.toBe(serialized[1]);
    expect(serialized[0]).not.toBe(serialized[2]);
    expect(serialized[1]).not.toBe(serialized[2]);
  });
});
