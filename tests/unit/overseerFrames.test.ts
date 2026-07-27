/**
 * Shape and invariants of the generated Overseer mascot frame and sequence
 * data (src/brand/overseerFrames.generated.ts, produced by
 * scripts/syncBranding.mjs from @kangentic/branding's motion manifest).
 * Guards the parse contract the later Overseer component renders against: a
 * fixed integer grid, in-bounds rects, the three semantic roles, and every
 * sequence's clip/idle frames resolving to a real frame.
 */
import { describe, expect, it } from 'vitest';
import {
  OVERSEER_GRID_COLUMNS,
  OVERSEER_GRID_ROWS,
  OVERSEER_REST_FRAME,
  overseerFrames,
  overseerOneShotDurationMs,
  overseerSequences,
  type OverseerFrameName,
} from '@/brand/overseerFrames.generated';

const FRAME_NAMES = Object.keys(overseerFrames) as OverseerFrameName[];
const VALID_ROLES = new Set(['body', 'ink', 'highlight']);

/** waiting-loop's own note: at the 4-frame motion budget, it cannot absorb anything else. */
const WAITING_LOOP_MAX_DISTINCT_FRAMES = 4;

describe('overseerFrames', () => {
  it('uses the 18x12 mascot grid', () => {
    expect(OVERSEER_GRID_COLUMNS).toBe(18);
    expect(OVERSEER_GRID_ROWS).toBe(12);
  });

  it('ships all ten frames with rects', () => {
    expect(FRAME_NAMES.sort()).toEqual(
      ['rest', 'blink', 'wave', 'look', 'arms-up', 'wave-left', 'step-a', 'step-b', 'step-a-look', 'step-b-look'].sort(),
    );
    for (const frameName of FRAME_NAMES) {
      expect(overseerFrames[frameName].length, `${frameName} frame must have rects`).toBeGreaterThan(0);
    }
  });

  it('resolves the rest frame to a real frame', () => {
    expect(FRAME_NAMES).toContain(OVERSEER_REST_FRAME);
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

  it('has closed eyes (no highlights) only on blink', () => {
    const highlightCount = (frameName: OverseerFrameName): number =>
      overseerFrames[frameName].filter((rect) => rect.role === 'highlight').length;
    for (const frameName of FRAME_NAMES) {
      if (frameName === 'blink') {
        expect(highlightCount(frameName), `${frameName} highlight count`).toBe(0);
      } else {
        expect(highlightCount(frameName), `${frameName} highlight count`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps all ten frames distinct (stepped animation has something to step)', () => {
    const serialized = new Set(FRAME_NAMES.map((frameName) => JSON.stringify(overseerFrames[frameName])));
    expect(serialized.size).toBe(FRAME_NAMES.length);
  });
});

describe('overseerSequences', () => {
  const frameNameSet = new Set(FRAME_NAMES);

  it('resolves every clip and idle frame to a real frame', () => {
    for (const [sequenceName, sequence] of Object.entries(overseerSequences)) {
      for (const step of sequence.clip) {
        expect(frameNameSet.has(step.frame), `${sequenceName} clip frame "${step.frame}"`).toBe(true);
        expect(step.durationMs, `${sequenceName} clip frame "${step.frame}" duration`).toBeGreaterThan(0);
      }
      if (sequence.idle !== undefined) {
        expect(frameNameSet.has(sequence.idle.frame), `${sequenceName} idle frame "${sequence.idle.frame}"`).toBe(true);
      }
    }
  });

  it('has an empty clip only for "none"', () => {
    for (const [sequenceName, sequence] of Object.entries(overseerSequences)) {
      if (sequenceName === 'none') {
        expect(sequence.clip).toEqual([]);
      } else {
        expect(sequence.clip.length, `${sequenceName} clip`).toBeGreaterThan(0);
      }
    }
  });

  it('keeps waiting-loop within its 4-distinct-frame motion budget', () => {
    // If an upstream branding bump trips this, the fix belongs in the manifest
    // or in scripts/syncBranding.mjs, not in this number.
    const distinctFrames = new Set(overseerSequences['waiting-loop'].clip.map((step) => step.frame));
    expect(distinctFrames.size).toBeLessThanOrEqual(WAITING_LOOP_MAX_DISTINCT_FRAMES);
  });

  /**
   * The runner feeds both windows straight to setTimeout. An inverted one
   * becomes a zero delay, which on a looping sequence is a tight setState loop
   * rather than a slow animation. scripts/syncBranding.mjs refuses to generate
   * one, but nothing runs that check automatically, so the committed data is
   * pinned here too, where CI does run it.
   */
  it('keeps every random gap window ordered and every chance a probability', () => {
    for (const [sequenceName, sequence] of Object.entries(overseerSequences)) {
      if (sequence.idle !== undefined) {
        expect(sequence.idle.minMs, `${sequenceName} idle.minMs`).toBeGreaterThanOrEqual(0);
        expect(sequence.idle.maxMs, `${sequenceName} idle.maxMs`).toBeGreaterThanOrEqual(sequence.idle.minMs);
      }
      if (sequence.repeat !== undefined) {
        expect(sequence.repeat.chance, `${sequenceName} repeat.chance`).toBeGreaterThan(0);
        expect(sequence.repeat.chance, `${sequenceName} repeat.chance`).toBeLessThanOrEqual(1);
        expect(sequence.repeat.gapMinMs, `${sequenceName} repeat.gapMinMs`).toBeGreaterThanOrEqual(0);
        expect(sequence.repeat.gapMaxMs, `${sequenceName} repeat.gapMaxMs`).toBeGreaterThanOrEqual(sequence.repeat.gapMinMs);
      }
    }
  });
});

describe('overseerOneShotDurationMs', () => {
  it('equals the clip sum for every one-shot sequence', () => {
    for (const [sequenceName, totalMs] of Object.entries(overseerOneShotDurationMs)) {
      const clip = overseerSequences[sequenceName as keyof typeof overseerSequences].clip;
      const expectedTotalMs = clip.reduce((sum, step) => sum + step.durationMs, 0);
      expect(totalMs, sequenceName).toBe(expectedTotalMs);
    }
  });

  it('reports the single arm wave as 600ms (five 120ms steps)', () => {
    expect(overseerOneShotDurationMs['wave-once']).toBe(600);
  });

  /**
   * The clip sum is only the true playback time while a one-shot carries no
   * random gap. PairingConfirmScreen navigates on this total, so a one-shot
   * that grew an idle or repeat policy would cut its own wave off mid-frame.
   */
  it('leaves one-shots free of the random gap policies the clip sum cannot express', () => {
    for (const sequenceName of Object.keys(overseerOneShotDurationMs)) {
      const sequence = overseerSequences[sequenceName as keyof typeof overseerSequences];
      expect(sequence.loop, `${sequenceName} loop`).toBe(false);
      expect(sequence.idle, `${sequenceName} idle`).toBeUndefined();
      expect(sequence.repeat, `${sequenceName} repeat`).toBeUndefined();
    }
  });
});
