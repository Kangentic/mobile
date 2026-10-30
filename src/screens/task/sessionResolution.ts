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
  /** resolveCurrentSessionId's answer: null once a pause cleared the row's session_id. */
  currentSessionId: string | null;
  /** The last session the screen was bound to, the one the pause took. */
  lastBoundSessionId: string | null;
}

/**
 * The session a PAUSED task's composer sends to, or null when it has none.
 *
 * Since protocol 0.26.0 a `send-user-message` to a session with no running
 * agent is HELD by the desktop for the task's next agent instead of refused. A
 * desktop pause clears the row's `session_id`, but the session it paused stays
 * in the desktop's registry for the rest of that desktop run, so a screen that
 * was bound when the task paused can still name it. Only while the row offers
 * Resume: `resumable` already excludes To Do, Done and an archived task, where
 * the desktop refuses a hold, and a row carrying a spawn label is a swap or a
 * resume in flight, which the swap window and the launch face own.
 *
 * A screen opened on an already-paused task was never bound, so it has none and
 * its footer stays the switcher alone, until the board row names the paused
 * session (a desktop protocol addition). After a desktop restart the paused
 * session is re-registered under a new id, so a send to the remembered one is
 * refused and reads "Session ended", as any refused send does.
 *
 * This id feeds the composer only. It is never a binding: nothing subscribes to
 * it, and resolveCurrentSessionId and the resume watch never see it.
 */
export function pausedComposerSessionId(input: PausedComposerInput): string | null {
  if (input.row === null || input.row.resumable !== true || hasSpawnLabel(input.row)) return null;
  if (input.currentSessionId !== null) return null;
  return input.lastBoundSessionId;
}
