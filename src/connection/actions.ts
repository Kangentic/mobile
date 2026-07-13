import type { JsonValue, ReadDiffScope } from '@kangentic/protocol';
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

/**
 * A task screen opened a session: retain its transcript + terminal buffers
 * and re-subscribe the stream so fresh scrollback (and, desktop-side, a
 * fresh transcript seed) arrive even though terminal payloads were being
 * dropped while unwatched.
 */
export function openSessionScreen(sessionId: string): void {
  useTranscriptStore.getState().retainSession(sessionId);
  retainTerminal(sessionId);
  useActivityStore.getState().markRead(sessionId);
  const connection = getActiveConnection();
  connection?.subscriptions.refreshStream(sessionId);
}

export function closeSessionScreen(sessionId: string): void {
  // Transcript retention is LRU-capped rather than released on close, so
  // backing out and returning is instant; the terminal ring is released
  // (raw PTY bytes are the heavy part).
  releaseTerminal(sessionId);
  useActivityStore.getState().markRead(sessionId);
}

/** Pull-to-refresh: re-run the bootstrap (re-subscribes replace desktop-side, so this is snapshot refresh everywhere). */
export async function refreshSnapshots(): Promise<void> {
  const connection = getActiveConnection();
  if (!connection || !connection.controller.session.isEstablished) return;
  await runBootstrap(connection.verbs, requireSubscriptions());
}
