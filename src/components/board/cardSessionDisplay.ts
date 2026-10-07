import type { BoardTaskWire, ReadStreamSessionStatusWire } from '@kangentic/protocol';
import type { RespawnInFlight, SessionActivityEntry } from '@/state/activityStore';

/**
 * The longest desktop step label a card draws. The protocol's own contract for
 * `spawnProgressLabel` and `spawn_progress`: untrusted display text, so cap it
 * and never parse it. The footer's single line truncates what is left.
 */
export const SPAWN_LABEL_MAX_LENGTH = 80;

/**
 * Which of the desktop card's states a task card is in. A port of the
 * desktop's `SessionDisplayState` (kangentic `src/shared/types.ts`), minus
 * `initializing`, which the desktop declares but never produces. The task
 * card's footer switches on it exactly as the desktop's does
 * (CardStatusFooter), and only `running` draws a status icon in the title row.
 *
 * `running.resuming` is the desktop session's own `resuming` flag: its footer
 * reads "Resuming agent..." rather than "Starting agent..." until the agent
 * reports a model.
 */
export type CardSessionDisplay =
  | { kind: 'none' }
  | { kind: 'preparing'; label: string }
  | { kind: 'queued' }
  | { kind: 'suspended' }
  | { kind: 'running'; resuming: boolean }
  | { kind: 'exited' };

/** The task's session as the phone holds it: an activity entry, narrowed to what the card reads. */
export interface CardSession {
  /** The session's lifecycle status; null (never snapshotted) reads as running, the protocol's fallback. */
  status: ReadStreamSessionStatusWire | null | undefined;
  resuming: boolean;
  /** The desktop pushed `session-ended` for it: a ghost the phone keeps only to hold the row's place. */
  ended: boolean;
}

/**
 * The board row's share of the decision. `spawn_progress` and `resumable` are
 * protocol 0.16.0 fields and `paused` is 0.17.0; each is null or absent on a
 * desktop older than its version.
 */
export type CardTaskRow = Pick<BoardTaskWire, 'session_id' | 'spawn_progress' | 'resumable' | 'paused' | 'archived_at'>;

export interface CardSessionDisplayInput {
  /** The task's session (an activity entry), or null when the phone holds none. */
  session: CardSession | null;
  /** The task's end in flight (`selectTaskRespawn`): its session just ended. */
  respawn: RespawnInFlight | null;
  /** The task's board row, or null when no cached board holds the task. */
  task: CardTaskRow | null;
}

/**
 * A board row narrowed to the card's fields, for a `useShallow` store
 * selector. Every board snapshot replaces every row object, so a component
 * that selects the row itself re-renders on each snapshot of its project
 * whether or not anything it reads changed.
 */
export function toCardTaskRow(task: CardTaskRow | null): CardTaskRow | null {
  if (task === null) return null;
  return {
    session_id: task.session_id,
    spawn_progress: task.spawn_progress,
    resumable: task.resumable,
    paused: task.paused,
    archived_at: task.archived_at,
  };
}

/**
 * Whether the board row says the task is paused: protocol 0.17.0's `paused`,
 * the desktop's own fact (a paused session and no live one, whatever the
 * column). It reads true for a paused task in Done, where `resumable` reads
 * false. A desktop older than 0.17.0 sends `paused` as null, so this reduces
 * to `resumable` alone, the only paused signal such a row carries.
 * `resumable: true` always comes with `paused: true`, so reading either one
 * changes nothing on a well-formed row.
 *
 * An archived row never reads paused, though its `paused` is true. The desktop
 * draws an archived task as a compact card with no footer (DoneSwimlane's
 * Completed list, CompletedTasksDialog), and every move into Done archives the
 * task in the same step. A Paused footer there would put "Paused" on nearly
 * every completed card. Only a task sitting in Done UNARCHIVED gets the
 * desktop's full card and its "Paused".
 */
export function boardRowPaused(task: CardTaskRow): boolean {
  if (task.archived_at !== null) return false;
  return task.paused === true || task.resumable === true;
}

/** An activity entry as the card reads it. Shared so no call site narrows it differently. */
export function toCardSession(entry: SessionActivityEntry | null): CardSession | null {
  if (entry === null) return null;
  return { status: entry.sessionStatus, resuming: entry.resuming, ended: entry.feedStatus === 'ended' };
}

function displayLabel(label: string | null | undefined): string | null {
  const trimmed = label?.trim() ?? '';
  return trimmed.length > 0 ? trimmed.slice(0, SPAWN_LABEL_MAX_LENGTH) : null;
}

/**
 * The desktop's precedence, from `getTaskProgress` (kangentic
 * `src/renderer/utils/task-progress.ts`): a step label wins only over a session
 * that is gone or parked, never over a running or queued one; then the
 * session's status decides. The phone has two label sources where the desktop
 * has one, and one source of "paused" the desktop does not need:
 *
 * 1. The board row's `spawn_progress` (protocol 0.16.0), when there is no live
 *    session, it has ended, or it is suspended. The desktop suspends before
 *    every model, agent or effort respawn, so without this a respawn would read
 *    "Paused" for its whole gap.
 * 2. An end in flight (`session-ended`). Its own label, when it carried one, is
 *    the step. An unlabelled end is a park on a 0.16.0 desktop (which labels
 *    every respawn before it suspends): once the board row has moved past the
 *    ended id, the row decides (`boardRowPaused`); before that, the session's
 *    own `suspended` (pushed live just ahead of the end) does. Otherwise the
 *    session simply ended, which the desktop draws with no footer.
 * 3. No live session: the board row is the only sign of a paused task, because
 *    a desktop pause clears `session_id` and with it the phone's stream. From
 *    protocol 0.17.0 the row says so itself (`paused`), so a paused task the
 *    desktop offers no Resume for (one sitting in Done unarchived) reads Paused
 *    as the desktop card does; a 0.16.0 row has only `resumable` to say it
 *    with. See `boardRowPaused` for why an archived row never does.
 * 4. The session's status.
 *
 * Against a pre-0.16.0 desktop every board field here is null and no status
 * push ever says `suspended`, so this reduces exactly to the earlier
 * precedence: a respawn's label, else an ended session, else the session's
 * snapshot status.
 */
export function cardSessionDisplay({ session, respawn, task }: CardSessionDisplayInput): CardSessionDisplay {
  const liveSession = session !== null && !session.ended ? session : null;
  const boardLabel = displayLabel(task?.spawn_progress);
  if (boardLabel !== null && (liveSession === null || respawn !== null || liveSession.status === 'suspended')) {
    return { kind: 'preparing', label: boardLabel };
  }
  if (respawn !== null) {
    const respawnLabel = displayLabel(respawn.label);
    if (respawnLabel !== null) return { kind: 'preparing', label: respawnLabel };
    const boardMovedPast = task !== null && task.session_id !== respawn.endedSessionId;
    const paused = boardMovedPast ? boardRowPaused(task) : session?.status === 'suspended';
    return paused ? { kind: 'suspended' } : { kind: 'exited' };
  }
  if (liveSession === null) return task !== null && boardRowPaused(task) ? { kind: 'suspended' } : { kind: 'none' };
  switch (liveSession.status) {
    case 'queued':
      return { kind: 'queued' };
    case 'suspended':
      return { kind: 'suspended' };
    case 'exited':
      return { kind: 'exited' };
    case 'running':
    case null:
    case undefined:
      return { kind: 'running', resuming: liveSession.resuming };
  }
}
