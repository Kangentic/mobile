/**
 * GENERATED FILE. Do not hand-edit. Regenerate with: node scripts/syncBranding.mjs
 * Source: the @kangentic/branding package (assets change there, never here).
 * This file carries brand asset data, the one sanctioned exception to the
 * "hex values live only in src/components/theme/tokens.ts" rule.
 */

/**
 * The Overseer mascot as typed pixel-grid frame data, parsed from the pure
 * <rect> mascot SVGs. Roles map to brand colors at render time (body = brand
 * amber, ink = brand ink, highlight = brand cream), so no consumer ever
 * touches a hex value.
 */

export type OverseerRectRole = 'body' | 'ink' | 'highlight';

export interface OverseerFrameRect {
  x: number;
  y: number;
  width: number;
  height: number;
  role: OverseerRectRole;
}

export type OverseerFrameName = 'canonical' | 'blink' | 'wave';

export const OVERSEER_GRID_COLUMNS = 18;
export const OVERSEER_GRID_ROWS = 12;

export const overseerFrames: Record<OverseerFrameName, readonly OverseerFrameRect[]> = {
  canonical: [
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
  blink: [
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
  wave: [
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
};
