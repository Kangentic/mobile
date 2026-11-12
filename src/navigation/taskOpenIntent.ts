/**
 * A person's OPEN of a task's session screen, held for the screen to claim:
 * the one signal the protocol 0.28.0 resume on open needs and nothing else in
 * the app carries. The desktop resumes an idle-paused task when it is opened
 * (`start-session` with `trigger: 'open'`), and asks a client to send that once
 * per open gesture and never on a reconnect, a re-subscribe, a re-render or a
 * pause landing on a screen already open: a focused window would otherwise
 * resume, idle and pause all night.
 *
 * Nothing about the screen itself can tell those apart. A push tap onto the
 * task's screen already on top does not remount it (the runner NAVIGATES to the
 * same route and keeps its key), the screen's own effects re-run on every
 * session rebind and focus return, and the stream snapshot arrives on every
 * subscribe. So the open is noted where it is PERFORMED (the push tap's
 * navigation in `PendingNavigationRunner`, an Agents card, a Board or workflow
 * card) and claimed once by the session screen for that task.
 *
 * One slot, as in `pendingNavigation.ts`: an open is "the task the person just
 * asked for", so a newer one supersedes an older one. In memory only, so a
 * restored route never replays one. And it must be claimed within
 * `TASK_OPEN_CLAIM_WINDOW_MS`: an open whose screen never mounted (a lost
 * navigation) must not be picked up by some later remount of that task's
 * screen, which is not an open.
 */

/** How long a noted open waits for its session screen to claim it. A screen mounts within a second even on a cold start; this is generous. */
export const TASK_OPEN_CLAIM_WINDOW_MS = 10_000;

interface TaskOpenIntent {
  readonly taskId: string;
  readonly notedAt: number;
}

let pendingOpen: TaskOpenIntent | null = null;
const subscribers = new Set<() => void>();

/** Notes that the person opened this task's session screen. Call it where the navigation is performed. */
export function noteTaskOpened(taskId: string, now: number = Date.now()): void {
  pendingOpen = { taskId, notedAt: now };
  for (const subscriber of subscribers) subscriber();
}

/**
 * Takes the pending open if it is this task's and still inside the claim
 * window. True at most once per noted open, whoever asks: the first claimant
 * owns it.
 */
export function claimTaskOpen(taskId: string, now: number = Date.now()): boolean {
  const open = pendingOpen;
  if (open === null || open.taskId !== taskId) return false;
  pendingOpen = null;
  return now - open.notedAt <= TASK_OPEN_CLAIM_WINDOW_MS;
}

/** Called on every noted open, so a screen already mounted for that task can claim it. */
export function subscribeTaskOpens(onOpen: () => void): () => void {
  subscribers.add(onOpen);
  return () => {
    subscribers.delete(onOpen);
  };
}

/** Test seam: forgets any pending open. Subscribers stay: they belong to whatever is mounted. */
export function resetTaskOpenIntentForTests(): void {
  pendingOpen = null;
}
