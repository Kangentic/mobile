import { PUSH_ENVELOPE_MAX_AGE_MS, type BoardTaskWire } from '@kangentic/protocol';
import type { SessionActivityEntry } from '@/state/activityStore';
import { isDoneRole, type ProjectBoard } from '@/state/boardStore';
import type { NotificationRouting } from './notificationRouting';
import type { NotificationSurface } from './notificationSignals';

/**
 * WHEN A DISPLAYED NOTIFICATION STOPS BEING TRUE. A pure function of the alert
 * and the stores, so every rule here is unit-testable without a device; the
 * reconciler (notificationReconciler.ts) only lists, decrypts and cancels.
 *
 * NEVER DISMISS ON UNKNOWN. That is the one property that matters, because the
 * stores are wrong in the ways that look most like an answer: they are empty on
 * a cold start, they hold the `'sessions'` projection where a missing task may
 * still exist, and they SURVIVE every disconnect (only unpair resets them), so
 * `feedStatus: 'live'` and "every project has a board" both hold on data from
 * before the phone went away. Getting it wrong wipes every alert at launch.
 *
 * So a rule reads only state observed AFTER the alert was posted, gated on the
 * source it reads:
 *
 * - A board-row rule (archived, done, column, a newer session, the task gone)
 *   needs the project's board snapshot to be newer than the alert.
 * - A session-state rule (permission, thinking, the awaited prompt) needs the
 *   session's entry to be FRESH: a snapshot or event landed after the alert.
 *   Not the board: answering a prompt is a stream event and re-snapshots no
 *   board, so a board gate would keep every alert the keepalive should cancel.
 * - A session END counts whenever it was seen: `endedSessionIds` and an
 *   `'ended'` feed only ever record an end observed in this run.
 *
 * The one exception is a surface the user is looking at (clear on open), which
 * needs no freshness because it is not a claim about the desktop at all.
 */

export type StalenessVerdict = 'keep' | 'dismiss';

/** A displayed alert as the reconciler tracks it. */
export type JudgedNotification =
  | {
      kind: 'routed';
      routing: NotificationRouting;
      /** Epoch ms, or null when the platform cannot say (then nothing is ordered against it). */
      postedAt: number | null;
      /** The task's column when first seen against a board newer than the alert. */
      firstSeenSwimlaneId: string | null;
      /** The session's awaited prompt when first seen fresh (or when a local alert was posted). */
      firstSeenPromptId: string | null;
    }
  /** An Android "Agent needs attention" placeholder: a push that could not be decrypted, so it names nothing. */
  | { kind: 'android-placeholder'; postedAt: number | null }
  /** An iOS alert whose sealed envelope this app cannot open (no key, tampered, or older than the envelope window). */
  | { kind: 'ios-undecryptable'; postedAt: number | null };

export interface StalenessContext {
  now: number;
  projects: readonly { id: string }[];
  boardsByProjectId: Readonly<Record<string, ProjectBoard>>;
  bySessionId: Readonly<Record<string, SessionActivityEntry>>;
  endedSessionIds: Readonly<Record<string, true>>;
  /** Empty unless the app is in front: a screen stays mounted in the background and must not eat a fresh alert. */
  openSurfaces: readonly NotificationSurface[];
}

/**
 * Whether the user is looking at what this alert is about. A task's alerts match
 * its session screen; a Command Terminal's (whose task id is made up) match the
 * terminal by session; a workflow-complete matches its home project's Board,
 * and NOTHING else does - opening a project's Board is not reading a task's
 * prompt.
 */
export function notificationMatchesSurface(routing: NotificationRouting, surface: NotificationSurface): boolean {
  switch (surface.kind) {
    case 'task':
      return (
        routing.category !== 'workflow-complete' &&
        routing.sessionKind !== 'command-terminal' &&
        routing.taskId.length > 0 &&
        routing.taskId === surface.taskId
      );
    case 'command-terminal':
      return routing.sessionKind === 'command-terminal' && routing.sessionId.length > 0 && routing.sessionId === surface.sessionId;
    case 'project-board':
      return routing.category === 'workflow-complete' && routing.projectId.length > 0 && routing.projectId === surface.projectId;
  }
}

/** The project's board, only when its snapshot landed after the alert. */
function freshBoard(context: StalenessContext, projectId: string, postedAt: number): ProjectBoard | null {
  const board = context.boardsByProjectId[projectId];
  return board !== undefined && board.snapshotAt > postedAt ? board : null;
}

/**
 * The session's entry, only when it reflects the desktop AFTER the alert: a
 * snapshot landed (`'live'`) or the end arrived (`'ended'`), and something
 * touched it since. A `'pending'` entry never counts, because registration
 * stamps `lastEventAt` with the current time over a DEFAULT idle state that no
 * desktop reported; `'rejected'` is a refused subscribe, which says nothing.
 */
function freshEntry(context: StalenessContext, sessionId: string, postedAt: number): SessionActivityEntry | null {
  if (sessionId.length === 0) return null;
  const entry = context.bySessionId[sessionId];
  if (entry === undefined) return null;
  if (entry.feedStatus !== 'live' && entry.feedStatus !== 'ended') return null;
  return entry.lastEventAt > postedAt ? entry : null;
}

function sessionEnded(context: StalenessContext, sessionId: string): boolean {
  if (sessionId.length === 0) return false;
  return context.endedSessionIds[sessionId] === true || context.bySessionId[sessionId]?.feedStatus === 'ended';
}

/**
 * Whether the store still holds the session as possibly running. This is what
 * protects the successor race: a session subscribed from the desktop's
 * `successorSessionId` before any board names it keeps a live entry (the
 * reconcile retains it), so a board snapshot computed before the resume cannot
 * dismiss the prompt alert it just raised. (The newer-session rule guards the
 * same race its own way, by never reading a session it saw end as newer.) A
 * `'rejected'` entry counts as live too: a refused subscribe is not proof the
 * session is gone.
 */
function hasLiveEntry(context: StalenessContext, sessionId: string): boolean {
  if (sessionId.length === 0) return false;
  const entry = context.bySessionId[sessionId];
  return entry !== undefined && entry.feedStatus !== 'ended';
}

function taskColumnIsDone(board: ProjectBoard, row: BoardTaskWire): boolean {
  const column = board.columns.find((candidate) => candidate.id === row.swimlane_id);
  return column !== undefined && isDoneRole(column.role);
}

/**
 * The session-state rules a task's alert and a Command Terminal's share, read
 * only off a FRESH entry. "Needs your input" stops being true once the session
 * leaves `permission`, or once the prompt first seen resolves with none after
 * it. NOT when the session moves straight on to ANOTHER prompt: the agent still
 * needs input, and the local notifier's cooldown can have swallowed that
 * prompt's own alert, so dismissing here would leave the phone showing nothing
 * for an agent that is waiting. "Finished" stops being true once it is
 * thinking again.
 */
function sessionStateDismisses(notification: Extract<JudgedNotification, { kind: 'routed' }>, entry: SessionActivityEntry | null): boolean {
  if (entry === null) return false;
  switch (notification.routing.category) {
    case 'input-required':
      if (entry.state !== 'permission') return true;
      return notification.firstSeenPromptId !== null && entry.awaitedPromptId === null;
    case 'turn-complete':
    case 'plan-complete':
      return entry.state === 'thinking';
    default:
      return false;
  }
}

function judgeTaskAlert(
  notification: Extract<JudgedNotification, { kind: 'routed' }>,
  postedAt: number,
  context: StalenessContext,
): StalenessVerdict {
  const routing = notification.routing;
  const board = freshBoard(context, routing.projectId, postedAt);
  const row = board !== null && routing.taskId.length > 0 ? (board.tasksById[routing.taskId] ?? null) : null;

  // Any task's alert: the task is closed. A 'full' board carries every
  // non-archived task, so a task missing from it was archived (a move to Done
  // archives) or deleted. A 'sessions' board says nothing about existence.
  if (board !== null && routing.taskId.length > 0) {
    if (row !== null) {
      if (row.archived_at !== null) return 'dismiss';
      if (taskColumnIsDone(board, row)) return 'dismiss';
    } else if (board.view === 'full') {
      return 'dismiss';
    }
  }
  // A legacy alert with no category: nothing below can be applied to it.
  if (routing.category === null) return 'keep';

  const entry = freshEntry(context, routing.sessionId, postedAt);
  /**
   * A fresh board names a different, non-null session for the task: this
   * desktop resumes into a new id on every column move. Not when the board's
   * session is one this phone saw END: that is the PREDECESSOR, on a board
   * computed before the resume, and this alert is the live successor's.
   */
  const newerSession =
    row !== null && row.session_id !== null && row.session_id !== routing.sessionId && !sessionEnded(context, row.session_id);
  /**
   * A fresh board holds no row for the task. In a 'sessions' board that means
   * the task has no live session and is neither paused nor preparing, which is
   * how a task closed to Done or sent back to To Do looks there.
   */
  const taskGone = board !== null && routing.taskId.length > 0 && row === null;
  const noLiveEntry = !hasLiveEntry(context, routing.sessionId);

  switch (routing.category) {
    case 'input-required': {
      if (sessionEnded(context, routing.sessionId)) return 'dismiss';
      if (newerSession) return 'dismiss';
      // The board names no session (or another) for the task and nothing in
      // the store still runs this one: no prompt can be pending on it.
      const boardDropsSession = board !== null && routing.taskId.length > 0 && (row === null || row.session_id !== routing.sessionId);
      if (boardDropsSession && noLiveEntry) return 'dismiss';
      return sessionStateDismisses(notification, entry) ? 'dismiss' : 'keep';
    }
    case 'turn-complete':
    case 'plan-complete':
      // NOT a bare session end: an idle-timeout pause ends the session but
      // keeps a resumable row on the board, and the agent having finished is
      // still true of a paused task.
      if (newerSession) return 'dismiss';
      if (taskGone && noLiveEntry) return 'dismiss';
      if (sessionStateDismisses(notification, entry)) return 'dismiss';
      if (row !== null && notification.firstSeenSwimlaneId !== null && row.swimlane_id !== notification.firstSeenSwimlaneId) {
        return 'dismiss';
      }
      return 'keep';
    case 'session-failed':
      return newerSession ? 'dismiss' : 'keep';
    case 'spawn-stalled':
      if (row !== null && row.session_id !== null) return 'dismiss';
      if (entry !== null && entry.feedStatus === 'live') return 'dismiss';
      return 'keep';
    case 'workflow-complete':
      // Only its project's Board clears it (the surface check, above).
      return 'keep';
  }
}

/**
 * A Command Terminal's alerts: its task id is made up, so no board row rule
 * applies. It has no successor and no pause either, so an end is an end, and
 * "gone" is the board's terminal list no longer holding it.
 */
function judgeCommandTerminalAlert(
  notification: Extract<JudgedNotification, { kind: 'routed' }>,
  postedAt: number,
  context: StalenessContext,
): StalenessVerdict {
  const routing = notification.routing;
  const board = freshBoard(context, routing.projectId, postedAt);
  const entry = freshEntry(context, routing.sessionId, postedAt);
  const terminalGone =
    board !== null &&
    !board.commandTerminals.some((terminal) => terminal.sessionId === routing.sessionId) &&
    !hasLiveEntry(context, routing.sessionId);
  const ended = sessionEnded(context, routing.sessionId) || terminalGone;
  switch (routing.category) {
    case 'input-required':
    case 'turn-complete':
    case 'plan-complete':
      if (ended) return 'dismiss';
      return sessionStateDismisses(notification, entry) ? 'dismiss' : 'keep';
    default:
      return 'keep';
  }
}

/**
 * The Android placeholder names nothing, so it is judged against everything:
 * dismissed only once EVERY paired project is known after it - its board and
 * every live session that board names - because the Agents feed then shows
 * whatever it might have been about. One project or one session not yet
 * re-read keeps it.
 */
function everyProjectFreshAfter(context: StalenessContext, postedAt: number): boolean {
  if (context.projects.length === 0) return false;
  // Every board first, one lookup each, so the walk over every session below
  // runs only once they have all landed.
  const boards: ProjectBoard[] = [];
  for (const project of context.projects) {
    const board = freshBoard(context, project.id, postedAt);
    if (board === null) return false;
    boards.push(board);
  }
  for (const board of boards) {
    for (const task of Object.values(board.tasksById)) {
      if (task.session_id === null || task.archived_at !== null) continue;
      if (freshEntry(context, task.session_id, postedAt) === null) return false;
    }
    for (const terminal of board.commandTerminals) {
      if (freshEntry(context, terminal.sessionId, postedAt) === null) return false;
    }
  }
  return true;
}

export function judgeNotification(notification: JudgedNotification, context: StalenessContext): StalenessVerdict {
  const postedAt = notification.postedAt;
  switch (notification.kind) {
    case 'ios-undecryptable':
      // The envelope window is the protocol's, not a guess: past it the app can
      // never open this alert again, so it can never be routed or judged.
      return postedAt !== null && context.now - postedAt > PUSH_ENVELOPE_MAX_AGE_MS ? 'dismiss' : 'keep';
    case 'android-placeholder':
      return postedAt !== null && everyProjectFreshAfter(context, postedAt) ? 'dismiss' : 'keep';
    case 'routed': {
      const routing = notification.routing;
      if (context.openSurfaces.some((surface) => notificationMatchesSurface(routing, surface))) return 'dismiss';
      // A Notify me push (protocol 0.26.0) is the user's own request to be
      // told, not a claim about the desktop's state, and the desktop never
      // clears it: only opening its task does (the surface rule above). Every
      // rule below would misread it. It names no session, so the session rules
      // see an empty id that no board row holds and dismiss it on the first
      // newer board, and a row fired by a move to Done would die on the
      // Done/archived check the moment it arrived.
      if (routing.authored) return 'keep';
      if (postedAt === null) return 'keep';
      // The cold-start floor: a project this phone has no board for is not
      // judged at all.
      if (context.boardsByProjectId[routing.projectId] === undefined) return 'keep';
      if (routing.sessionKind === 'command-terminal') return judgeCommandTerminalAlert(notification, postedAt, context);
      return judgeTaskAlert(notification, postedAt, context);
    }
  }
}

/**
 * What the reconciler records the first time it can see a routed alert against
 * state NEWER than the alert: the task's column (so a later move reads as a
 * change) and the prompt its session awaits (so an answer reads as a change,
 * since the push envelope carries no prompt id). Never from older state: a board
 * from before a move would record the old column and then dismiss the very alert
 * just sent for the new one.
 */
export function observeAtFirstSight(
  notification: Extract<JudgedNotification, { kind: 'routed' }>,
  context: StalenessContext,
): { swimlaneId: string | null; promptId: string | null } {
  const routing = notification.routing;
  const postedAt = notification.postedAt;
  if (postedAt === null) return { swimlaneId: null, promptId: null };
  let swimlaneId: string | null = null;
  if (routing.sessionKind !== 'command-terminal' && routing.taskId.length > 0) {
    const board = freshBoard(context, routing.projectId, postedAt);
    swimlaneId = board?.tasksById[routing.taskId]?.swimlane_id ?? null;
  }
  let promptId: string | null = null;
  if (routing.category === 'input-required') {
    const entry = freshEntry(context, routing.sessionId, postedAt);
    if (entry !== null && entry.state === 'permission') promptId = entry.awaitedPromptId;
  }
  return { swimlaneId, promptId };
}
