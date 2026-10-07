import { useEffect } from 'react';
import { cardSessionDisplay, toCardSession } from '@/components/board/cardSessionDisplay';
import { selectTaskRespawn, useActivityStore } from '@/state/activityStore';
import { selectTaskRow, useBoardStore } from '@/state/boardStore';
import { selectResumeAttempt, useResumeStore, type ResumeAttempt } from '@/state/resumeStore';

/**
 * The desktop's failure line (TaskDetailBody.tsx), for a failed resume that
 * carried no refusal text of its own. Shared by every surface that shows one.
 */
export const RESUME_FAILED_MESSAGE = 'Session could not be resumed.';

export interface ResumeOffer {
  /** True while the task reads as Paused and the desktop offers Resume for it (see the gate below). */
  offered: boolean;
  attempt: ResumeAttempt | null;
}

/**
 * The one Resume gate, shared by every surface that offers Resume (the
 * session screen's button, the header's play button, the long-press item), so
 * no two of them can disagree about whether a task can be resumed.
 *
 * Offered only for a task the card reads as Paused (cardSessionDisplay, so a
 * spawn label in flight - a respawn's step, or the desktop's own "Resuming
 * session..." - is never offered Resume) AND that the desktop marks
 * resumable. The authority is the BOARD ROW's `BoardTaskWire.resumable`
 * (protocol 0.16.0): a desktop pause clears the task's `session_id`, so the
 * phone holds no stream on a paused session once the board refreshes, and the
 * row is refreshed by the board event a pause, resume, move or archive sends.
 * The stream's copy (`SessionActivityEntry.resumable`) counts only while the
 * board row still names that very session, which keeps a session screen open
 * through the suspend current until the board catches up; after that it can
 * be stale (a move to Done is no edge of the session), so it never outvotes
 * the row. Null or absent on the row is a pre-0.16.0 desktop, whose
 * `start-session` starts the column instead of resuming: no Resume there.
 *
 * A resume runs THROUGH the desktop's "Resuming session..." label (the task
 * reads as preparing) and is over once a session holds the task: whichever
 * surface is mounted clears the attempt when the task reads as anything but
 * Paused or preparing, and the board-row watcher in `resumeTaskSession` clears
 * it when the row binds the new session. Keeping it through the label is what
 * lets a failed spawn (the label clears, the task is paused again) fail the
 * attempt rather than hand back a fresh Resume button with no error.
 *
 * A FAILED attempt clears as soon as the task stops reading as Paused, so its
 * error line cannot resurface under a fresh Resume button the next time the
 * task pauses (resumed from the desktop meanwhile, say). That never hides an
 * error anyone could see: every surface that draws one draws it only while the
 * task is paused.
 */
export function useResumeOffer(taskId: string | null, sessionId: string | null): ResumeOffer {
  const entry = useActivityStore((state) => (sessionId ? (state.bySessionId[sessionId] ?? null) : null));
  const respawn = useActivityStore((state) => (taskId ? selectTaskRespawn(state, taskId) : null));
  const task = useBoardStore((state) => selectTaskRow(state, taskId));
  const attempt = useResumeStore((state) => selectResumeAttempt(state, taskId));
  const displayKind = cardSessionDisplay({ session: toCardSession(entry), respawn, task }).kind;
  const paused = displayKind === 'suspended';
  const attemptOver = attempt !== null && !paused && (attempt.phase === 'failed' || displayKind !== 'preparing');
  useEffect(() => {
    if (taskId !== null && attemptOver) useResumeStore.getState().clear(taskId);
  }, [taskId, attemptOver]);
  // A boolean on the row is what marks a 0.16.0 desktop; the copy never
  // counts against an older one, whatever the entry holds.
  const streamCopyCounts =
    entry !== null && task !== null && typeof task.resumable === 'boolean' && task.session_id === entry.sessionId && entry.resumable;
  return { offered: paused && (task?.resumable === true || streamCopyCounts), attempt };
}
