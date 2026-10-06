import { useEffect } from 'react';
import { cardSessionDisplay } from '@/components/board/cardSessionDisplay';
import { selectTaskRespawn, useActivityStore } from '@/state/activityStore';
import { selectResumeAttempt, useResumeStore, type ResumeAttempt } from '@/state/resumeStore';

/**
 * The desktop's failure line (TaskDetailBody.tsx), for a failed resume that
 * carried no refusal text of its own. Shared by every surface that shows one.
 */
export const RESUME_FAILED_MESSAGE = 'Session could not be resumed.';

export interface ResumeOffer {
  /** True while the session is paused and the desktop offers Resume for it (see `SessionActivityEntry.resumable`). */
  offered: boolean;
  attempt: ResumeAttempt | null;
}

/**
 * The one Resume gate, shared by every surface that offers Resume (the
 * session screen's button, the header's play button, the long-press item), so
 * no two of them can disagree about whether a task can be resumed.
 *
 * Offered only for a session the card reads as Paused (cardSessionDisplay,
 * so a respawn's label in flight is never offered Resume) AND that the
 * desktop marks `resumable`. Today that is the stream's copy alone, which no
 * desktop sends yet; protocol 0.16.0 (desktop #762) makes the board row's
 * `BoardTaskWire.resumable` the authoritative source, because a desktop pause
 * clears the task's `session_id` and with it the phone's stream, so mobile
 * #101 adds that task-keyed source here when it adopts 0.16.0.
 *
 * A resume is over as soon as the session is no longer paused: the desktop
 * resumes into a NEW session, so the paused one ends (with the desktop's
 * resume label, then a successor the screen binds as it does after a column
 * move). Whichever surface is mounted then clears the attempt.
 *
 * A FAILED attempt clears the same way, so its error line cannot resurface
 * under a fresh Resume button the next time the task pauses (resumed from the
 * desktop meanwhile, say). That never hides an error anyone could see: every
 * surface that draws one draws it only while the session is paused.
 */
export function useResumeOffer(taskId: string | null, sessionId: string | null): ResumeOffer {
  const entry = useActivityStore((state) => (sessionId ? (state.bySessionId[sessionId] ?? null) : null));
  const respawn = useActivityStore((state) => (taskId ? selectTaskRespawn(state, taskId) : null));
  const attempt = useResumeStore((state) => selectResumeAttempt(state, taskId));
  const paused = cardSessionDisplay({ hasSession: entry !== null, sessionStatus: entry?.sessionStatus, respawn }).kind === 'suspended';
  useEffect(() => {
    if (taskId !== null && attempt !== null && !paused) useResumeStore.getState().clear(taskId);
  }, [taskId, attempt, paused]);
  return { offered: paused && entry !== null && entry.resumable, attempt };
}
