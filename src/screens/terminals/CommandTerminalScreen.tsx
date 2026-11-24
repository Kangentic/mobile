import React, { useCallback, useEffect, useState } from 'react';
import { KeyboardAvoidingView, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useNavigation, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useReducedMotion } from 'react-native-reanimated';
import { ActivityMarkIcon, ConnectionBanner, IconButton, Row, Screen, Stack, Text, useTheme } from '@/components';
import { CommandTerminalPill } from '@/components/board/CommandTerminalPill';
import { useScreenMotionActive } from '@/components/motion/ScreenMotion';
import { WaitCursor } from '@/components/motion/WaitCursor';
import { closeSessionScreen, openSessionScreen, stopCommandTerminal } from '@/connection/actions';
import { useReportedLens } from '@/navigation/screenTracking';
import { openNotificationSurface } from '@/notifications/notificationSignals';
import { selectSessionEnded, useActivityStore } from '@/state/activityStore';
import { COMMAND_TERMINAL_FALLBACK_NAME, selectCommandTerminal, useBoardStore } from '@/state/boardStore';
import { selectLaunch, useCommandTerminalStore } from '@/state/commandTerminalStore';
import { selectTerminalPainted, useTerminalUiStore } from '@/state/terminalUiStore';
import { selectChatLens, useTranscriptStore } from '@/state/transcriptStore';
import { ChangesTab } from '../task/ChangesTab';
import { ChatPane } from '../task/ChatPane';
import { SessionInputBar } from '../task/SessionInputBar';
import type { SessionMode } from '../task/SessionModeToggle';
import { TerminalTab } from '../task/TerminalTab';
import { commandTerminalTone } from './terminalDisplay';

/**
 * How long a failed start's reason stays on screen before the phone routes
 * back (design change 4: "about two seconds"). Long enough to read one plain
 * line; the going in and coming back out is itself the signal.
 */
export const START_FAILURE_HOLD_MS = 2_000;

/**
 * How long a terminal this screen was opened for, which no board lists and
 * no start of this phone's is still bringing up, is waited for before the
 * screen treats it as over: a notification tapped after the terminal ended,
 * say. Covers one board refresh in flight (the 300 ms debounce and a round
 * trip) with room; chosen, not measured.
 */
export const UNLISTED_TERMINAL_GRACE_MS = 3_000;

/** The desktop's own words while a Command Terminal starts (CommandTerminalLayer.tsx). */
export const STARTING_COMMAND_TERMINAL_CAPTION = 'Starting Command Terminal...';
export const START_FAILED_TITLE = "Couldn't start the terminal";
/** The desktop's own words while an Earlier conversation resumes, and when it cannot (CommandTerminalWindow.tsx). */
export const RESUMING_CONVERSATION_CAPTION = 'Resuming conversation...';
export const RESUME_FAILED_TITLE = "Couldn't resume conversation";

const HEADER_MARK_SIZE = 16;
const STOP_MARK_SIZE = 20;

/** The route's params, one type for the read and the write so their names cannot drift apart. */
type CommandTerminalRouteParams = { launchId?: string; sessionId?: string; projectId?: string };

function nonEmpty(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * An open Command Terminal (design changes 4 and 6, decisions C2, E1, F1, G1):
 * the same three lenses as a task's session, Terminal first, Chat as the
 * reading view, and Changes as the PROJECT FOLDER's diff, under a header with
 * the terminal's mark and name, the "Command Terminal" pill once the terminal
 * has a name of its own, and the desktop's round Stop.
 *
 * Its own screen rather than a mode of the task SessionScreen: a terminal has
 * no task, no column, no swap, no Resume and no archive, which is most of what
 * that screen's machinery is for, and every place a task-shaped assumption
 * leaked in would be a terminal drawn as a task.
 *
 * Reached three ways, by route params:
 * - `launchId`: the tap that STARTED it (the Board button with none running
 *   and nothing to resume, New on the sheet, or an Earlier row on the sheet,
 *   protocol 0.24.0). The screen opens at once on "Starting Command
 *   Terminal..." ("Resuming conversation..." for an Earlier row) and binds the
 *   session when the start answers; a start that fails shows its one line for
 *   START_FAILURE_HOLD_MS and routes back.
 * - `sessionId`: a sheet row, an Agents feed card, or a notification.
 *
 * LEAVES whenever the terminal ends, from its own Stop (one tap, straight back
 * to the screen it was opened from), an `/exit`, or the desktop: decision C2
 * ends a terminal with its agent, so there is never a dead terminal to sit on.
 * Like the task screen's own exit, it only navigates while focused.
 *
 * INPUT IS HELD until the desktop has classified the terminal's agent
 * (`activityObserved`): before then the PTY can be a bare shell at the project
 * root, and keeping it untyped is the phone's half of the desktop's promise
 * that the `command-terminal` verb adds no shell reach. The terminal pane, the
 * quick keys and the composer all hold it here, and the input actions
 * themselves refuse it (`assertTerminalInputOpen` in actions.ts), which also
 * covers the Chat lens's prompt cards and any surface that forgets the prop.
 */
export function CommandTerminalScreen(): React.JSX.Element {
  const params = useLocalSearchParams<CommandTerminalRouteParams>();
  const router = useRouter();
  // Typed here because expo-router's default param list is empty, which leaves
  // `setParams` accepting only undefined.
  const navigation = useNavigation<{ setParams(written: CommandTerminalRouteParams): void }>();
  const launchId = nonEmpty(params.launchId);
  const projectId = nonEmpty(params.projectId);
  const paramSessionId = nonEmpty(params.sessionId);
  const launch = useCommandTerminalStore((state) => selectLaunch(state, launchId));

  // The session this screen shows: the route's, or the one the start answered
  // with. Latched, because the launch that carried it is cleared once the
  // board lists the terminal. Render-time state, the pattern SessionScreen
  // uses for its own binding.
  const [boundSessionId, setBoundSessionId] = useState<string | null>(paramSessionId);
  if (boundSessionId === null && launch?.phase === 'started' && launch.sessionId !== null) {
    setBoundSessionId(launch.sessionId);
  }
  // Whether the launch resumes an Earlier conversation, latched for the same
  // reason: the starting face can outlast the launch, which is cleared once a
  // board lists the terminal.
  const [resuming, setResuming] = useState(launch !== null && launch.resumeAgentSessionId !== null);
  if (!resuming && launch !== null && launch.resumeAgentSessionId !== null) setResuming(true);
  // Written into the route too, so a remount (the OS restoring the screen)
  // binds the same terminal rather than looking for a launch that is gone.
  // Through the screen's own navigation object, never the router's method of the
  // same name: that one reads a module-level ref and throws here while it is
  // null, which cost a person the whole app (Sentry MOBILE-K). This one queues
  // the write, and for this route rather than whichever one is focused. See
  // .claude/rules/imperative-router-inside-react.md.
  useEffect(() => {
    if (boundSessionId !== null && paramSessionId === null) navigation.setParams({ sessionId: boundSessionId });
  }, [boundSessionId, navigation, paramSessionId]);

  useEffect(() => {
    if (boundSessionId === null) return;
    openSessionScreen(boundSessionId);
    return () => closeSessionScreen(boundSessionId);
  }, [boundSessionId]);
  // While this terminal is on screen its alerts are redundant: they are cleared
  // now and on every return to the app (the reconciler's clear on open). Focus,
  // not mount, so a route pushed over it releases the claim.
  useFocusEffect(
    useCallback(() => {
      if (boundSessionId === null) return;
      return openNotificationSurface({ kind: 'command-terminal', sessionId: boundSessionId });
    }, [boundSessionId]),
  );

  const terminal = useBoardStore((state) => selectCommandTerminal(state, boundSessionId));
  const listed = terminal !== null;
  const [everListed, setEverListed] = useState(false);
  if (listed && !everListed) setEverListed(true);
  const sessionEnded = useActivityStore((state) => selectSessionEnded(state, boundSessionId));
  const boardLoaded = useBoardStore((state) => projectId !== null && state.boardsByProjectId[projectId] !== undefined);
  const launchPending = launch !== null && launch.phase !== 'failed';
  const awaitingListing = boundSessionId !== null && !listed && !everListed && !launchPending && boardLoaded;
  const [unlistedGracePassedFor, setUnlistedGracePassedFor] = useState<string | null>(null);
  useEffect(() => {
    if (!awaitingListing || boundSessionId === null) return;
    const awaitedSessionId = boundSessionId;
    const graceTimer = setTimeout(() => setUnlistedGracePassedFor(awaitedSessionId), UNLISTED_TERMINAL_GRACE_MS);
    return () => clearTimeout(graceTimer);
  }, [awaitingListing, boundSessionId]);
  const terminalEnded =
    sessionEnded || (everListed && !listed) || (awaitingListing && unlistedGracePassedFor === boundSessionId);

  // A failed start holds its line, then routes back. The launch is cleared on
  // the way out so a later visit cannot find it.
  const startFailed = launch?.phase === 'failed';
  const [failureHoldPassed, setFailureHoldPassed] = useState(false);
  useEffect(() => {
    if (!startFailed) return;
    const holdTimer = setTimeout(() => setFailureHoldPassed(true), START_FAILURE_HOLD_MS);
    return () => clearTimeout(holdTimer);
  }, [startFailed]);
  useEffect(
    () => () => {
      if (launchId !== null && useCommandTerminalStore.getState().launchesById[launchId]?.phase === 'failed') {
        useCommandTerminalStore.getState().clearLaunch(launchId);
      }
    },
    [launchId],
  );

  const [stopTapped, setStopTapped] = useState(false);
  const leaveScreen = terminalEnded || failureHoldPassed || stopTapped;
  useFocusEffect(
    // Focus-gated, as SessionScreen's exit is: a pop from underneath a route
    // pushed over this screen would pop that route instead.
    useCallback(() => {
      if (!leaveScreen) return;
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }, [leaveScreen, router]),
  );

  const onStop = useCallback(() => {
    if (boundSessionId === null) return;
    void stopCommandTerminal(boundSessionId);
    setStopTapped(true);
  }, [boundSessionId]);

  // Primitives, not the entry: an activity event that changes neither (usage,
  // a preview) leaves the screen alone, as on the sheet and the Board button.
  const activityObserved = useActivityStore(
    (state) => boundSessionId !== null && state.bySessionId[boundSessionId]?.activityObserved === true,
  );
  const tone = useActivityStore((state) =>
    commandTerminalTone(boundSessionId !== null ? (state.bySessionId[boundSessionId] ?? null) : null),
  );
  const inputEnabled = activityObserved && !startFailed;
  const painted = useTerminalUiStore((state) => selectTerminalPainted(state, boundSessionId));
  const chatFallbackActive = useTranscriptStore((state) => selectChatLens(state, boundSessionId) === 'reading-view');

  const [mode, setMode] = useState<SessionMode>('terminal');
  // Which lens a crash report says this screen was on (see SessionScreen).
  useReportedLens('/command-terminal', mode);
  const title = terminal?.name ?? launch?.name ?? COMMAND_TERMINAL_FALLBACK_NAME;
  const named = terminal?.named === true;
  const startingFaceShown = !startFailed && mode === 'terminal' && (boundSessionId === null || !painted);

  return (
    <Screen testID="command-terminal-screen">
      <CommandTerminalHeader
        title={title}
        named={named}
        starting={!activityObserved}
        tone={tone}
        stopEnabled={boundSessionId !== null && !startFailed && !stopTapped}
        onStop={onStop}
      />
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <View style={styles.flex}>
          {/* The same three always-mounted panes as the task session screen
              (see SessionScreen for why: the WebView must never reload). */}
          <View style={styles.flex} collapsable={false} testID="command-terminal-panes">
            <View
              style={[styles.pane, mode === 'terminal' ? styles.paneVisible : styles.paneHidden]}
              pointerEvents={mode === 'terminal' ? 'auto' : 'none'}
              accessibilityElementsHidden={mode !== 'terminal'}
              importantForAccessibility={mode === 'terminal' ? 'auto' : 'no-hide-descendants'}
              testID="command-terminal-pane-terminal"
            >
              <TerminalTab
                sessionId={boundSessionId}
                active={mode === 'terminal'}
                cleanFeedEnabled={chatFallbackActive}
                inputEnabled={inputEnabled}
                emptyMessage=""
              />
            </View>
            <View
              style={[styles.pane, mode === 'chat' ? styles.paneVisible : styles.paneHidden]}
              pointerEvents={mode === 'chat' ? 'auto' : 'none'}
              accessibilityElementsHidden={mode !== 'chat'}
              importantForAccessibility={mode === 'chat' ? 'auto' : 'no-hide-descendants'}
              testID="command-terminal-pane-chat"
            >
              {/* No task: a Command Terminal has no transcript record, so the
                  Chat lens settles on the reading view of its live terminal. */}
              <ChatPane taskId="" sessionId={boundSessionId} projectId={projectId} agentLabel={null} />
            </View>
            <View
              style={[styles.pane, mode === 'changes' ? styles.paneVisible : styles.paneHidden]}
              pointerEvents={mode === 'changes' ? 'auto' : 'none'}
              accessibilityElementsHidden={mode !== 'changes'}
              importantForAccessibility={mode === 'changes' ? 'auto' : 'no-hide-descendants'}
              testID="command-terminal-pane-changes"
            >
              {/* The project folder against its default base branch, as the
                  desktop terminal window's Changes panel shows it (F1). */}
              <ChangesTab taskId={null} projectId={projectId} isActive={mode === 'changes'} />
            </View>
          </View>
          {startFailed ? (
            <StartFailedFace title={resuming ? RESUME_FAILED_TITLE : START_FAILED_TITLE} message={launch?.failureMessage ?? null} />
          ) : startingFaceShown ? (
            <StartingFace caption={resuming ? RESUMING_CONVERSATION_CAPTION : STARTING_COMMAND_TERMINAL_CAPTION} />
          ) : null}
        </View>
        <SessionInputBar
          sessionId={boundSessionId}
          mode={mode}
          onModeChange={setMode}
          chatAttention={false}
          inputLocked={!inputEnabled}
          dimmed={startFailed}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The header (design changes 4 and 6): the raised back button, the terminal's
 * mark in its tone (muted while it starts), its name, the "Command Terminal"
 * pill only once it has a name of its own (an unnamed terminal's title already
 * says it), and the desktop's round Stop: its ring spins green while the
 * terminal works and rests amber when it needs you.
 */
function CommandTerminalHeader({
  title,
  named,
  starting,
  tone,
  stopEnabled,
  onStop,
}: {
  title: string;
  named: boolean;
  starting: boolean;
  tone: 'working' | 'needs-you';
  stopEnabled: boolean;
  onStop: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const markTone = starting ? 'rest' : tone;
  return (
    <>
      <Row
        gap="sm"
        style={[
          styles.header,
          {
            paddingTop: insets.top,
            paddingHorizontal: theme.spacing.xs,
            paddingRight: theme.spacing.sm,
            backgroundColor: theme.colors.surface,
            borderBottomColor: theme.colors.border,
          },
        ]}
      >
        <IconButton iconName="chevron-back" onPress={() => router.back()} testID="command-terminal-back" accessibilityLabel="Back" />
        <ActivityMarkIcon mark="terminal-idle" tone={markTone} size={HEADER_MARK_SIZE} testID={`command-terminal-mark-${markTone}`} />
        <Text variant="bodyStrong" numberOfLines={1} style={styles.flex} testID="command-terminal-title">
          {title}
        </Text>
        {named ? <CommandTerminalPill testID="command-terminal-pill" /> : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Stop terminal"
          accessibilityState={{ disabled: !stopEnabled }}
          disabled={!stopEnabled}
          onPress={onStop}
          testID="command-terminal-stop"
          style={({ pressed }) => [
            styles.stopCircle,
            {
              width: theme.minTouchSize,
              height: theme.minTouchSize,
              borderRadius: theme.minTouchSize / 2,
              backgroundColor: theme.colors.surfaceRaised,
              borderColor: theme.colors.border,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          <ActivityMarkIcon
            mark={!starting && tone === 'working' ? 'control-stop-working' : 'control-stop-idle'}
            tone={markTone}
            size={STOP_MARK_SIZE}
            testID={`command-terminal-stop-mark-${markTone}`}
          />
        </Pressable>
      </Row>
      <ConnectionBanner />
    </>
  );
}

/**
 * "Starting Command Terminal..." (or "Resuming conversation..."), the
 * desktop's own words, over the empty terminal with its wait cursor, until the
 * terminal's first frame paints. The
 * cursor blinks on the shared two-frames-a-second toggle (WaitCursor), gated
 * by reduced motion and the route's motion provider like the swap veil's, and
 * BOUNDED like the pane's own wait (TerminalWaitOverlay): past
 * `terminalWaitCursor.holdAfterMs` it holds still, because a loop must stop
 * even when the first frame never comes (motion-conventions.md).
 */
function StartingFace({ caption }: { caption: string }): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const screenMotionActive = useScreenMotionActive();
  const holdAfterMs = theme.motion.terminalWaitCursor.holdAfterMs;
  const [blinkExpired, setBlinkExpired] = useState(false);
  useEffect(() => {
    const holdTimer = setTimeout(() => setBlinkExpired(true), holdAfterMs);
    return () => clearTimeout(holdTimer);
  }, [holdAfterMs]);
  return (
    <View
      style={[styles.overlay, { backgroundColor: theme.colors.terminalBackground }]}
      accessibilityRole="progressbar"
      accessibilityLabel={caption}
      accessibilityState={{ busy: true }}
      testID="command-terminal-starting"
    >
      <WaitCursor testID="command-terminal-starting-cursor" blinking={!reducedMotion && screenMotionActive && !blinkExpired} />
      <View style={styles.centered} pointerEvents="none">
        <Text variant="body" color="muted" testID="command-terminal-starting-caption">
          {caption}
        </Text>
      </View>
    </View>
  );
}

/** A start or resume that failed: what happened and why, for START_FAILURE_HOLD_MS, before the screen routes back. */
function StartFailedFace({ title, message }: { title: string; message: string | null }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.overlay, { backgroundColor: theme.colors.terminalBackground }]} testID="command-terminal-start-failed">
      <Stack gap="xs" style={[styles.centered, { paddingHorizontal: theme.spacing.xl }]}>
        <Text variant="bodyStrong" style={styles.centeredText} testID="command-terminal-start-failed-title">
          {title}
        </Text>
        {message !== null ? (
          <Text variant="caption" color="muted" style={styles.centeredText} testID="command-terminal-start-failed-reason">
            {message}
          </Text>
        ) : null}
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  header: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  stopCircle: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  pane: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  paneVisible: {
    opacity: 1,
    zIndex: 1,
  },
  paneHidden: {
    opacity: 0,
    zIndex: 0,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    // Above the visible pane's zIndex 1, as the swap veil sits.
    zIndex: 2,
  },
  centered: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centeredText: {
    textAlign: 'center',
  },
});
