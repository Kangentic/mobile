import React, { useCallback, useEffect, useRef, useState } from 'react';
import { KeyboardAvoidingView, Platform, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import PagerView from 'react-native-pager-view';
import { Screen } from '@/components';
import { findTaskById, useBoardStore } from '@/state/boardStore';
import { useActivityStore } from '@/state/activityStore';
import { useSettingsStore } from '@/state/settingsStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { openSessionScreen, closeSessionScreen } from '@/connection/actions';
import { TaskHeader } from './TaskHeader';
import { ChatPane } from './ChatPane';
import { TerminalTab } from './TerminalTab';
import { SessionEndedState } from './SessionEndedState';
import { SessionInputBar } from './SessionInputBar';
import { ModeToggleHint } from './ModeToggleHint';
import { resolveCurrentSessionId } from './sessionResolution';
import type { SessionMode } from './SessionModeToggle';

const MODE_PAGE_INDEX: Record<SessionMode, number> = { terminal: 0, chat: 1 };

/**
 * How long a 'rejected' stream feed must persist before the screen declares
 * the session dead. A respawn races the board snapshot against the old
 * stream's rejection; the grace window keeps the ended state from flashing
 * when the successor sessionId is about to arrive.
 */
const REJECTED_FEED_GRACE_MS = 1500;

/**
 * The task's SESSION view: one live session, two lenses. Terminal (the raw
 * 1:1 desktop mirror, the default) and Chat (the readable feed) share a
 * non-swipe pager - both stay mounted so the xterm WebView never reloads
 * and the conversation keeps scroll position; switching is tap-only via the
 * mode pill in the input bar (swipe belongs to the terminal's pan). The one
 * footer is mode-aware: PTY keystrokes in Terminal, agent messages in Chat.
 * Changes is its own pushed destination (the header chip).
 */
export function SessionScreen(): React.JSX.Element {
  const router = useRouter();
  const params = useLocalSearchParams<{ taskId: string; sessionId?: string; projectId?: string; mode?: string }>();
  const taskId = params.taskId;

  // Select primitives, never the object findTaskById builds: returning a
  // fresh { task, projectId } from a Zustand selector changes identity every
  // render and drives useSyncExternalStore into an infinite re-render loop.
  const locatedTaskTitle = useBoardStore((state) => findTaskById(state, taskId)?.task.title ?? null);
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

  // Terminal is the headline default; needs-you entry points pass mode=chat
  // so prompt answering lands on the answerable side.
  const [mode, setMode] = useState<SessionMode>(params.mode === 'chat' ? 'chat' : 'terminal');
  const pagerRef = useRef<PagerView>(null);

  useEffect(() => {
    if (!sessionId) return;
    openSessionScreen(sessionId);
    return () => closeSessionScreen(sessionId);
  }, [sessionId]);

  // SESSION-DEATH DETECTION. Two signals, both scoped to the CURRENT binding:
  // 1. The board located the task but reports no session, after this screen
  //    had one: the session ended with no successor (authoritative).
  // 2. The stream feed for the bound session sits 'rejected' past a grace
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
  const sessionEnded =
    (taskLocated && sessionId === null && lastBoundSessionId !== null) ||
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

  const hasSeenSessionModeHint = useSettingsStore((state) => state.hasSeenSessionModeHint);
  const settingsHydrated = useSettingsStore((state) => state.hydrated);
  const showModeHint = settingsHydrated && !hasSeenSessionModeHint && !sessionEnded && sessionId !== null;
  const dismissModeHint = useCallback(() => {
    void useSettingsStore.getState().markSessionModeHintSeen();
  }, []);

  const onModeChange = useCallback(
    (nextMode: SessionMode) => {
      setMode(nextMode);
      pagerRef.current?.setPage(MODE_PAGE_INDEX[nextMode]);
      dismissModeHint();
    },
    [dismissModeHint],
  );

  const openChanges = useCallback(() => {
    router.push({
      pathname: '/task/[taskId]/changes',
      params: { taskId, ...(projectId ? { projectId } : {}) },
    });
  }, [router, taskId, projectId]);

  return (
    <Screen testID="session-screen">
      <TaskHeader taskTitle={taskTitle} sessionId={sessionId} onOpenChanges={openChanges} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <View style={styles.flex}>
          <PagerView
            ref={pagerRef}
            style={styles.flex}
            initialPage={MODE_PAGE_INDEX[mode]}
            scrollEnabled={false}
            offscreenPageLimit={1}
          >
            <View key="terminal" style={styles.flex} testID="session-pane-terminal">
              <TerminalTab sessionId={sessionId} active={mode === 'terminal'} cleanFeedEnabled={chatFallbackActive} />
            </View>
            <View key="chat" style={styles.flex} testID="session-pane-chat">
              <ChatPane taskId={taskId} sessionId={sessionId} projectId={projectId} agentLabel={agentLabel} />
            </View>
          </PagerView>

          {sessionEnded ? <SessionEndedState onViewChanges={openChanges} /> : null}
        </View>

        {showModeHint ? <ModeToggleHint onDismiss={dismissModeHint} /> : null}
        {!sessionEnded ? (
          <SessionInputBar sessionId={sessionId} mode={mode} onModeChange={onModeChange} chatAttention={chatAttention} />
        ) : null}
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
});
