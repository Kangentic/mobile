import type { JsonValue, ReadDiffScope } from '@kangentic/protocol';
import { findAwaitedToolUse, type AwaitedToolUse } from '@/conversation/pendingPromptSummary';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useDiffStore } from '@/state/diffStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { releaseTerminal, retainTerminal } from '@/state/terminalFeed';
import { getActiveConnection, requireSubscriptions, requireVerbClient } from './connectionManager';
import { runBootstrap } from './bootstrap';

/**
 * The imperative API screens call - they never touch VerbClient or
 * SubscriptionManager directly. Everything here throws NotConnectedError
 * (or CapabilityError) for the caller's inline error state.
 */

export async function sendUserMessage(sessionId: string, text: string): Promise<void> {
  await requireVerbClient().sendUserMessage(sessionId, text);
}

export async function answerPermissionPrompt(sessionId: string, promptId: string, keystrokes: string): Promise<void> {
  await requireVerbClient().answerPermissionPrompt({ sessionId, promptId, keystrokes });
}

export async function writeTerminal(sessionId: string, data: string): Promise<void> {
  await requireVerbClient().writeInteractiveTerminal(sessionId, data);
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
 */
export async function archiveTask(input: { projectId: string; taskId: string }): Promise<void> {
  const board = useBoardStore.getState().boardsByProjectId[input.projectId];
  const doneColumn = board?.columns.find(
    (column) => column.role === 'done' && !column.is_archived && !column.is_ghost,
  );
  if (!doneColumn) throw new Error('This board has no Done column to archive into');
  await moveTaskOptimistic({
    projectId: input.projectId,
    taskId: input.taskId,
    targetSwimlaneId: doneColumn.id,
    targetPosition: 0,
  });
}

/** Sets the Changes tab's live diff watch (scope changes re-subscribe); pass null on blur. */
export function setDiffWatch(taskId: string, input: { projectId: string; scope: ReadDiffScope } | null): void {
  const connection = getActiveConnection();
  if (!connection) return;
  if (input) {
    useDiffStore.getState().setStatus(taskId, input.scope, 'loading');
    connection.subscriptions.setDesiredDiff(taskId, input);
  } else {
    connection.subscriptions.setDesiredDiff(taskId, null);
    useDiffStore.getState().clearTask(taskId);
  }
}

export async function fetchDiffFileContent(input: {
  taskId: string;
  projectId: string;
  filePath: string;
  scope: ReadDiffScope;
}): Promise<void> {
  const cached = useDiffStore.getState().byTaskId[input.taskId]?.contentByPath[input.filePath];
  if (cached) return;
  const content = await requireVerbClient().readDiffFileContent(input);
  useDiffStore.getState().applyFileContent(input.taskId, input.filePath, content);
}

/** Initial window size on screen open - enough to fill the list a few screens deep; older pages load on scroll-up. */
const TRANSCRIPT_INITIAL_WINDOW = 60;
const TRANSCRIPT_PAGE_SIZE = 60;

/**
 * Fetches the newest transcript window for a retained session - the
 * screen-open bootstrap and the self-heal path whenever the store flags
 * `needsTailFetch` (reset signal, delta gap, delta before any window).
 */
export async function loadTranscriptTail(sessionId: string): Promise<void> {
  const window = await requireVerbClient().readTranscriptWindow(sessionId, { limit: TRANSCRIPT_INITIAL_WINDOW });
  useTranscriptStore.getState().applyWindow(sessionId, window);
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
  retainTerminal(sessionId);
  useActivityStore.getState().markRead(sessionId);
  const connection = getActiveConnection();
  connection?.subscriptions.refreshStream(sessionId);
  void loadTranscriptTail(sessionId).catch(() => {
    // Not connected yet or a transient failure: the store keeps
    // needsTailFetch set, and the screen retries when it sees the flag.
  });
}

export function closeSessionScreen(sessionId: string): void {
  // Transcript retention is LRU-capped rather than released on close, so
  // backing out and returning is instant; the terminal ring is released
  // (raw PTY bytes are the heavy part).
  releaseTerminal(sessionId);
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

/** Pull-to-refresh: re-run the bootstrap (re-subscribes replace desktop-side, so this is snapshot refresh everywhere). */
export async function refreshSnapshots(): Promise<void> {
  const connection = getActiveConnection();
  if (!connection || !connection.controller.session.isEstablished) return;
  await runBootstrap(connection.verbs, requireSubscriptions());
}
