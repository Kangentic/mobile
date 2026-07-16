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
