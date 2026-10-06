import type { ReadStreamSessionStatusWire } from '@kangentic/protocol';
import type { RespawnInFlight } from '@/state/activityStore';

/**
 * The longest desktop step label a card draws. The protocol's own contract for
 * `spawnProgressLabel`: untrusted display text, so cap it and never parse it.
 * The footer's single line truncates what is left.
 */
export const SPAWN_LABEL_MAX_LENGTH = 80;

/**
 * Which of the desktop card's states a task card is in. A port of the
 * desktop's `SessionDisplayState` (kangentic `src/shared/types.ts`), minus
 * `initializing`, which the desktop declares but never produces. The task
 * card's footer switches on it exactly as the desktop's does
 * (CardStatusFooter), and only `running` draws a status icon in the title row.
 */
export type CardSessionDisplay =
  | { kind: 'none' }
  | { kind: 'preparing'; label: string }
  | { kind: 'queued' }
  | { kind: 'suspended' }
  | { kind: 'running' }
  | { kind: 'exited' };

export interface CardSessionDisplayInput {
  /** Whether the phone holds a session for this task (an activity entry). */
  hasSession: boolean;
  /** The session's lifecycle status at subscribe time; null or absent means running. */
  sessionStatus: ReadStreamSessionStatusWire | null | undefined;
  /** The task's respawn in flight (`selectTaskRespawn`): its session just ended. */
  respawn: RespawnInFlight | null;
}

/**
 * The desktop's precedence, from `getTaskProgress` (kangentic
 * `src/renderer/utils/task-progress.ts`): a step label wins only when no
 * session is running; then the session's status decides.
 *
 * The phone's one source of a step label is the `session-ended` push, so a
 * respawn in flight always means the session is gone: with a label the card
 * shows that step, as the desktop's footer does through the gap; without one
 * it is simply an ended session, which the desktop draws with no footer.
 */
export function cardSessionDisplay({ hasSession, sessionStatus, respawn }: CardSessionDisplayInput): CardSessionDisplay {
  if (respawn !== null) {
    const label = respawn.label?.trim() ?? '';
    return label.length > 0 ? { kind: 'preparing', label: label.slice(0, SPAWN_LABEL_MAX_LENGTH) } : { kind: 'exited' };
  }
  if (!hasSession) return { kind: 'none' };
  switch (sessionStatus) {
    case 'queued':
      return { kind: 'queued' };
    case 'suspended':
      return { kind: 'suspended' };
    case 'exited':
      return { kind: 'exited' };
    case 'running':
    case null:
    case undefined:
      return { kind: 'running' };
  }
}
