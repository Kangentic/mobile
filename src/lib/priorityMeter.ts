import { PRIORITY_METER_BAR, PRIORITY_METER_OPACITY } from '@/brand/priorityMeter.generated';

/**
 * The priority meter's rules, from @kangentic/branding's `assets/priority/meter.json`
 * (kangentic-branding #24, the desktop's #1160): one equal bar per level above the
 * scale's bottom entry, lit from the left up to the task's level, in the level's
 * own color. The numbers come from src/brand/priorityMeter.generated.ts, and
 * scripts/syncBranding.mjs refuses a meter.json whose rules read differently from
 * the ones written out here, so a rule change upstream stops at the generator
 * rather than drawing new numbers under old rules.
 *
 * Pure (no react-native import), so tests/unit/priorityMeter.test.ts can run every
 * row of meter.json's worked tables through it.
 */

/** `rules.barCount`: `max(1, levelCount - 1)`. A one-level scale still draws one bar. */
export function priorityMeterBarCount(levelCount: number): number {
  return Math.max(1, levelCount - 1);
}

/** `rules.lit`: `min(max(level, 0), barCount)`, counted from the left. A level past the end of the scale lights every bar. */
export function priorityMeterLitCount(level: number, barCount: number): number {
  return Math.min(Math.max(level, 0), barCount);
}

/** `rules.opacity`: a lit bar at full strength; every other bar at the unlit opacity, or at the bottom level's when the level is 0. */
export function priorityMeterBarOpacity(barIndex: number, level: number, litCount: number): number {
  if (barIndex < litCount) return PRIORITY_METER_OPACITY.lit;
  return level > 0 ? PRIORITY_METER_OPACITY.unlit : PRIORITY_METER_OPACITY.none;
}

/** One bar's drawn size, in dp, at a given device pixel ratio. */
export interface PriorityMeterGeometry {
  width: number;
  height: number;
  gap: number;
  radius: number;
}

/**
 * meter.json's `pixelSnap`: width, gap and height each round ONCE to whole device
 * pixels, half up, and every bar uses those three values, so the bars come out
 * equal at every scale. This is `PixelRatio.roundToNearestPixel(value)` written
 * out, so the unit tier can check it against `pixelSnap.examples` without
 * react-native. The radius is not snapped.
 */
export function priorityMeterGeometry(pixelRatio: number): PriorityMeterGeometry {
  const snap = (value: number): number => Math.floor(value * pixelRatio + 0.5) / pixelRatio;
  return {
    width: snap(PRIORITY_METER_BAR.width),
    height: snap(PRIORITY_METER_BAR.height),
    gap: snap(PRIORITY_METER_BAR.gap),
    radius: PRIORITY_METER_BAR.radius,
  };
}
