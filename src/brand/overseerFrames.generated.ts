/**
 * GENERATED FILE. Do not hand-edit. Regenerate with: node scripts/syncBranding.mjs
 * Source: the @kangentic/branding package (assets change there, never here).
 * This file carries brand asset data, the one sanctioned exception to the
 * "hex values live only in src/components/theme/tokens.ts" rule.
 */

/**
 * The Overseer mascot as typed pixel-grid frame data, parsed from the pure
 * <rect> mascot SVGs, plus its motion sequences, parsed from
 * @kangentic/branding/assets/mascot/animations.json. Roles map to brand
 * colors at render time (body = brand amber, ink = brand ink, highlight =
 * brand cream), so no consumer ever touches a hex value, and sequence
 * timings arrive with the assets so they cannot hand-drift locally.
 */

export type OverseerRectRole = 'body' | 'ink' | 'highlight';

export interface OverseerFrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
  role: OverseerRectRole;
}

export type OverseerFrameName = 'rest' | 'blink' | 'wave' | 'look' | 'arms-up' | 'wave-left' | 'step-a' | 'step-b' | 'step-a-look' | 'step-b-look';

export type OverseerAnimation = 'none' | 'blink-loop' | 'wave-once' | 'double-arm-wave-once' | 'double-arm-alternating-wave-once' | 'looking-left-and-right-loop' | 'running-loop' | 'waiting-loop';

/** One-shots only: a loop has no total duration, and asking for one is a bug. */
export type OverseerOneShotAnimation = 'none' | 'wave-once' | 'double-arm-wave-once' | 'double-arm-alternating-wave-once';

export const OVERSEER_GRID_COLUMNS = 18;
export const OVERSEER_GRID_ROWS = 12;
export const OVERSEER_REST_FRAME: OverseerFrameName = 'rest';

export const overseerFrames: Record<OverseerFrameName, readonly OverseerFrameRect[]> = {
  'rest': [
    { x: 5, y: 0, width: 8, height: 1, role: 'body' },
    { x: 3, y: 1, width: 12, height: 1, role: 'body' },
    { x: 2, y: 2, width: 14, height: 1, role: 'body' },
    { x: 2, y: 3, width: 2, height: 1, role: 'body' },
    { x: 4, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 5, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 6, y: 3, width: 2, height: 1, role: 'body' },
    { x: 8, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 9, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 10, y: 3, width: 2, height: 1, role: 'body' },
    { x: 12, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 13, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 14, y: 3, width: 2, height: 1, role: 'body' },
    { x: 2, y: 4, width: 2, height: 1, role: 'body' },
    { x: 4, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 6, y: 4, width: 2, height: 1, role: 'body' },
    { x: 8, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 10, y: 4, width: 2, height: 1, role: 'body' },
    { x: 12, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 14, y: 4, width: 2, height: 1, role: 'body' },
    { x: 0, y: 5, width: 18, height: 1, role: 'body' },
    { x: 0, y: 6, width: 18, height: 1, role: 'body' },
    { x: 2, y: 7, width: 14, height: 1, role: 'body' },
    { x: 2, y: 8, width: 14, height: 1, role: 'body' },
    { x: 3, y: 9, width: 12, height: 1, role: 'body' },
    { x: 4, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 10, width: 2, height: 1, role: 'body' },
    { x: 12, y: 10, width: 2, height: 1, role: 'body' },
    { x: 4, y: 11, width: 2, height: 1, role: 'body' },
    { x: 8, y: 11, width: 2, height: 1, role: 'body' },
    { x: 12, y: 11, width: 2, height: 1, role: 'body' },
  ],
  'blink': [
    { x: 5, y: 0, width: 8, height: 1, role: 'body' },
    { x: 3, y: 1, width: 12, height: 1, role: 'body' },
    { x: 2, y: 2, width: 14, height: 1, role: 'body' },
    { x: 2, y: 3, width: 14, height: 1, role: 'body' },
    { x: 2, y: 4, width: 2, height: 1, role: 'body' },
    { x: 4, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 6, y: 4, width: 2, height: 1, role: 'body' },
    { x: 8, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 10, y: 4, width: 2, height: 1, role: 'body' },
    { x: 12, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 14, y: 4, width: 2, height: 1, role: 'body' },
    { x: 0, y: 5, width: 18, height: 1, role: 'body' },
    { x: 0, y: 6, width: 18, height: 1, role: 'body' },
    { x: 2, y: 7, width: 14, height: 1, role: 'body' },
    { x: 2, y: 8, width: 14, height: 1, role: 'body' },
    { x: 3, y: 9, width: 12, height: 1, role: 'body' },
    { x: 4, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 10, width: 2, height: 1, role: 'body' },
    { x: 12, y: 10, width: 2, height: 1, role: 'body' },
    { x: 4, y: 11, width: 2, height: 1, role: 'body' },
    { x: 8, y: 11, width: 2, height: 1, role: 'body' },
    { x: 12, y: 11, width: 2, height: 1, role: 'body' },
  ],
  'wave': [
    { x: 5, y: 0, width: 8, height: 1, role: 'body' },
    { x: 3, y: 1, width: 12, height: 1, role: 'body' },
    { x: 2, y: 2, width: 14, height: 1, role: 'body' },
    { x: 2, y: 3, width: 2, height: 1, role: 'body' },
    { x: 4, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 5, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 6, y: 3, width: 2, height: 1, role: 'body' },
    { x: 8, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 9, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 10, y: 3, width: 2, height: 1, role: 'body' },
    { x: 12, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 13, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 14, y: 3, width: 2, height: 1, role: 'body' },
    { x: 2, y: 4, width: 2, height: 1, role: 'body' },
    { x: 4, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 6, y: 4, width: 2, height: 1, role: 'body' },
    { x: 8, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 10, y: 4, width: 2, height: 1, role: 'body' },
    { x: 12, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 14, y: 4, width: 4, height: 1, role: 'body' },
    { x: 0, y: 5, width: 18, height: 1, role: 'body' },
    { x: 0, y: 6, width: 16, height: 1, role: 'body' },
    { x: 2, y: 7, width: 14, height: 1, role: 'body' },
    { x: 2, y: 8, width: 14, height: 1, role: 'body' },
    { x: 3, y: 9, width: 12, height: 1, role: 'body' },
    { x: 4, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 10, width: 2, height: 1, role: 'body' },
    { x: 12, y: 10, width: 2, height: 1, role: 'body' },
    { x: 4, y: 11, width: 2, height: 1, role: 'body' },
    { x: 8, y: 11, width: 2, height: 1, role: 'body' },
    { x: 12, y: 11, width: 2, height: 1, role: 'body' },
  ],
  'look': [
    { x: 5, y: 0, width: 8, height: 1, role: 'body' },
    { x: 3, y: 1, width: 12, height: 1, role: 'body' },
    { x: 2, y: 2, width: 14, height: 1, role: 'body' },
    { x: 2, y: 3, width: 2, height: 1, role: 'body' },
    { x: 4, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 5, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 6, y: 3, width: 2, height: 1, role: 'body' },
    { x: 8, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 9, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 10, y: 3, width: 2, height: 1, role: 'body' },
    { x: 12, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 13, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 14, y: 3, width: 2, height: 1, role: 'body' },
    { x: 2, y: 4, width: 2, height: 1, role: 'body' },
    { x: 4, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 6, y: 4, width: 2, height: 1, role: 'body' },
    { x: 8, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 10, y: 4, width: 2, height: 1, role: 'body' },
    { x: 12, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 14, y: 4, width: 2, height: 1, role: 'body' },
    { x: 0, y: 5, width: 18, height: 1, role: 'body' },
    { x: 0, y: 6, width: 18, height: 1, role: 'body' },
    { x: 2, y: 7, width: 14, height: 1, role: 'body' },
    { x: 2, y: 8, width: 14, height: 1, role: 'body' },
    { x: 3, y: 9, width: 12, height: 1, role: 'body' },
    { x: 4, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 10, width: 2, height: 1, role: 'body' },
    { x: 12, y: 10, width: 2, height: 1, role: 'body' },
    { x: 4, y: 11, width: 2, height: 1, role: 'body' },
    { x: 8, y: 11, width: 2, height: 1, role: 'body' },
    { x: 12, y: 11, width: 2, height: 1, role: 'body' },
  ],
  'arms-up': [
    { x: 5, y: 0, width: 8, height: 1, role: 'body' },
    { x: 3, y: 1, width: 12, height: 1, role: 'body' },
    { x: 2, y: 2, width: 14, height: 1, role: 'body' },
    { x: 2, y: 3, width: 2, height: 1, role: 'body' },
    { x: 4, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 5, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 6, y: 3, width: 2, height: 1, role: 'body' },
    { x: 8, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 9, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 10, y: 3, width: 2, height: 1, role: 'body' },
    { x: 12, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 13, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 14, y: 3, width: 2, height: 1, role: 'body' },
    { x: 0, y: 4, width: 4, height: 1, role: 'body' },
    { x: 4, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 6, y: 4, width: 2, height: 1, role: 'body' },
    { x: 8, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 10, y: 4, width: 2, height: 1, role: 'body' },
    { x: 12, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 14, y: 4, width: 4, height: 1, role: 'body' },
    { x: 0, y: 5, width: 18, height: 1, role: 'body' },
    { x: 2, y: 6, width: 14, height: 1, role: 'body' },
    { x: 2, y: 7, width: 14, height: 1, role: 'body' },
    { x: 2, y: 8, width: 14, height: 1, role: 'body' },
    { x: 3, y: 9, width: 12, height: 1, role: 'body' },
    { x: 4, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 10, width: 2, height: 1, role: 'body' },
    { x: 12, y: 10, width: 2, height: 1, role: 'body' },
    { x: 4, y: 11, width: 2, height: 1, role: 'body' },
    { x: 8, y: 11, width: 2, height: 1, role: 'body' },
    { x: 12, y: 11, width: 2, height: 1, role: 'body' },
  ],
  'wave-left': [
    { x: 5, y: 0, width: 8, height: 1, role: 'body' },
    { x: 3, y: 1, width: 12, height: 1, role: 'body' },
    { x: 2, y: 2, width: 14, height: 1, role: 'body' },
    { x: 2, y: 3, width: 2, height: 1, role: 'body' },
    { x: 4, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 5, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 6, y: 3, width: 2, height: 1, role: 'body' },
    { x: 8, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 9, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 10, y: 3, width: 2, height: 1, role: 'body' },
    { x: 12, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 13, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 14, y: 3, width: 2, height: 1, role: 'body' },
    { x: 0, y: 4, width: 4, height: 1, role: 'body' },
    { x: 4, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 6, y: 4, width: 2, height: 1, role: 'body' },
    { x: 8, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 10, y: 4, width: 2, height: 1, role: 'body' },
    { x: 12, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 14, y: 4, width: 2, height: 1, role: 'body' },
    { x: 0, y: 5, width: 18, height: 1, role: 'body' },
    { x: 2, y: 6, width: 16, height: 1, role: 'body' },
    { x: 2, y: 7, width: 14, height: 1, role: 'body' },
    { x: 2, y: 8, width: 14, height: 1, role: 'body' },
    { x: 3, y: 9, width: 12, height: 1, role: 'body' },
    { x: 4, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 10, width: 2, height: 1, role: 'body' },
    { x: 12, y: 10, width: 2, height: 1, role: 'body' },
    { x: 4, y: 11, width: 2, height: 1, role: 'body' },
    { x: 8, y: 11, width: 2, height: 1, role: 'body' },
    { x: 12, y: 11, width: 2, height: 1, role: 'body' },
  ],
  'step-a': [
    { x: 5, y: 0, width: 8, height: 1, role: 'body' },
    { x: 3, y: 1, width: 12, height: 1, role: 'body' },
    { x: 2, y: 2, width: 14, height: 1, role: 'body' },
    { x: 2, y: 3, width: 2, height: 1, role: 'body' },
    { x: 4, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 5, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 6, y: 3, width: 2, height: 1, role: 'body' },
    { x: 8, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 9, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 10, y: 3, width: 2, height: 1, role: 'body' },
    { x: 12, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 13, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 14, y: 3, width: 2, height: 1, role: 'body' },
    { x: 2, y: 4, width: 2, height: 1, role: 'body' },
    { x: 4, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 6, y: 4, width: 2, height: 1, role: 'body' },
    { x: 8, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 10, y: 4, width: 2, height: 1, role: 'body' },
    { x: 12, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 14, y: 4, width: 2, height: 1, role: 'body' },
    { x: 0, y: 5, width: 18, height: 1, role: 'body' },
    { x: 0, y: 6, width: 18, height: 1, role: 'body' },
    { x: 2, y: 7, width: 14, height: 1, role: 'body' },
    { x: 2, y: 8, width: 14, height: 1, role: 'body' },
    { x: 3, y: 9, width: 12, height: 1, role: 'body' },
    { x: 4, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 10, width: 2, height: 1, role: 'body' },
    { x: 12, y: 10, width: 2, height: 1, role: 'body' },
    { x: 4, y: 11, width: 2, height: 1, role: 'body' },
    { x: 12, y: 11, width: 2, height: 1, role: 'body' },
  ],
  'step-b': [
    { x: 5, y: 0, width: 8, height: 1, role: 'body' },
    { x: 3, y: 1, width: 12, height: 1, role: 'body' },
    { x: 2, y: 2, width: 14, height: 1, role: 'body' },
    { x: 2, y: 3, width: 2, height: 1, role: 'body' },
    { x: 4, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 5, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 6, y: 3, width: 2, height: 1, role: 'body' },
    { x: 8, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 9, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 10, y: 3, width: 2, height: 1, role: 'body' },
    { x: 12, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 13, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 14, y: 3, width: 2, height: 1, role: 'body' },
    { x: 2, y: 4, width: 2, height: 1, role: 'body' },
    { x: 4, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 6, y: 4, width: 2, height: 1, role: 'body' },
    { x: 8, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 10, y: 4, width: 2, height: 1, role: 'body' },
    { x: 12, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 14, y: 4, width: 2, height: 1, role: 'body' },
    { x: 0, y: 5, width: 18, height: 1, role: 'body' },
    { x: 0, y: 6, width: 18, height: 1, role: 'body' },
    { x: 2, y: 7, width: 14, height: 1, role: 'body' },
    { x: 2, y: 8, width: 14, height: 1, role: 'body' },
    { x: 3, y: 9, width: 12, height: 1, role: 'body' },
    { x: 4, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 10, width: 2, height: 1, role: 'body' },
    { x: 12, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 11, width: 2, height: 1, role: 'body' },
  ],
  'step-a-look': [
    { x: 5, y: 0, width: 8, height: 1, role: 'body' },
    { x: 3, y: 1, width: 12, height: 1, role: 'body' },
    { x: 2, y: 2, width: 14, height: 1, role: 'body' },
    { x: 2, y: 3, width: 2, height: 1, role: 'body' },
    { x: 4, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 5, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 6, y: 3, width: 2, height: 1, role: 'body' },
    { x: 8, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 9, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 10, y: 3, width: 2, height: 1, role: 'body' },
    { x: 12, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 13, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 14, y: 3, width: 2, height: 1, role: 'body' },
    { x: 2, y: 4, width: 2, height: 1, role: 'body' },
    { x: 4, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 6, y: 4, width: 2, height: 1, role: 'body' },
    { x: 8, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 10, y: 4, width: 2, height: 1, role: 'body' },
    { x: 12, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 14, y: 4, width: 2, height: 1, role: 'body' },
    { x: 0, y: 5, width: 18, height: 1, role: 'body' },
    { x: 0, y: 6, width: 18, height: 1, role: 'body' },
    { x: 2, y: 7, width: 14, height: 1, role: 'body' },
    { x: 2, y: 8, width: 14, height: 1, role: 'body' },
    { x: 3, y: 9, width: 12, height: 1, role: 'body' },
    { x: 4, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 10, width: 2, height: 1, role: 'body' },
    { x: 12, y: 10, width: 2, height: 1, role: 'body' },
    { x: 4, y: 11, width: 2, height: 1, role: 'body' },
    { x: 12, y: 11, width: 2, height: 1, role: 'body' },
  ],
  'step-b-look': [
    { x: 5, y: 0, width: 8, height: 1, role: 'body' },
    { x: 3, y: 1, width: 12, height: 1, role: 'body' },
    { x: 2, y: 2, width: 14, height: 1, role: 'body' },
    { x: 2, y: 3, width: 2, height: 1, role: 'body' },
    { x: 4, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 5, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 6, y: 3, width: 2, height: 1, role: 'body' },
    { x: 8, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 9, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 10, y: 3, width: 2, height: 1, role: 'body' },
    { x: 12, y: 3, width: 1, height: 1, role: 'highlight' },
    { x: 13, y: 3, width: 1, height: 1, role: 'ink' },
    { x: 14, y: 3, width: 2, height: 1, role: 'body' },
    { x: 2, y: 4, width: 2, height: 1, role: 'body' },
    { x: 4, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 6, y: 4, width: 2, height: 1, role: 'body' },
    { x: 8, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 10, y: 4, width: 2, height: 1, role: 'body' },
    { x: 12, y: 4, width: 2, height: 1, role: 'ink' },
    { x: 14, y: 4, width: 2, height: 1, role: 'body' },
    { x: 0, y: 5, width: 18, height: 1, role: 'body' },
    { x: 0, y: 6, width: 18, height: 1, role: 'body' },
    { x: 2, y: 7, width: 14, height: 1, role: 'body' },
    { x: 2, y: 8, width: 14, height: 1, role: 'body' },
    { x: 3, y: 9, width: 12, height: 1, role: 'body' },
    { x: 4, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 10, width: 2, height: 1, role: 'body' },
    { x: 12, y: 10, width: 2, height: 1, role: 'body' },
    { x: 8, y: 11, width: 2, height: 1, role: 'body' },
  ],
};

export interface OverseerClipStep {
  frame: OverseerFrameName;
  durationMs: number;
}

export interface OverseerIdlePolicy {
  frame: OverseerFrameName;
  minMs: number;
  maxMs: number;
}

export interface OverseerRepeatPolicy {
  chance: number;
  gapMinMs: number;
  gapMaxMs: number;
}

export interface OverseerSequence {
  loop: boolean;
  clip: readonly OverseerClipStep[];
  /** Gap before each clip pass, drawn squared-bias: minMs + (maxMs - minMs) * random^2. */
  idle?: OverseerIdlePolicy;
  repeat?: OverseerRepeatPolicy;
}

export const overseerSequences: Record<OverseerAnimation, OverseerSequence> = {
  'none': {
    loop: false,
    clip: [],
  },
  'blink-loop': {
    loop: true,
    clip: [
      { frame: 'blink', durationMs: 140 },
    ],
    idle: { frame: 'rest', minMs: 2000, maxMs: 7000 },
    repeat: { chance: 0.3, gapMinMs: 270, gapMaxMs: 400 },
  },
  'wave-once': {
    loop: false,
    clip: [
      { frame: 'rest', durationMs: 120 },
      { frame: 'wave', durationMs: 120 },
      { frame: 'rest', durationMs: 120 },
      { frame: 'wave', durationMs: 120 },
      { frame: 'rest', durationMs: 120 },
    ],
  },
  'double-arm-wave-once': {
    loop: false,
    clip: [
      { frame: 'rest', durationMs: 120 },
      { frame: 'arms-up', durationMs: 120 },
      { frame: 'rest', durationMs: 120 },
      { frame: 'arms-up', durationMs: 120 },
      { frame: 'rest', durationMs: 120 },
    ],
  },
  'double-arm-alternating-wave-once': {
    loop: false,
    clip: [
      { frame: 'rest', durationMs: 120 },
      { frame: 'wave', durationMs: 120 },
      { frame: 'wave-left', durationMs: 120 },
      { frame: 'wave', durationMs: 120 },
      { frame: 'rest', durationMs: 120 },
    ],
  },
  'looking-left-and-right-loop': {
    loop: true,
    clip: [
      { frame: 'rest', durationMs: 900 },
      { frame: 'look', durationMs: 900 },
    ],
  },
  'running-loop': {
    loop: true,
    clip: [
      { frame: 'step-a', durationMs: 400 },
      { frame: 'step-b', durationMs: 400 },
    ],
  },
  'waiting-loop': {
    loop: true,
    clip: [
      { frame: 'step-a', durationMs: 400 },
      { frame: 'step-b', durationMs: 400 },
      { frame: 'step-a', durationMs: 400 },
      { frame: 'step-b', durationMs: 400 },
      { frame: 'step-a-look', durationMs: 400 },
      { frame: 'step-b-look', durationMs: 400 },
      { frame: 'step-a-look', durationMs: 400 },
      { frame: 'step-b-look', durationMs: 400 },
    ],
  },
};

/** Total playback time of a one-shot sequence (the sum of its clip). A loop has none. */
export const overseerOneShotDurationMs: Record<OverseerOneShotAnimation, number> = {
  'none': 0,
  'wave-once': 600,
  'double-arm-wave-once': 600,
  'double-arm-alternating-wave-once': 600,
};
