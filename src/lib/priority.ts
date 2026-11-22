import { PRIORITY_FALLBACK_COLOR, type PriorityLevelWire } from '@kangentic/protocol';

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * A task's priority level as a card draws it: the scale entry (its name and
 * color), plus where it sits on the scale, which the meter needs to know how
 * many bars to draw (`levelCount`) and how many to light (`level`).
 */
export type CardPriorityLevel = PriorityLevelWire & {
  /** The task's `priority`, an index into the scale. Past the end of the scale it lights every bar. */
  level: number;
  /** The scale's length, bottom entry included. */
  levelCount: number;
};

/**
 * A task's priority as the desktop card draws it (protocol 0.28.0; the
 * equal-bar meter of kangentic #1160 and `PriorityMeter.tsx`): the project's
 * scale, lowest first, with the task's `priority` an index into it.
 *
 * - The bottom of the scale (index 0) draws NOTHING, whatever it is named:
 *   position decides, not the label.
 * - An index past the end of the scale draws `P<n>` in the protocol's gray,
 *   with every bar lit (meter.json's `lit` rule caps at the bar count).
 * - No scale at all is a desktop older than 0.28.0, which never told the phone
 *   what an index means, so nothing is drawn (the phone drew no priority
 *   before either).
 *
 * The level's color is the desktop's stored "#rrggbb", which the protocol's
 * parser has already checked (a malformed one arrives as the fallback gray);
 * it is checked again here because a bad value would reach a View's
 * backgroundColor. It is drawn raw, as a column's color is, since it is the
 * project's own data rather than a theme choice.
 */
export function priorityLevelFor(priority: number | null | undefined, scale: readonly PriorityLevelWire[] | null): CardPriorityLevel | null {
  if (scale === null) return null;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority <= 0) return null;
  const placement = { level: priority, levelCount: scale.length };
  const entry = scale[priority];
  if (entry === undefined) return { label: `P${priority}`, color: PRIORITY_FALLBACK_COLOR, ...placement };
  const color = HEX_COLOR_PATTERN.test(entry.color) ? entry.color : PRIORITY_FALLBACK_COLOR;
  return { label: entry.label, color, ...placement };
}
