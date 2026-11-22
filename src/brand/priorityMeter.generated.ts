/**
 * GENERATED FILE. Do not hand-edit. Regenerate with: node scripts/syncBranding.mjs
 * Source: the @kangentic/branding package (assets change there, never here).
 * This file carries brand asset data, the one sanctioned exception to the
 * "hex values live only in src/components/theme/tokens.ts" rule.
 */

/**
 * The priority meter's numbers, from @kangentic/branding/assets/priority/meter.json:
 * the equal bars a task card draws for its priority, shared with the desktop
 * and the web demo. Only the numbers live here. The rules that use them (bar
 * count, lit count, which opacity, the pixel snap) are code in
 * src/lib/priorityMeter.ts, and the generator refuses a meter.json whose rules
 * read differently.
 */

/** One bar, in dp. Width, gap and height snap to whole device pixels; the radius does not. */
export interface PriorityMeterBar {
  width: number;
  height: number;
  gap: number;
  radius: number;
}

/** A lit bar, an unlit bar on a card with a priority, and every bar of the bottom level. */
export interface PriorityMeterOpacity {
  lit: number;
  unlit: number;
  none: number;
}

export const PRIORITY_METER_BAR: PriorityMeterBar = { width: 3, height: 10, gap: 2, radius: 1 };

export const PRIORITY_METER_OPACITY: PriorityMeterOpacity = { lit: 1, unlit: 0.3, none: 0.45 };
