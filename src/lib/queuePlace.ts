import type { BoardTaskQueuePlaceWire } from '@kangentic/protocol';

/**
 * A queued task's place in line (protocol 0.28.0), in the desktop's own words.
 * Ported from the desktop card's `useQueuedStatus` (kangentic
 * `src/renderer/components/board/task-card-view.tsx`) and its queued task
 * window's `QueueHeading` / `QueueCount` / `QueueReason`
 * (`src/renderer/components/dialogs/task-detail/QueuedPlaceholder.tsx`).
 *
 * The plurals are the desktop CODE's, not its docs': the protocol's comment and
 * the bridge doc flatten both to "# agents", but the window reads "runs one
 * agent" (a word, not "1") and "Up to 1 agent runs".
 *
 * A place is null on a desktop older than 0.28.0, or before the desktop has
 * worked one out, and a `kind` this phone does not know reads as no place:
 * both draw the plain "Queued..." the card drew before.
 */

export const QUEUED_LABEL = 'Queued...';
export const QUEUED_HEADING = 'Queued';

type KnownQueuePlace = BoardTaskQueuePlaceWire & { kind: 'column' | 'global' };

function knownPlace(place: BoardTaskQueuePlaceWire | null | undefined): KnownQueuePlace | null {
  if (place === null || place === undefined) return null;
  if (place.kind !== 'column' && place.kind !== 'global') return null;
  return place as KnownQueuePlace;
}

function tasksAhead(place: KnownQueuePlace): number {
  return Math.max(0, place.position - 1);
}

/** The card footer's words: "Next in line...", "1 task ahead...", "N tasks ahead...", else "Queued...". */
export function queuedCardLabel(place: BoardTaskQueuePlaceWire | null | undefined): string {
  const known = knownPlace(place);
  if (known === null) return QUEUED_LABEL;
  const ahead = tasksAhead(known);
  if (ahead === 0) return 'Next in line...';
  return ahead === 1 ? '1 task ahead...' : `${ahead} tasks ahead...`;
}

/**
 * The desktop card's hover tip, which a touch screen has no hover for: the
 * footer's accessibility label carries it. Null when no place is known, as the
 * desktop shows no tip then.
 */
export function queuedCardTip(place: BoardTaskQueuePlaceWire | null | undefined): string | null {
  const known = knownPlace(place);
  if (known === null) return null;
  if (known.kind === 'global') return 'Waiting for a free agent slot.';
  return known.column_name !== null ? `Waiting for a slot in ${known.column_name}.` : 'Waiting for a free agent slot.';
}

/** The queued window's heading: the card's words without the dots, "Queued" when no place is known. */
export function queuedHeading(place: BoardTaskQueuePlaceWire | null | undefined): string {
  const known = knownPlace(place);
  if (known === null) return QUEUED_HEADING;
  const ahead = tasksAhead(known);
  if (ahead === 0) return 'Next in line';
  return ahead === 1 ? '1 task ahead' : `${ahead} tasks ahead`;
}

/** The count pill beside the heading, "{position} of {total}", or null when no place is known. */
export function queuedCount(place: BoardTaskQueuePlaceWire | null | undefined): string | null {
  const known = knownPlace(place);
  return known === null ? null : `${known.position} of ${known.total}`;
}

/**
 * What the queued window's reason line says, and which glyph leads it: the
 * gauge for `global`, the task's own column's icon for `column` (a column
 * limit always holds a task in its own column, so the panel takes that column
 * from the task rather than from here).
 */
export interface QueuedReason {
  kind: 'column' | 'global';
  text: string;
}

/**
 * The reason line: "{column} runs one agent at a time" / "runs N agents at a
 * time" for a column limit, "Up to 1 agent runs at a time" / "Up to N agents
 * run at a time" for the desktop's Max concurrent sessions. Null when no place
 * or no limit is known: the desktop draws no reason then either.
 */
export function queuedReason(place: BoardTaskQueuePlaceWire | null | undefined): QueuedReason | null {
  const known = knownPlace(place);
  if (known === null || known.max_agents === null || known.max_agents < 1) return null;
  const limit = known.max_agents;
  if (known.kind === 'global') {
    return { kind: 'global', text: limit === 1 ? 'Up to 1 agent runs at a time' : `Up to ${limit} agents run at a time` };
  }
  if (known.column_name === null) return null;
  const agents = limit === 1 ? 'one agent' : `${limit} agents`;
  return { kind: 'column', text: `${known.column_name} runs ${agents} at a time` };
}
