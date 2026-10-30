import React, { useCallback, useMemo } from 'react';
import { useRouter } from 'expo-router';
import type { BoardColumnWire, BoardTaskWire } from '@kangentic/protocol';
import { agentStatusKindFor, type AgentStatusKind } from '@/components';
import { collapseToSnippetText } from '@/conversation/pendingPromptSummary';
import { TaskCard } from '@/components/board/TaskCard';
import { cardSessionDisplay, toCardSession } from '@/components/board/cardSessionDisplay';
import { buildJourneyTrack } from '@/components/board/columnTrack';
import { sessionlessTaskStatus, useBoardStore } from '@/state/boardStore';
import { useActivityStore, selectTaskRespawn, selectWaitingSince } from '@/state/activityStore';
import { workflowStripLabel } from '@/workflow/workflowState';
import { workflowWaitingFooter } from '@/workflow/workflowWaiting';

const CARD_DESCRIPTION_LINES = 2;

/** A stable empty column list, so a board that has not loaded hands the track no new array each render. */
const NO_COLUMNS: readonly BoardColumnWire[] = [];

/**
 * Where a tap on a board card goes, shared by the Board and the workflow view
 * so a task opens the same way from both.
 *
 * Desktop parity (TaskCard.handleClick): a task with no session on it opens
 * straight into the edit form. Keyed on the session, not the column, because
 * that is what the desktop keys on - a task parked in Testing with no agent is
 * as sessionless as one in To Do, and a column check would send it to an empty
 * session shell. Moving to To Do hard-resets a task (the desktop kills the
 * session, worktree and branch), so that column can never have one.
 *
 * "No session" means what the DESKTOP means by it, which is not quite a null
 * `session_id`: a paused task keeps its suspended session in the desktop's
 * registry after a pause clears the pointer, and a first start has a spawn in
 * flight before it has an id. Both open the desktop's task detail (its Resume
 * button, its launch overlay), so both open the session screen here, told
 * apart by the board row's own protocol 0.16.0 fields (sessionlessTaskStatus).
 */
export function useOpenBoardTask(task: BoardTaskWire, projectId: string): () => void {
  const router = useRouter();
  const sessionlessStatus = sessionlessTaskStatus(task);
  return useCallback(() => {
    // Checked before the session test, not after: an archived task ALWAYS has
    // a null session_id (the move to Done suspends the agent and clears it),
    // so the sessionless branch would otherwise swallow every completed task
    // and offer to edit finished work instead of showing what it did.
    if (task.archived_at !== null) {
      router.push({ pathname: '/completed-task', params: { taskId: task.id, projectId } });
      return;
    }
    if (task.session_id === null) {
      if (sessionlessStatus !== null) {
        router.push({ pathname: '/task/[taskId]', params: { taskId: task.id, projectId } });
        return;
      }
      router.push({ pathname: '/edit-task', params: { taskId: task.id, projectId } });
      return;
    }
    router.push({
      pathname: '/task/[taskId]',
      params: { taskId: task.id, sessionId: task.session_id, projectId },
    });
  }, [router, task.id, task.session_id, task.archived_at, sessionlessStatus, projectId]);
}

/**
 * The board's per-item connector: reads the session's activity/usage and the
 * project's ticket-number setting, then hands off to the shared TaskCard
 * (@/components/board/TaskCard) - the exact same card the Agents feed renders.
 *
 * Two variants of its top band (protocol 0.21.0, design screens 1 and 7):
 *
 * - `board`: no band for an ordinary task, since the board already says which
 *   project and column. A workflow task gets the desktop board strip: its
 *   workflow, and its route.
 * - `canvas`: the workflow view's card, the desktop canvas's own: every card
 *   names its project (a workflow can span boards), its route, and how long it
 *   has waited on you. Its body is the agent's last line while a session runs,
 *   as on the Agents feed, and nothing otherwise.
 *
 * A workflow task waiting in To Do also gets the desktop's waiting footer
 * ("Paused" for a held one with nothing to wait for), and a task whose column
 * automations are paused (protocol 0.22.0) gets the desktop's "Automations
 * paused" strip across the top, above the band when the card has one: a held
 * workflow card stacks it over its workflow strip (protocol 0.25.0, kangentic
 * #923).
 */
export const BoardTaskCard = React.memo(function BoardTaskCard({
  task,
  projectId,
  onLongPressTask,
  variant = 'board',
  testID,
}: {
  task: BoardTaskWire;
  projectId: string;
  onLongPressTask: (task: BoardTaskWire, projectId: string) => void;
  variant?: 'board' | 'canvas';
  testID?: string;
}): React.JSX.Element {
  // Built here rather than per-row in renderItem: the parent hands down one
  // stable callback, so this card's props stay identical between renders.
  const onLongPress = useCallback(() => onLongPressTask(task, projectId), [onLongPressTask, task, projectId]);
  const openTask = useOpenBoardTask(task, projectId);
  const activityEntry = useActivityStore((state) => (task.session_id ? (state.bySessionId[task.session_id] ?? null) : null));
  const showTicketNumbers = useBoardStore((state) => state.boardsByProjectId[projectId]?.showTicketNumbers ?? true);
  const boardColumns = useBoardStore((state) => state.boardsByProjectId[projectId]?.columns ?? NO_COLUMNS);
  const projectName = useBoardStore((state) => state.projects.find((project) => project.id === projectId)?.name ?? null);

  // Task-keyed, not session-keyed, and that is the entire point: during a
  // swap the task's session_id is null, so `activityEntry` above is null and
  // this card used to show nothing at all for the several seconds the desktop
  // was handing the work to a new agent. Now it shows the desktop's step in
  // the footer, as the desktop card does (cardSessionDisplay).
  const respawn = useActivityStore((state) => selectTaskRespawn(state, task.id));
  const sessionDisplay = cardSessionDisplay({ session: toCardSession(activityEntry), respawn, task });

  // Desktop TaskCard parity: spinner while thinking, the bubble or the shield
  // while the session waits on the user, the envelope for a finished turn
  // (agentStatusKindFor), and no icon for a session that is not running
  // (queued, paused, mid-respawn, ended): its footer says which. A queued
  // session reports idle (no PTY, so it never thinks), so `sessionStatus`, not
  // the activity state, is what keeps it from wearing the envelope.
  const statusKind: AgentStatusKind | null =
    activityEntry !== null && sessionDisplay.kind === 'running'
      ? agentStatusKindFor(activityEntry.state, activityEntry.reason, activityEntry.unreadCount > 0)
      : null;
  const descriptionPreview = task.description.length > 0 ? collapseToSnippetText(task.description) : '';
  const running = sessionDisplay.kind === 'running';
  const bodyText =
    variant === 'canvas' ? (running ? (activityEntry?.messagePreview ?? descriptionPreview) : '') : descriptionPreview;

  const column = useMemo(
    () => boardColumns.find((candidate) => candidate.id === task.swimlane_id) ?? null,
    [boardColumns, task.swimlane_id],
  );
  const workflow = task.workflow ?? null;
  const held = task.automations_disabled === true;
  const waiting = useMemo(() => workflowWaitingFooter(workflow, column?.role ?? null, held), [workflow, column, held]);
  const waitingSinceMs = variant === 'canvas' && activityEntry !== null && running ? selectWaitingSince(activityEntry) : null;
  const columnStrip = useMemo(() => {
    if (variant === 'board' && workflow === null) return undefined;
    return {
      column,
      track: buildJourneyTrack(boardColumns, task.swimlane_id, workflow?.route ?? null),
      projectName: variant === 'canvas' ? projectName : null,
      workflow: variant === 'board' ? workflowStripLabel(workflow) : null,
      waitingSinceMs,
    };
  }, [variant, workflow, column, boardColumns, task.swimlane_id, projectName, waitingSinceMs]);

  return (
    <TaskCard
      testID={testID ?? `board-card-${task.id}`}
      task={task}
      statusKind={statusKind}
      showTicketNumbers={showTicketNumbers}
      sessionDisplay={sessionDisplay}
      usage={activityEntry?.usage ?? null}
      bodyText={bodyText}
      bodyNumberOfLines={CARD_DESCRIPTION_LINES}
      columnStrip={columnStrip}
      waiting={waiting}
      automationsDisabled={task.automations_disabled === true}
      onPress={openTask}
      onLongPress={onLongPress}
    />
  );
});
