import {
  COMMAND_TERMINAL_LIMIT_ERROR_CODE,
  UNKNOWN_PROJECT_ERROR_CODE,
  UNKNOWN_SESSION_ERROR_CODE,
  UNSUPPORTED_VERB_ERROR_CODE,
  type JsonValue,
  type ReadDiffScope,
} from '@kangentic/protocol';
import { CapabilityError, CapabilityTimeoutError, ChannelDisconnectedError } from '@/channel';
import { collapseToSnippetText, findAwaitedToolUse, lastAssistantText, type AwaitedToolUse } from '@/conversation/pendingPromptSummary';
import { traceConnection } from '@/devsupport/connectionTrace';
import { useActivityStore } from '@/state/activityStore';
import { useChannelStore } from '@/state/channelStore';
import {
  COMMAND_TERMINAL_LIMIT,
  isDoneColumn,
  lowestFreeCommandTerminalSlot,
  selectCommandTerminal,
  selectCommandTerminals,
  selectTaskRow,
  useBoardStore,
} from '@/state/boardStore';
import { selectStartingSlots, useCommandTerminalStore } from '@/state/commandTerminalStore';
import { diffKeyFor, useDiffStore, type DiffTarget } from '@/state/diffStore';
import { useReadingViewStore } from '@/state/readingViewStore';
import { resumeProgress, useResumeStore, type ResumeAttempt } from '@/state/resumeStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { isTerminalRetained, releaseTerminal, resetTerminalFeed, retainTerminal } from '@/state/terminalFeed';
import { lastContentLineFromScrollback } from '@/terminal/liveTail';
import {
  NotConnectedError,
  getActiveConnection,
  reconnectNow,
  requireSubscriptions,
  requireVerbClient,
  type ConnectionTeardownIntent,
} from './connectionManager';
import { runBootstrap } from './bootstrap';
import { reconcileSessionsFromBoards } from './storeFeed';

/**
 * The imperative API screens call - they never touch VerbClient or
 * SubscriptionManager directly. Everything here throws NotConnectedError
 * (or CapabilityError) for the caller's inline error state.
 */

/**
 * Thrown by the three input actions for a Command Terminal whose agent the
 * desktop has not classified yet. A typed error rather than a silent drop, so a
 * caller that shows its failures (the composer, a prompt card) says something
 * rather than nothing; the terminal pane counts it like any failed write.
 */
export class CommandTerminalInputHeldError extends Error {
  constructor() {
    super('The terminal is still starting');
    this.name = 'CommandTerminalInputHeldError';
  }
}

/**
 * The input hold's chokepoint (protocol 0.20.0): nothing typed reaches a
 * Command Terminal until the desktop has classified its agent
 * (`activityObserved`). In the moment after spawn the PTY can be a bare shell
 * at the project root, and holding input there is the phone's half of the
 * desktop's promise that `command-terminal` adds no shell reach.
 *
 * The terminal screen holds the same input in its UI (the pane, the quick
 * keys, the composer), but that layer is opt-in per component; this one is the
 * single path every keystroke, message and prompt answer takes, so a screen
 * that forgets the prop still cannot send. A session is a terminal if its
 * activity entry says so or a board lists it as one; one neither knows yet is
 * not held here, and the screen's own gate (no entry reads as held) covers it.
 */
function assertTerminalInputOpen(sessionId: string): void {
  const entry = useActivityStore.getState().bySessionId[sessionId];
  const isCommandTerminal = entry?.kind === 'command-terminal' || selectCommandTerminal(useBoardStore.getState(), sessionId) !== null;
  if (isCommandTerminal && entry?.activityObserved !== true) throw new CommandTerminalInputHeldError();
}

export async function sendUserMessage(sessionId: string, text: string): Promise<void> {
  assertTerminalInputOpen(sessionId);
  await requireVerbClient().sendUserMessage(sessionId, text);
}

export async function answerPermissionPrompt(sessionId: string, promptId: string, keystrokes: string): Promise<void> {
  assertTerminalInputOpen(sessionId);
  await requireVerbClient().answerPermissionPrompt({ sessionId, promptId, keystrokes });
}

export async function writeTerminal(sessionId: string, data: string): Promise<void> {
  assertTerminalInputOpen(sessionId);
  await requireVerbClient().writeInteractiveTerminal(sessionId, data);
}

/**
 * How long Resume waits, once the desktop has accepted the start, for the
 * desktop to show it is working on it (its "Resuming session..." label) or for
 * the resumed session itself. The desktop answers on accept, and a resume that
 * goes nowhere after that sends the phone nothing, so without a bound it would
 * say "Resuming agent..." forever. The same 20 s the feed already gives a
 * labelled respawn to produce its successor (RESPAWN_ROW_GRACE_MS). A labelled
 * resume is not bounded by it: the label clearing settles that one, and the
 * bound only catches a label that clears onto neither a bind nor a pause.
 */
export const RESUME_WAIT_MS = 20_000;

/** The desktop's refusal text (Resume's and Pause's) is shown as the desktop shows it, capped: it is peer-supplied display text. */
const DESKTOP_REFUSAL_MESSAGE_MAX_LENGTH = 160;

/**
 * The desktop task view's Resume, from the phone: resumes a PAUSED task's
 * session in the column it sits in, by sending `start-session`.
 *
 * Only ever called from a surface `useResumeOffer` gates on the desktop's
 * `resumable` flag, which a desktop sends only when `start-session` takes its
 * own Resume path for a paused task (desktop task #762, protocol 0.16.0): the
 * conversation resumes with no on-enter automations and no column message.
 * An older desktop answers `start-session` the way a move into the column
 * does, re-running the column's automations, which is why the gate exists.
 *
 * Every surface reads the attempt from `useResumeStore`. It stays "resuming"
 * through the desktop's "Resuming session..." label until a new session holds
 * the task (cleared here, or by a surface once the task reads as running), and
 * fails when the label clears with nothing bound (a failed spawn, see
 * `resumeProgress`) or when RESUME_WAIT_MS passes with no label at all. A
 * refusal or a lost connection fails it at once. Resolves with the attempt as
 * the request left it, so a caller that closes on success (the long-press
 * sheet) can stay open to show a refusal.
 */
export async function resumeTaskSession(taskId: string, projectId: string): Promise<ResumeAttempt> {
  const inFlight = useResumeStore.getState().byTaskId[taskId];
  if (inFlight?.phase === 'resuming') return inFlight;
  const startedAt = Date.now();
  const pausedSessionId = selectTaskRow(useBoardStore.getState(), taskId)?.session_id ?? null;
  useResumeStore.getState().markResuming(taskId, startedAt);
  try {
    const response = await requireVerbClient().startSession({ taskId, projectId });
    // `live`: a session is already live (queued counts), so no successor event
    // is coming. Refresh rather than wait, so a stale paused view catches up.
    if (response.outcome === 'live') void refreshSnapshots().catch(() => undefined);
  } catch (error) {
    // A blank refusal reads as no refusal text: null makes every surface show
    // its generic line rather than an empty one.
    const refusalText = error instanceof CapabilityError ? error.message.trim().slice(0, DESKTOP_REFUSAL_MESSAGE_MAX_LENGTH) : '';
    const failed: ResumeAttempt = { phase: 'failed', message: refusalText.length > 0 ? refusalText : null };
    useResumeStore.getState().markFailed(taskId, failed.message);
    return failed;
  }
  watchResumeAttempt(taskId, startedAt, pausedSessionId);
  return { phase: 'resuming', startedAt };
}

/**
 * Follows one accepted resume on the task's board row until it settles. A
 * board-store subscription rather than a surface's effect, because the desktop
 * reports a failed spawn only by clearing its label, and nothing says a
 * surface is mounted then: the long-press sheet closes on accept, and the user
 * may be anywhere by the time the git phase ends.
 *
 * The wait bound is never spent on a resume while the desktop labels it: the
 * desktop is visibly working on it, so the bound re-arms instead, and the
 * label clearing is what settles it either way, however long the git phase
 * runs. A label that clears onto neither a bind nor a pause (the task left a
 * Resume column, or no cached board holds it any more) settles nothing on its
 * own, so the next bound fails it rather than leave the attempt and this
 * subscription waiting forever.
 */
function watchResumeAttempt(taskId: string, startedAt: number, pausedSessionId: string | null): void {
  let sawLabel = false;
  let unsubscribe: (() => void) | null = null;
  const stopWatching = (): void => {
    unsubscribe?.();
    unsubscribe = null;
  };
  const isCurrentAttempt = (): boolean => {
    const attempt = useResumeStore.getState().byTaskId[taskId];
    return attempt?.phase === 'resuming' && attempt.startedAt === startedAt;
  };
  const readProgress = (): void => {
    if (!isCurrentAttempt()) {
      stopWatching();
      return;
    }
    const progress = resumeProgress(selectTaskRow(useBoardStore.getState(), taskId), pausedSessionId, sawLabel);
    if (progress === 'labelled') {
      sawLabel = true;
    } else if (progress === 'bound') {
      stopWatching();
      useResumeStore.getState().clear(taskId);
    } else if (progress === 'spawn-failed') {
      stopWatching();
      useResumeStore.getState().markFailed(taskId, null);
    }
  };
  const checkWaitBound = (): void => {
    readProgress();
    if (!isCurrentAttempt()) return;
    const row = selectTaskRow(useBoardStore.getState(), taskId);
    if (row !== null && resumeProgress(row, pausedSessionId, sawLabel) === 'labelled') {
      setTimeout(checkWaitBound, RESUME_WAIT_MS);
      return;
    }
    stopWatching();
    useResumeStore.getState().markFailed(taskId, null);
  };
  unsubscribe = useBoardStore.subscribe(readProgress);
  readProgress();
  setTimeout(checkWaitBound, RESUME_WAIT_MS);
}

/**
 * How long the long-press sheet waits, from the tap, for the task's row to
 * read paused. It covers the verb's own 10 s timeout, after which the desktop
 * may still be waiting on the task lock (a long move can hold it), and the
 * agent shutdown that runs behind an accepted pause: about 3 s and past 10 s
 * at worst, per the desktop's own pause-session handler (read from its
 * source, not measured from the phone). The same
 * 20 s Resume gives its own settle (RESUME_WAIT_MS).
 */
export const PAUSE_WAIT_MS = 20_000;

/** What the desktop said to a pause. The paused row itself arrives later, as a board event. */
export type PauseRequestOutcome =
  | { kind: 'accepted' }
  /**
   * The verb timed out. The desktop takes the task lock before it pauses, so
   * the pause may still apply: the board is re-read, and the caller keeps
   * waiting on the row rather than reporting a failure.
   */
  | { kind: 'unconfirmed' }
  /** `message` is the desktop's own refusal text when it gave one, or null for the caller's generic line. */
  | { kind: 'refused'; message: string | null };

/**
 * The desktop task view's Pause, from the phone: pauses a task's LIVE session
 * by sending `pause-session` (protocol 0.18.0). Only ever called from a
 * surface gated on the row's `pausable`, the desktop's promise that the verb
 * takes its own Pause path: the conversation is kept for a later Resume, and
 * the pause sticks on a column with auto-spawn.
 *
 * The response means ACCEPTED, not paused: the agent's shutdown runs on behind
 * it, and the paused state reaches the phone as the task's next board row
 * (`paused: true`). A caller settles on that row, never on this promise.
 *
 * Every refusal re-reads the board. The desktop's usual one, "This task has no
 * running session to pause.", means the phone's view was stale, and the
 * re-read takes the Pause away from the row that should not have had it.
 */
export async function pauseTaskSession(taskId: string, projectId: string): Promise<PauseRequestOutcome> {
  try {
    await requireVerbClient().pauseSession({ taskId, projectId });
    return { kind: 'accepted' };
  } catch (error) {
    if (error instanceof CapabilityTimeoutError) {
      void refreshSnapshots().catch(() => undefined);
      return { kind: 'unconfirmed' };
    }
    if (error instanceof CapabilityError) {
      void refreshSnapshots().catch(() => undefined);
      const refusalText = error.message.trim().slice(0, DESKTOP_REFUSAL_MESSAGE_MAX_LENGTH);
      return { kind: 'refused', message: refusalText.length > 0 ? refusalText : null };
    }
    // Not connected, or the channel dropped mid-request: nothing reached the
    // desktop that it could still act on, so this one fails outright.
    return { kind: 'refused', message: null };
  }
}

/**
 * The one plain line a failed Command Terminal start shows, for the moment
 * the terminal's screen holds it before routing back (design change 4). Read
 * off the refusal's typed code, never parsed out of its text; where the
 * desktop has its own words for a refusal it names (an agent it cannot find,
 * a start that failed), those are shown, capped, as Resume and Pause show
 * theirs.
 */
export function commandTerminalStartFailureLine(error: unknown): string {
  if (error instanceof CapabilityTimeoutError) return "The desktop didn't answer.";
  if (error instanceof NotConnectedError || error instanceof ChannelDisconnectedError) return 'Not connected to the desktop.';
  if (!(error instanceof CapabilityError)) return "The desktop couldn't start it.";
  switch (error.code) {
    case COMMAND_TERMINAL_LIMIT_ERROR_CODE:
      // Another start (this phone's, or the desktop's own New) got there
      // first: the phone greys New out at four, so this is only ever a race.
      return 'This project already runs four.';
    case UNKNOWN_PROJECT_ERROR_CODE:
      return "The desktop doesn't have this project.";
    case UNSUPPORTED_VERB_ERROR_CODE:
      return "This desktop can't start terminals.";
    default: {
      const refusalText = error.message.trim().slice(0, DESKTOP_REFUSAL_MESSAGE_MAX_LENGTH);
      return refusalText.length > 0 ? refusalText : "The desktop couldn't start it.";
    }
  }
}

/**
 * Starts a Command Terminal in a project and returns its launch id at once
 * (protocol 0.20.0). The tap opens the terminal's screen straight away (design
 * change 4); the screen follows the launch in `useCommandTerminalStore`, which
 * outlives it, so leaving before the answer cannot lose the terminal or start
 * a second one on a remount.
 *
 * The predicted slot is the lowest one neither the board nor another start in
 * flight holds, for the screen's title until the answer carries the real one.
 * On success the session joins the wanted streams at once (the reconcile
 * reads the launch) and the board is re-read; the desktop's own
 * `command-terminals-changed` follows anyway. A timeout re-reads the board as
 * well, because the terminal may be running after all.
 */
export function launchCommandTerminal(projectId: string): string {
  const occupiedSlots = new Set<number>([
    ...selectCommandTerminals(useBoardStore.getState(), projectId).map((terminal) => terminal.slot),
    ...selectStartingSlots(useCommandTerminalStore.getState(), projectId),
  ]);
  const predictedSlot = lowestFreeCommandTerminalSlot(occupiedSlots) ?? COMMAND_TERMINAL_LIMIT;
  const launchId = useCommandTerminalStore.getState().beginLaunch(projectId, predictedSlot);
  void (async () => {
    try {
      const started = await requireVerbClient().startCommandTerminal(projectId);
      useCommandTerminalStore.getState().markLaunchStarted(launchId, started);
      const connection = getActiveConnection();
      if (connection !== null) {
        reconcileSessionsFromBoards(connection.subscriptions);
        connection.subscriptions.refreshBoard(projectId);
      }
    } catch (error) {
      useCommandTerminalStore.getState().markLaunchFailed(launchId, commandTerminalStartFailureLine(error));
      if (error instanceof CapabilityTimeoutError) getActiveConnection()?.subscriptions.refreshBoard(projectId);
    }
  })();
  return launchId;
}

/**
 * Stops a Command Terminal, the desktop Stop's own call, in one tap (design
 * change 3). The row reads "Stopping..." from the tap until the board drops
 * the terminal (the reconcile clears it then), not merely until the verb
 * answers. `unknown-session` means the terminal had already ended, which is
 * what was asked for. Any other failure marks the Stop failed, which brings
 * the row back with the sheet's failure line, and re-reads the board: a Stop
 * that timed out may still have landed.
 */
export async function stopCommandTerminal(sessionId: string): Promise<void> {
  const terminalStore = useCommandTerminalStore.getState();
  if (terminalStore.stopsBySessionId[sessionId] === 'stopping') return;
  terminalStore.markStopping(sessionId);
  const projectId = useActivityStore.getState().bySessionId[sessionId]?.projectId ?? null;
  try {
    await requireVerbClient().stopCommandTerminal(sessionId);
  } catch (error) {
    if (!(error instanceof CapabilityError && error.code === UNKNOWN_SESSION_ERROR_CODE)) {
      useCommandTerminalStore.getState().markStopFailed(sessionId);
      if (projectId !== null) getActiveConnection()?.subscriptions.refreshBoard(projectId);
      return;
    }
  }
  if (projectId !== null) getActiveConnection()?.subscriptions.refreshBoard(projectId);
}

export async function moveTaskOptimistic(input: {
  projectId: string;
  taskId: string;
  targetSwimlaneId: string;
  targetPosition: number;
}): Promise<void> {
  const moveId = useBoardStore.getState().applyOptimisticMove({
    projectId: input.projectId,
    taskId: input.taskId,
    toSwimlaneId: input.targetSwimlaneId,
    toPosition: input.targetPosition,
  });
  try {
    await requireVerbClient().moveTask({
      taskId: input.taskId,
      targetSwimlaneId: input.targetSwimlaneId,
      targetPosition: input.targetPosition,
      projectId: input.projectId,
    });
    if (moveId) useBoardStore.getState().commitMove(moveId);
    // Authoritative positions arrive via the BoardEvent-triggered snapshot refresh.
  } catch (error) {
    if (moveId) useBoardStore.getState().rollbackMove(moveId);
    throw error;
  }
}

export async function createTask(input: { projectId: string; title: string; description: string; column: string }): Promise<void> {
  // create_task resolves the column by NAME desktop-side ("Backlog" creates
  // a backlog item); the board feed push shows the new card.
  const params: JsonValue = {
    project: input.projectId,
    title: input.title,
    description: input.description,
    column: input.column,
  };
  await requireVerbClient().boardToolWrite('create_task', params);
}

/** Edits a task's title and/or description (board-tool-write update_task), optimistically applied. */
export async function updateTaskFields(input: {
  projectId: string;
  taskId: string;
  title?: string;
  description?: string;
}): Promise<void> {
  const editId = useBoardStore.getState().applyOptimisticTaskEdit(input);
  try {
    const params: JsonValue = {
      project: input.projectId,
      taskId: input.taskId,
      ...(input.title !== undefined ? { title: input.title } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
    };
    await requireVerbClient().boardToolWrite('update_task', params);
    if (editId) useBoardStore.getState().commitTaskEdit(editId);
  } catch (error) {
    if (editId) useBoardStore.getState().rollbackTaskEdit(editId);
    throw error;
  }
}

/** Deletes a task (board-tool-write delete_task; the desktop also kills its live session PTY), optimistically removed. */
export async function deleteTaskFromBoard(input: { projectId: string; taskId: string }): Promise<void> {
  const removalId = useBoardStore.getState().applyOptimisticRemoval(input);
  try {
    const params: JsonValue = { project: input.projectId, taskId: input.taskId };
    await requireVerbClient().boardToolWrite('delete_task', params);
    if (removalId) useBoardStore.getState().commitRemoval(removalId);
  } catch (error) {
    if (removalId) useBoardStore.getState().rollbackRemoval(removalId);
    throw error;
  }
}

/**
 * Archives a task the way the desktop does: a move into the board's
 * done-role column (archive is not a board-tool command; the desktop's
 * cross-column move handler owns the archive semantics). Throws when the
 * board has no done column.
 *
 * Matched on `role` alone, exactly as the desktop's own lookup does
 * (`task-archive.ts`: `swimlanes.list().find((l) => l.role === 'done')`).
 * A `!is_archived` guard here looks defensive but is fatal: the done lane
 * ships with `is_archived: 1` precisely BECAUSE it is the lane that archives
 * what lands in it, so the guard matched nothing and every archive threw.
 */
export async function archiveTask(input: { projectId: string; taskId: string }): Promise<void> {
  const board = useBoardStore.getState().boardsByProjectId[input.projectId];
  const doneColumn = board?.columns.find((column) => isDoneColumn(column) && !column.is_ghost);
  if (!doneColumn) throw new Error('This board has no Done column to archive into');
  await moveTaskOptimistic({
    projectId: input.projectId,
    taskId: input.taskId,
    targetSwimlaneId: doneColumn.id,
    targetPosition: 0,
  });
}

/** Page size for the Done column. One screenful plus headroom, so the common board needs a single round trip. */
export const ARCHIVED_PAGE_SIZE = 25;

/**
 * Loads a page of a project's completed tasks into the board store.
 *
 * One-shot by design: completed work is not part of either board projection,
 * and subscribing to it would re-send an ever-growing list on every board
 * change. `append: false` refreshes from the top, `true` pages further back.
 */
export async function loadArchivedTasks(input: { projectId: string; append?: boolean }): Promise<void> {
  const append = input.append ?? false;
  const board = useBoardStore.getState();
  const alreadyHeld = board.archivedByProjectId[input.projectId];
  if (alreadyHeld?.loading) return;
  // Paging past the end is a no-op rather than a wasted round trip. Measured
  // against the fetch cursor, not the held rows: those two diverge whenever a
  // page arrives carrying a row already held, and a full archive would then
  // never satisfy this guard.
  if (append && alreadyHeld && alreadyHeld.nextOffset >= alreadyHeld.totalCount) return;

  board.setArchivedLoading(input.projectId, true);
  try {
    const page = await requireVerbClient().readBoardArchived(input.projectId, {
      limit: ARCHIVED_PAGE_SIZE,
      offset: append ? (alreadyHeld?.nextOffset ?? 0) : 0,
    });
    useBoardStore.getState().applyArchivedPage(page, { append });
  } catch (error) {
    useBoardStore.getState().setArchivedLoading(input.projectId, false);
    throw error;
  }
}

/**
 * Sets the Changes tab's live diff watch (scope changes re-subscribe); pass
 * null on blur. The target is a task's worktree, or the project folder for a
 * Command Terminal (`taskId: null`).
 */
export function setDiffWatch(target: DiffTarget, scope: ReadDiffScope | null): void {
  const connection = getActiveConnection();
  if (!connection) return;
  const diffKey = diffKeyFor(target);
  if (scope !== null) {
    useDiffStore.getState().setStatus(diffKey, scope, 'loading');
    connection.subscriptions.setDesiredDiff(diffKey, { taskId: target.taskId, projectId: target.projectId, scope });
  } else {
    connection.subscriptions.setDesiredDiff(diffKey, null);
    useDiffStore.getState().clearKey(diffKey);
  }
}

export async function fetchDiffFileContent(input: DiffTarget & { filePath: string; scope: ReadDiffScope }): Promise<void> {
  const diffKey = diffKeyFor(input);
  const cached = useDiffStore.getState().byKey[diffKey]?.contentByPath[input.filePath];
  if (cached) return;
  const content = await requireVerbClient().readDiffFileContent(input);
  useDiffStore.getState().applyFileContent(diffKey, input.filePath, content);
}

/** Initial window size on screen open - enough to fill the list a few screens deep; older pages load on scroll-up. */
const TRANSCRIPT_INITIAL_WINDOW = 60;
const TRANSCRIPT_PAGE_SIZE = 60;

/**
 * Fetches the newest transcript window for a retained session - the
 * screen-open bootstrap and the self-heal path whenever the store flags
 * `needsTailFetch` (reset signal, delta gap, delta before any window).
 */
const tailFetchesInFlight = new Map<string, Promise<void>>();

export async function loadTranscriptTail(sessionId: string): Promise<void> {
  // openSessionScreen fires one of these, and the screen's needsTailFetch
  // self-heal effect mounts while it is still in flight and fires a second.
  // Both resolved with the same window and each applied it wholesale, so the
  // feed's cell identity was replaced twice mid-layout for no gain.
  const inFlight = tailFetchesInFlight.get(sessionId);
  if (inFlight !== undefined) return inFlight;
  const fetch = (async () => {
    const window = await requireVerbClient().readTranscriptWindow(sessionId, { limit: TRANSCRIPT_INITIAL_WINDOW });
    useTranscriptStore.getState().applyWindow(sessionId, window);
  })();
  const tracked = fetch.finally(() => {
    tailFetchesInFlight.delete(sessionId);
  });
  tailFetchesInFlight.set(sessionId, tracked);
  return tracked;
}

/** Scroll-up pagination: prepends the next older window above the current one. */
export async function loadOlderTranscript(sessionId: string): Promise<void> {
  const session = useTranscriptStore.getState().bySessionId[sessionId];
  if (!session || session.startIndex === 0) return;
  const window = await requireVerbClient().readTranscriptWindow(sessionId, {
    beforeIndex: session.startIndex,
    limit: TRANSCRIPT_PAGE_SIZE,
  });
  useTranscriptStore.getState().applyWindow(sessionId, window);
}

/**
 * A task screen opened a session: retain its transcript + terminal buffers,
 * re-subscribe the stream so fresh scrollback (and delta flow) resume even
 * though payloads were being dropped while unwatched, and fetch the newest
 * transcript window (the desktop never pushes whole transcripts).
 */
export function openSessionScreen(sessionId: string): void {
  useTranscriptStore.getState().retainSession(sessionId);
  // This is the only screen that renders PTY bytes, so it is the only place
  // that asks for them, and the retention IS the ask: every SubscriptionManager
  // reads it at subscribe time (isTerminalWanted). Recorded BEFORE any
  // connection is consulted, because there may not be one yet: on a
  // cold-launch notification tap this runs ahead of the first connection,
  // which then subscribes this session with live PTY bytes on its own.
  retainTerminal(sessionId);
  useActivityStore.getState().markRead(sessionId);
  const connection = getActiveConnection();
  traceConnection('session-open', {
    hasConnection: connection !== null,
    established: useChannelStore.getState().established,
  });
  // One re-subscribe, and that IS the fetch of the fresh scrollback the
  // terminal seeds itself from, now carrying terminal: true.
  connection?.subscriptions.refreshStream(sessionId);
  void loadTranscriptTail(sessionId).catch(() => {
    // Not connected yet or a transient failure: the store keeps
    // needsTailFetch set, and the screen retries when it sees the flag.
  });
}

/**
 * The Board tab is looking at a project: upgrade that board to the full
 * projection. Every other board stays on the feed projection, which carries
 * only the tasks an agent is actually running.
 */
export function openProjectBoard(projectId: string): void {
  getActiveConnection()?.subscriptions.setBoardWantsFull(projectId);
}

export function closeSessionScreen(sessionId: string): void {
  // Transcript retention is LRU-capped rather than released on close, so
  // backing out and returning is instant; the terminal ring is released
  // (raw PTY bytes are the heavy part) - but only by the LAST screen holding
  // it. A second screen on the same session (one buried under a sheet, then
  // a notification tap for that task) used to delete the survivor's ring and
  // switch the desktop to list-only here, leaving the survivor's mirror with
  // no bytes and nothing to repaint from until it remounted.
  if (releaseTerminal(sessionId)) {
    // Stop the desktop SENDING those bytes too: the re-subscribe reads the
    // released retention and goes list-only. Releasing the ring only stops
    // us keeping them; the relay would still carry every one.
    getActiveConnection()?.subscriptions.refreshStream(sessionId);
  }
  useActivityStore.getState().markRead(sessionId);
}

/** How many newest transcript entries a prompt peek scans; the awaited tool_use is almost always in the last one. */
const PROMPT_PEEK_WINDOW = 12;
const PROMPT_PEEK_CACHE_CAP = 100;
const awaitedPromptPeekCache = new Map<string, AwaitedToolUse | null>();

/**
 * One-shot lookup of the awaited prompt's tool_use for a session the Home
 * feed is NOT retaining a transcript for: fetches a small newest window
 * directly (no store writes) and caches by promptId so a list re-render
 * never refetches. The needs-you card renders a generic Approve/Deny
 * immediately (answering needs only the promptId) and upgrades when this
 * resolves.
 */
export async function peekAwaitedPrompt(sessionId: string, awaitedPromptId: string): Promise<AwaitedToolUse | null> {
  const cached = awaitedPromptPeekCache.get(awaitedPromptId);
  if (cached !== undefined) return cached;
  const transcriptWindow = await requireVerbClient().readTranscriptWindow(sessionId, { limit: PROMPT_PEEK_WINDOW });
  const awaitedToolUse = findAwaitedToolUse(transcriptWindow.entries, sessionId, awaitedPromptId);
  if (awaitedPromptPeekCache.size >= PROMPT_PEEK_CACHE_CAP) awaitedPromptPeekCache.clear();
  awaitedPromptPeekCache.set(awaitedPromptId, awaitedToolUse);
  return awaitedToolUse;
}

/**
 * The message peek scans fewer entries than the prompt peek: the last
 * assistant text is nearly always within the newest few, and window
 * entries are heavy (full tool inputs and results ride along).
 */
const MESSAGE_PEEK_WINDOW = 8;

interface SnippetPeekRecord {
  fetchedAtMs: number;
  text: string | null;
}

const lastMessagePeekBySession = new Map<string, SnippetPeekRecord>();
const inFlightMessagePeeks = new Map<string, Promise<string | null>>();

/**
 * Inbox snippet for an Agents-feed row: the last assistant text from a
 * session the feed is NOT retaining a transcript for. THROTTLED per
 * session: an actively-working session bumps its unread counter on every
 * engine event, and a long-lived session's transcript window can run to
 * megabytes, so the caller passes `minFreshnessMs` - a result younger
 * than that is returned without a wire fetch (pass 0 to force fresh, the
 * idle-row case where the final message just landed). Concurrent calls
 * share one in-flight fetch.
 */
export async function peekLastAssistantMessage(sessionId: string, minFreshnessMs: number): Promise<string | null> {
  // A session the user has opened is RETAINED, and its transcript deltas
  // already stream into transcriptStore live. Read the newest message from
  // there: free, no wire round trip, and always current - the throttled
  // fetch below could otherwise show text up to minFreshnessMs old while
  // the agent was visibly producing newer messages.
  //
  // Unless the store knows it fell behind: a delta that arrived with a gap
  // leaves `entries` deliberately stale and sets needsTailFetch, and only a
  // mounted chat screen re-fetches. For a retained-but-unmounted session that
  // stale text would otherwise be pinned on the feed indefinitely, so fall
  // through to the wire fetch instead.
  const localSession = useTranscriptStore.getState().bySessionId[sessionId];
  if (localSession !== undefined && !localSession.needsTailFetch && localSession.entries.length > 0) {
    const localSnippet = lastAssistantText(localSession.entries);
    if (localSnippet !== null) return localSnippet;
  }
  const record = lastMessagePeekBySession.get(sessionId);
  if (record !== undefined && minFreshnessMs > 0 && Date.now() - record.fetchedAtMs < minFreshnessMs) {
    return record.text;
  }
  const inFlight = inFlightMessagePeeks.get(sessionId);
  if (inFlight !== undefined) return inFlight;
  const fetchPromise = (async () => {
    const transcriptWindow = await requireVerbClient().readTranscriptWindow(sessionId, { limit: MESSAGE_PEEK_WINDOW });
    const snippet = lastAssistantText(transcriptWindow.entries);
    if (lastMessagePeekBySession.size >= PROMPT_PEEK_CACHE_CAP) lastMessagePeekBySession.clear();
    lastMessagePeekBySession.set(sessionId, { fetchedAtMs: Date.now(), text: snippet });
    return snippet;
  })();
  inFlightMessagePeeks.set(sessionId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightMessagePeeks.delete(sessionId);
  }
}

const TERMINAL_LINE_SNIPPET_MAX_LENGTH = 200;

const lastTerminalLinePeekBySession = new Map<string, SnippetPeekRecord>();
const inFlightTerminalLinePeeks = new Map<string, Promise<string | null>>();

/**
 * Snippet fallback for TRANSCRIPT-LESS sessions (codex-style agents): the
 * last readable line of the session's PTY scrollback, from a fresh
 * read-stream snapshot (re-subscribe is replace semantics desktop-side,
 * so this never duplicates the feed). Skipped while the session screen
 * retains the terminal - that surface owns the live feed. Throttled per
 * session exactly like peekLastAssistantMessage.
 *
 * This is the ONE place outside a session screen that has to ask for PTY
 * bytes: the scrollback IS the snippet, and a list-only subscribe returns an
 * empty one. Because the desktop's subscribe replaces whatever that session
 * was subscribed with, the one-shot leaves PTY streaming armed for a session
 * showing no terminal - the exact ~13MB/hour cost the `terminal` flag exists
 * to remove - so it is put straight back to list-only afterwards.
 */
export async function peekLastTerminalLine(sessionId: string, minFreshnessMs: number): Promise<string | null> {
  if (isTerminalRetained(sessionId)) return null;
  const record = lastTerminalLinePeekBySession.get(sessionId);
  if (record !== undefined && minFreshnessMs > 0 && Date.now() - record.fetchedAtMs < minFreshnessMs) {
    return record.text;
  }
  const inFlight = inFlightTerminalLinePeeks.get(sessionId);
  if (inFlight !== undefined) return inFlight;
  const fetchPromise = (async () => {
    const snapshot = await requireVerbClient().readStreamSubscribe(sessionId, { terminal: true });
    // Put the subscription straight back to list-only. The desktop replaces a
    // session's subscription on every subscribe, so without this the one-shot
    // above leaves PTY bytes streaming to a feed row that discards them.
    getActiveConnection()?.subscriptions.refreshStream(sessionId);
    // Content, not chrome: skip status/spinner lines and context bars so
    // the snippet reads like the agent's most recent message, and collapse
    // decoration so a separator run never renders as literal lines.
    const contentLine = lastContentLineFromScrollback(snapshot.scrollback);
    const collapsedLine = contentLine !== null ? collapseToSnippetText(contentLine) : '';
    const snippet = collapsedLine.length > 0 ? collapsedLine.slice(0, TERMINAL_LINE_SNIPPET_MAX_LENGTH) : null;
    if (lastTerminalLinePeekBySession.size >= PROMPT_PEEK_CACHE_CAP) lastTerminalLinePeekBySession.clear();
    lastTerminalLinePeekBySession.set(sessionId, { fetchedAtMs: Date.now(), text: snippet });
    return snippet;
  })();
  inFlightTerminalLinePeeks.set(sessionId, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    inFlightTerminalLinePeeks.delete(sessionId);
  }
}

/**
 * Re-subscribe one session's stream for a fresh serialized frame (replace
 * semantics desktop-side). The terminal refit button's "unstick" half: a
 * mirror wedged by a missed resize or a corrupted seed re-seeds from truth.
 */
export function refreshTerminalStream(sessionId: string): void {
  getActiveConnection()?.subscriptions.refreshStream(sessionId);
}

/**
 * Clear EVERYTHING the phone holds from the paired desktop: board, activity,
 * transcripts, diffs, terminal ring buffers, the cleaned reading view, the
 * module-level peek caches (prompt options, message and terminal-line
 * snippets), and settings keyed by the old desktop's own task IDs. Unpairing
 * revokes trust; content fetched under that trust must not outlive it on an
 * unlocked phone, so the unpair and pairing-completion paths call this right
 * before reconnectNow(). In-flight peeks need no cancellation - the
 * connection they ride is being torn down, so they reject and cache nothing.
 */
export function wipeDesktopContent(): void {
  useBoardStore.getState().reset();
  useActivityStore.getState().reset();
  useTranscriptStore.getState().reset();
  useDiffStore.getState().reset();
  useReadingViewStore.getState().reset();
  useCommandTerminalStore.getState().reset();
  resetTerminalFeed();
  awaitedPromptPeekCache.clear();
  lastMessagePeekBySession.clear();
  lastTerminalLinePeekBySession.clear();
  // Fire-and-forget like openSessionScreen's tail fetch: the in-memory clear
  // above already ran synchronously; this only persists the empty map. A
  // rejected write leaves a stale, non-secret lens map that the next lens
  // pick or wipe overwrites, so the failure is safe to swallow.
  void useSettingsStore.getState().clearDesktopScopedPreferences().catch(() => {});
}

/**
 * The local half of unpairing, shared by both ways a pairing ends: the
 * user's own Unpair button (DevicesScreen, 'announce-departure') and a
 * desktop-side revoke arriving as the session's Final frame
 * (connectionManager's revocation handler, 'stay-silent' - the desktop
 * already knows). Clears the trust anchor, wipes everything fetched under
 * it, and swaps the connection so the reopen lands on the unpaired path.
 * The push unregister stays with the callers - only a local unpair still
 * has a channel to send it over - and navigation is the caller's concern.
 *
 * The clear goes first (a reconnect before it would redial the old
 * desktop), but the wipe and the teardown must not hinge on it: a locked
 * Keystore rejecting the delete still rethrows to the caller's error
 * surface, while the finally guarantees no content fetched under the old
 * trust outlives the unpair and no stale channel keeps running. A stale
 * anchor is the recoverable half - Devices still offers a retry - whereas
 * un-wiped content on a remotely revoked phone is not.
 */
export async function unpairLocally(intent: ConnectionTeardownIntent): Promise<void> {
  try {
    // Lazy on purpose: many unit suites import actions.ts while mocking
    // connectionManager but not expo-secure-store, and trustAnchor.ts reads
    // the keychain-accessibility constant at module scope - a static import
    // here would force every one of those suites to stub it.
    const { TrustAnchorStore } = await import('@/pairing/trustAnchor');
    await new TrustAnchorStore().clear();
  } finally {
    wipeDesktopContent();
    reconnectNow(intent);
  }
}

/** Pull-to-refresh: re-run the bootstrap (re-subscribes replace desktop-side, so this is snapshot refresh everywhere). */
export async function refreshSnapshots(): Promise<void> {
  const connection = getActiveConnection();
  if (!connection || !connection.controller.session.isEstablished) return;
  await runBootstrap(connection.verbs, requireSubscriptions());
}
