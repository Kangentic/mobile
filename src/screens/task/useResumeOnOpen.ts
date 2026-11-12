import { useEffect, useRef, useState } from 'react';
import { resumeTaskOnOpen } from '@/connection/actions';
import { claimTaskOpen, subscribeTaskOpens } from '@/navigation/taskOpenIntent';
import { selectResumeOnOpenOffered, selectTaskRow, useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';

/**
 * The resume on open (protocol 0.28.0), for the session screen: when the person
 * opened this task (a push tap, an Agents card, a Board or workflow card) and
 * it is one the desktop's idle timeout paused, ask the desktop to resume it,
 * the way opening it on the desktop does. See `resumeTaskOnOpen` for what the
 * desktop does with it and why it never fails.
 *
 * The ONE consumer of an open (`taskOpenIntent.ts`), rendered by the session
 * screen alone, so nothing else can send it twice. It claims the open when it
 * mounts, or later when a push tap lands on this screen while it is already
 * on top, then decides ONCE, as soon as the decision can be read:
 *
 * - The task's row is in a board read on THIS connection. A board from before
 *   the current connection is what the phone cached while it was away, and a
 *   push tap into a warm app would otherwise read the row from before the
 *   desktop paused it, see a running task, and drop the open.
 * - Then it sends only if the screen offers Resume (`offered`, the one Resume
 *   gate every surface shares) and the desktop advertises the resume on open.
 *
 * Either way the open is spent on that first look. A pause that lands later on
 * a screen still open, a reconnect, a re-subscribe or a return from a sheet is
 * not an open, and nothing re-claims it: only a new open does. An older desktop
 * (no `resumeOnOpenOffered`) gets nothing, and keeps its Resume button.
 */
export function useResumeOnOpen({
  taskId,
  projectId,
  offered,
}: {
  taskId: string | null;
  projectId: string | null;
  offered: boolean;
}): void {
  // The claim, held by this screen until it is decided. A ref plus a counter:
  // the ref is the claim itself (a re-render must not re-decide it), the
  // counter is what makes the deciding effect look again after a claim.
  const claimed = useRef(false);
  const [claimCount, setClaimCount] = useState(0);
  useEffect(() => {
    if (taskId === null) return undefined;
    const claim = (): void => {
      if (!claimTaskOpen(taskId)) return;
      claimed.current = true;
      setClaimCount((count) => count + 1);
    };
    claim();
    const unsubscribe = subscribeTaskOpens(claim);
    return () => {
      unsubscribe();
      claimed.current = false;
    };
  }, [taskId]);

  const establishedAt = useChannelStore((state) => state.establishedAt);
  const snapshotAt = useBoardStore((state) => (projectId !== null ? (state.boardsByProjectId[projectId]?.snapshotAt ?? null) : null));
  const rowLocated = useBoardStore((state) => selectTaskRow(state, taskId) !== null);
  const resumeOnOpenOffered = useBoardStore((state) => selectResumeOnOpenOffered(state, projectId));
  const boardCurrent = establishedAt !== null && snapshotAt !== null && snapshotAt >= establishedAt;
  const decidable = taskId !== null && projectId !== null && rowLocated && boardCurrent;

  useEffect(() => {
    if (!claimed.current || !decidable || taskId === null || projectId === null) return;
    claimed.current = false;
    if (offered && resumeOnOpenOffered) void resumeTaskOnOpen(taskId, projectId);
  }, [claimCount, decidable, offered, resumeOnOpenOffered, taskId, projectId]);
}
