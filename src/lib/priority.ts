import { PRIORITY_FALLBACK_COLOR, type PriorityLevelWire } from '@kangentic/protocol';

const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

/**
 * A task's priority as the desktop card draws it (protocol 0.28.0, kangentic
 * 6bc394e19 and `PriorityBadge.tsx`): the project's scale, lowest first, with
 * the task's `priority` an index into it.
 *
 * - The bottom of the scale (index 0) draws NOTHING, whatever it is named:
 *   position decides, not the label.
 * - An index past the end of the scale draws `P<n>` in the protocol's gray.
 * - No scale at all is a desktop older than 0.28.0, which never told the phone
 *   what an index means, so nothing is drawn (the phone drew no priority
 *   before either).
 *
 * The level's color is the desktop's stored "#rrggbb", which the protocol's
 * parser has already checked (a malformed one arrives as the fallback gray);
 * it is checked again here because the card tints it and a bad value would
 * throw there. It is drawn raw, as a column's color is, since it is the
 * project's own data rather than a theme choice.
 */
export function priorityLevelFor(priority: number | null | undefined, scale: readonly PriorityLevelWire[] | null): PriorityLevelWire | null {
  if (scale === null) return null;
  if (typeof priority !== 'number' || !Number.isInteger(priority) || priority <= 0) return null;
  const level = scale[priority];
  if (level === undefined) return { label: `P${priority}`, color: PRIORITY_FALLBACK_COLOR };
  return HEX_COLOR_PATTERN.test(level.color) ? level : { label: level.label, color: PRIORITY_FALLBACK_COLOR };
}
