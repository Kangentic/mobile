import type { BoardTaskWire } from '@kangentic/protocol';
import { hasSpawnLabel } from '@/state/boardStore';

/**
 * Resolves which sessionId the task screen should bind to.
 *
 * The board is the single source of truth for a task's CURRENT session: the
 * desktop respawns a task's agent under a fresh sessionId on a model switch,
 * settings change, or crash recovery, and only the board snapshot carries the
 * successor. A navigation param is a snapshot of the world when the user
 * tapped, so it is only trusted while the board has not located the task yet
 * (deep links and push tap-throughs arrive before the first board snapshot).
 *
 * Once the board knows the task, its answer wins INCLUDING null: a located
 * task with no session_id means the session ended with no successor, and the
 * screen must say so rather than stay subscribed to a corpse.
 */
export interface SessionResolutionInput {
  /** True once the board store has located this taskId in any project. */
  taskLocated: boolean;
  /** The task's current session_id per the board store, when located. */
  locatedSessionId: string | null;
  /** The sessionId navigation param, normalized to null when absent/empty. */
  paramSessionId: string | null;
}

export function resolveCurrentSessionId(input: SessionResolutionInput): string | null {
  return input.taskLocated ? input.locatedSessionId : input.paramSessionId;
}

export interface PausedComposerInput {
  /** The task's board row, or null when no cached board holds it. */
  row: Pick<BoardTaskWire, 'resumable' | 'spawn_progress'> | null;
  /**
   * The row's `paused_session_id` (protocol 0.27.0): null on an older desktop,
   * and whenever the task is not paused. A required field of its own rather
   * than part of `row`: the wire field is optional, so a row narrowed without
   * it (toCardTaskRow) would still type-check and leave the composer off
   * everywhere, with nothing to say so.
   */
  pausedSessionId: string | null;
  /** resolveCurrentSessionId's answer: null once a pause cleared the row's session_id. */
  currentSessionId: string | null;
}

/**
 * The session a PAUSED task's composer sends to, or null when it has none.
 *
 * Since protocol 0.26.0 a `send-user-message` to a session with no running
 * agent is HELD by the desktop for the task's next agent instead of refused. A
 * desktop pause clears the row's `session_id`, and since protocol 0.27.0 the
 * row names that session in `paused_session_id`, so a screen opened on an
 * already-paused task can send as well as one that was bound when it paused.
 * Only while the row offers Resume: `resumable` already excludes To Do, Done
 * and an archived task, where the desktop refuses a hold, and a row carrying a
 * spawn label is a swap or a resume in flight, which the swap window and the
 * launch face own.
 *
 * The row is the only source. A session the screen remembers is not a stand-in:
 * desktop v0.51.0 (protocol 0.25.0) refuses a send to a paused session, and a
 * desktop restart re-registers the session under a new id, so either way the
 * remembered id would be refused and read "Session ended". The row's id tracks
 * a restart (it reaches the phone as a board event, so the next snapshot
 * carries it), and a null one means this desktop holds nothing, which leaves
 * the footer as it was before protocol 0.26.0.
 *
 * This id feeds the composer only. It is never a binding: nothing subscribes to
 * it, and resolveCurrentSessionId and the resume watch never see it.
 */
export function pausedComposerSessionId(input: PausedComposerInput): string | null {
  if (input.row === null || input.row.resumable !== true || hasSpawnLabel(input.row)) return null;
  if (input.currentSessionId !== null) return null;
  return input.pausedSessionId;
}
