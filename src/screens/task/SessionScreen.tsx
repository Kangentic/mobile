import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { KeyboardAvoidingView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import PagerView from 'react-native-pager-view';
import { MoveTaskSheet } from '@/components/board/MoveTaskSheet';
import { Screen } from '@/components';
import { findTaskById, selectColumnsOrdered, selectColumnTaskCount, useBoardStore } from '@/state/boardStore';
import { selectSessionEnded, useActivityStore } from '@/state/activityStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { useTerminalUiStore } from '@/state/terminalUiStore';
import { CapabilityError } from '@/channel';
import { closeSessionScreen, moveTaskOptimistic, openSessionScreen } from '@/connection/actions';
import { triggerHaptic } from '@/lib/haptics';
import { TaskHeader } from './TaskHeader';
import { ChatPane } from './ChatPane';
import { ChangesTab } from './ChangesTab';
import { TerminalTab } from './TerminalTab';
import { SessionEndedState } from './SessionEndedState';
import { SessionInputBar } from './SessionInputBar';
import { ModeToggleHint } from './ModeToggleHint';
import { resolveCurrentSessionId } from './sessionResolution';
import type { SessionMode } from './SessionModeToggle';

const MODE_PAGE_INDEX: Record<SessionMode, number> = { terminal: 0, chat: 1, changes: 2 };

/**
 * How long a 'rejected' stream feed must persist before the screen declares
 * the session dead. A respawn races the board snapshot against the old
 * stream's rejection; the grace window keeps the ended state from flashing
 * when the successor sessionId is about to arrive.
 */
const REJECTED_FEED_GRACE_MS = 1500;

/**
 * The task's SESSION view: one live session, three surfaces. Terminal (the
 * raw 1:1 desktop mirror, the default), Chat (the readable feed), and
 * Changes (the diff) share a non-swipe pager - all stay mounted so the
 * xterm WebView never reloads and the conversation keeps scroll position;
 * switching is tap-only via the mode pill in the footer (swipe belongs to
 * the terminal's pan). The footer is mode-aware: quick keys + dictation in
 * Terminal (typing happens directly in the terminal - tap it for the
 * keyboard), the composer in Chat, nothing extra in Changes.
 */
export function SessionScreen(): React.JSX.Element {
  const params = useLocalSearchParams<{ taskId: string; sessionId?: string; projectId?: string; mode?: string }>();
  const taskId = params.taskId;

  // Select primitives, never the object findTaskById builds: returning a
  // fresh { task, projectId } from a Zustand selector changes identity every
  // render and drives useSyncExternalStore into an infinite re-render loop.
  const locatedTaskTitle = useBoardStore((state) => findTaskById(state, taskId)?.task.title ?? null);
  const locatedDisplayId = useBoardStore((state) => {
    const located = findTaskById(state, taskId);
    if (!located) return null;
    return (state.boardsByProjectId[located.projectId]?.showTicketNumbers ?? true) ? located.task.display_id : null;
  });
  const locatedProjectId = useBoardStore((state) => findTaskById(state, taskId)?.projectId ?? null);
  const locatedSessionId = useBoardStore((state) => findTaskById(state, taskId)?.task.session_id ?? null);
  const taskLocated = useBoardStore((state) => findTaskById(state, taskId) !== null);
  const taskTitle = locatedTaskTitle ?? 'Task';
  const projectId = params.projectId && params.projectId.length > 0 ? params.projectId : locatedProjectId;
  const paramSessionId = params.sessionId && params.sessionId.length > 0 ? params.sessionId : null;
  // The board is authoritative once it has located the task (a respawn swaps
  // the task's session_id under a mounted screen); the param only bridges the
  // gap before the first board snapshot. See sessionResolution.ts.
  const sessionId = resolveCurrentSessionId({ taskLocated, locatedSessionId, paramSessionId });

  // Mode priority: an explicit route param (needs-you rows land on chat)
  // beats the task's remembered lens beats the terminal default. The
  // remembered lens is read once at mount - later store writes must not
  // yank the surface the user is looking at.
  const [mode, setMode] = useState<SessionMode>(() => {
    if (params.mode === 'chat' || params.mode === 'changes') return params.mode;
    return useSettingsStore.getState().preferredSessionLensByTaskId[taskId] ?? 'terminal';
  });
  const pagerRef = useRef<PagerView>(null);

  useEffect(() => {
    if (!sessionId) return;
    openSessionScreen(sessionId);
    return () => closeSessionScreen(sessionId);
  }, [sessionId]);

  // SESSION-DEATH DETECTION. Three signals, all scoped to the CURRENT binding:
  // 1. The board located the task but reports no session, after this screen
  //    had one: the session ended with no successor (authoritative). Only
  //    fires for a board fetched as `view: 'full'` - the 'sessions' projection
  //    drops such a task rather than reporting it with a null session_id.
  // 2. The desktop pushed `session-ended` for the bound session (see below).
  // 3. The stream feed for the bound session sits 'rejected' past a grace
  //    window: the desktop refused the subscribe (dead session on a desktop
  //    that predates the session-ended event) and no successor arrived.
  // "Had one before" is state adjusted during render (the sanctioned
  // derive-from-props pattern), not a ref read in render.
  const [lastBoundSessionId, setLastBoundSessionId] = useState<string | null>(null);
  if (sessionId !== null && sessionId !== lastBoundSessionId) {
    setLastBoundSessionId(sessionId);
  }
  const feedStatus = useActivityStore((state) =>
    sessionId !== null ? (state.bySessionId[sessionId]?.feedStatus ?? null) : null,
  );
  // The grace flag records WHICH session outlived the window, so leaving the
  // rejected state needs no synchronous reset: the derived check below simply
  // stops matching.
  const [gracePassedForSessionId, setGracePassedForSessionId] = useState<string | null>(null);
  useEffect(() => {
    if (feedStatus !== 'rejected' || sessionId === null) return;
    const rejectedSessionId = sessionId;
    const graceTimer = setTimeout(() => setGracePassedForSessionId(rejectedSessionId), REJECTED_FEED_GRACE_MS);
    return () => clearTimeout(graceTimer);
  }, [feedStatus, sessionId]);
  // Signal 2: the desktop said outright that this screen's session is over.
  // Read from the store's ended-id set rather than the entry's feedStatus,
  // because the entry does not survive: the ended session leaves the board's
  // 'sessions' projection in the next snapshot and the reconciler prunes it.
  // Keyed on lastBoundSessionId as well as the current one - once the task is
  // off the board there is nothing left to resolve a sessionId from except the
  // navigation param, which a board-entered screen never has.
  const boundSessionEnded = useActivityStore((state) =>
    selectSessionEnded(state, sessionId ?? lastBoundSessionId),
  );
  const sessionEnded =
    (taskLocated && sessionId === null && lastBoundSessionId !== null) ||
    // Needs no grace window: unlike a refused subscribe, which can be a
    // transient race with the desktop's registry, this is the desktop telling
    // us the session it was streaming is gone. It is also the only signal a
    // session that dies while subscribed produces - markRejected fires from a
    // refused subscribe, which that path never hits.
    boundSessionEnded ||
    (sessionId !== null && feedStatus === 'rejected' && gracePassedForSessionId === sessionId);

  // The Chat segment's needs-you dot: a prompt is pending and the user is
  // looking at the terminal. Never auto-switch a surface someone types into.
  const awaitedPromptId = useActivityStore((state) =>
    sessionId !== null ? (state.bySessionId[sessionId]?.awaitedPromptId ?? null) : null,
  );
  const chatAttention = mode === 'terminal' && awaitedPromptId !== null;

  // Chat-fallback predicate (agent-agnostic): a loaded-but-empty transcript
  // means this agent has no structured feed, so the chat lens shows the
  // cleaned reading view and the WebView runs its clean-feed parser. A
  // structured session flips over automatically when its first entry lands.
  const chatFallbackActive = useTranscriptStore((state) => {
    if (sessionId === null) return false;
    const transcriptWindow = state.bySessionId[sessionId];
    return transcriptWindow !== undefined && transcriptWindow.totalEntries === 0;
  });
  const agentLabel = useBoardStore((state) => findTaskById(state, taskId)?.task.agent ?? null);

  // Move-to-column sheet: mirrors BoardScreen's long-press move wiring, over
  // this task instead of a long-pressed card. Scope the selector to THIS
  // project's board - an existing store reference, not a freshly-built object,
  // so it dodges the infinite-loop hazard the top-of-file note describes -
  // rather than subscribing to the whole boardsByProjectId map, which would
  // re-render this screen (and its unmemoized pager children) on any other
  // project's board mutation.
  const board = useBoardStore((state) => (projectId ? (state.boardsByProjectId[projectId] ?? null) : null));
  const moveColumns = useMemo(() => (board ? selectColumnsOrdered(board) : []), [board]);
  const moveTask = board ? (board.tasksById[taskId] ?? null) : null;
  const [moveSheetVisible, setMoveSheetVisible] = useState(false);
  const [moveInFlight, setMoveInFlight] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const openMoveSheet = useCallback(() => {
    setMoveError(null);
    setMoveSheetVisible(true);
  }, []);
  const closeMoveSheet = useCallback(() => setMoveSheetVisible(false), []);
  const onMove = useCallback(
    (targetSwimlaneId: string) => {
      if (!projectId || !board) return;
      const targetPosition = selectColumnTaskCount(board, targetSwimlaneId);
      setMoveInFlight(true);
      setMoveError(null);
      void moveTaskOptimistic({
        projectId,
        taskId,
        targetSwimlaneId,
        targetPosition,
      })
        .then(() => {
          triggerHaptic('taskMoved');
          setMoveSheetVisible(false);
        })
        .catch((error: unknown) => {
          setMoveError(error instanceof CapabilityError ? error.message : 'Move failed - check the connection');
        })
        .finally(() => setMoveInFlight(false));
    },
    [projectId, board, taskId],
  );

  const hasSeenSessionModeHint = useSettingsStore((state) => state.hasSeenSessionModeHint);
  const settingsHydrated = useSettingsStore((state) => state.hydrated);
  const showModeHint = settingsHydrated && !hasSeenSessionModeHint && !sessionEnded && sessionId !== null;
  const dismissModeHint = useCallback(() => {
    void useSettingsStore.getState().markSessionModeHintSeen();
  }, []);

  // Deep chat content (the prompt cards' "Answer in terminal" escape
  // hatch) raises a one-shot mode request through the terminal UI store.
  // Subscription-callback form: the store is the external system, setState
  // fires only inside its change callback, and the request is consumed
  // exactly once. Cards only render inside this mounted screen, so a
  // pre-mount request cannot exist.
  useEffect(() => {
    if (sessionId === null) return;
    const boundSessionId = sessionId;
    return useTerminalUiStore.subscribe((state) => {
      const requested = state.requestedModeBySessionId[boundSessionId];
      if (requested === undefined) return;
      useTerminalUiStore.getState().consumeRequestedMode(boundSessionId);
      setMode(requested);
      pagerRef.current?.setPage(MODE_PAGE_INDEX[requested]);
    });
  }, [sessionId]);

  const onModeChange = useCallback(
    (nextMode: SessionMode) => {
      setMode(nextMode);
      pagerRef.current?.setPage(MODE_PAGE_INDEX[nextMode]);
      dismissModeHint();
      // Remember the task's lens (terminal/chat only: Changes is a
      // destination the user visits, not a preferred way to watch the
      // agent).
      if (nextMode === 'terminal' || nextMode === 'chat') {
        void useSettingsStore.getState().setPreferredSessionLens(taskId, nextMode);
      }
    },
    [dismissModeHint, taskId],
  );

  const openChanges = useCallback(() => {
    onModeChange('changes');
  }, [onModeChange]);

  return (
    <Screen testID="session-screen">
      <TaskHeader taskTitle={taskTitle} sessionId={sessionId} displayId={locatedDisplayId} />
      {/* behavior="padding" on BOTH platforms: edge-to-edge Android never
          resizes the window for the soft keyboard, so without JS-side
          padding the keyboard fully covers the composer (send button
          unreachable while typing). */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <View style={styles.flex}>
          <PagerView
            ref={pagerRef}
            style={styles.flex}
            initialPage={MODE_PAGE_INDEX[mode]}
            scrollEnabled={false}
            offscreenPageLimit={2}
          >
            <View key="terminal" style={styles.flex} testID="session-pane-terminal">
              <TerminalTab sessionId={sessionId} active={mode === 'terminal'} cleanFeedEnabled={chatFallbackActive} />
            </View>
            <View key="chat" style={styles.flex} testID="session-pane-chat">
              <ChatPane taskId={taskId} sessionId={sessionId} projectId={projectId} agentLabel={agentLabel} />
            </View>
            <View key="changes" style={styles.flex} testID="session-pane-changes">
              <ChangesTab taskId={taskId} projectId={projectId} isActive={mode === 'changes'} />
            </View>
          </PagerView>

          {sessionEnded ? <SessionEndedState onViewChanges={openChanges} /> : null}
        </View>

        {showModeHint ? <ModeToggleHint onDismiss={dismissModeHint} /> : null}
        {!sessionEnded ? (
          <SessionInputBar
            sessionId={sessionId}
            mode={mode}
            onModeChange={onModeChange}
            chatAttention={chatAttention}
            onMove={openMoveSheet}
          />
        ) : null}
      </KeyboardAvoidingView>
      <MoveTaskSheet
        visible={moveSheetVisible}
        task={moveTask}
        columns={moveColumns}
        onClose={closeMoveSheet}
        onMove={onMove}
        moveInFlight={moveInFlight}
        errorMessage={moveError}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
});
