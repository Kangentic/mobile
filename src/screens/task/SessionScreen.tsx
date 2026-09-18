import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, KeyboardAvoidingView, StyleSheet, View } from 'react-native';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { Screen } from '@/components';
import { useScreenFocusActive } from '@/components/motion/ScreenMotion';
import { traceConnection } from '@/devsupport/connectionTrace';
import { findArchivedTaskById, findTaskById, isDoneRole, isTodoRole, useBoardStore } from '@/state/boardStore';
import { selectSessionEnded, selectSessionSpawnProgressLabel, useActivityStore } from '@/state/activityStore';
import { useSettingsStore } from '@/state/settingsStore';
import { selectChatLens, useTranscriptStore } from '@/state/transcriptStore';
import { selectTerminalPainted, useTerminalUiStore } from '@/state/terminalUiStore';
import { closeSessionScreen, loadArchivedTasks, openSessionScreen } from '@/connection/actions';
import { TaskHeader } from './TaskHeader';
import { ChatPane } from './ChatPane';
import { ChangesTab } from './ChangesTab';
import { TerminalTab } from './TerminalTab';
import {
  SESSION_SWAP_SETTLED_ANNOUNCEMENT,
  SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL,
  SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL,
  SessionSwapVeil,
} from './SessionSwapVeil';
import { SessionInputBar } from './SessionInputBar';
import { ModeToggleHint } from './ModeToggleHint';
import { resolveCurrentSessionId } from './sessionResolution';
import type { SessionMode } from './SessionModeToggle';

/**
 * How long a 'rejected' stream feed must persist before the screen declares
 * the session dead. A respawn races the board snapshot against the old
 * stream's rejection; the grace window keeps the ended state from flashing
 * when the successor sessionId is about to arrive.
 */
const REJECTED_FEED_GRACE_MS = 1500;

/**
 * How long the column latch below stays armed after a move.
 *
 * A column move that restarts the agent is a session swap, and the board
 * reports the move seconds before the session actually ends (the desktop
 * interrupts the agent, waits for a running tool, then suspends). The latch
 * is what lets the quiet window open on the move itself. But a move PROMISES
 * a successor without GUARANTEEING one (a board profile can keep the session,
 * two columns can share one, a worktree checkout can fail), so the latch is
 * bounded, or the next move could never arm one of its own. Measured on the
 * desktop's own IPC log: cross-column `task:move` runs a median 2.3s with a
 * 24.4s tail; 20s covers the common tail.
 *
 * Nothing user-visible hangs on this expiry any more. It used to be the
 * fallback from "Switching session" to "Session ended", which was the phone
 * changing its verdict on a clock; past the quiet window the screen now
 * simply keeps waiting, the empty terminal under the veil, for as long as
 * it takes. The Home feed's
 * RESPAWN_ROW_GRACE_MS (how long a labelled ghost row is retained) is kept
 * equal to it so the desktop's "a successor is coming" stops counting on both
 * surfaces at the same moment; tests/unit/sessionRespawnGapTiming.test.ts
 * pins that.
 */
const SESSION_SWAP_GRACE_MS = 20_000;

/**
 * How long a session swap stays SILENT: from the bound session's end until
 * either the successor has painted or this deadline passes, the screen shows
 * the swap veil (the last frame under a breathing scrim, no text) and nothing
 * else. Past it nothing is REVEALED: the wait goes on, the way the desktop's
 * own launch overlay does, and the deadline is a phase change inside it. The
 * pane clears from the dead session's last frame to the empty terminal under
 * the same scrim, the footer drops to the switcher, and Chat and Changes
 * open up (the transcript and the diff are still worth reading, and the
 * phone cannot tell a stalled spawn from a park or from its own updates not
 * arriving). Every normal move never reaches it.
 *
 * Bounded below by the rigs' respawn gap (STUB_RESPAWN_GAP_MS,
 * MOCK_RESPAWN_GAP_MS), which must sit at least 2s inside it so a rig swap
 * stays silent; tests/unit/sessionRespawnGapTiming.test.ts pins it.
 *
 * MEASURED (release build, x86_64 emulator, the real desktop over the hosted
 * relay, 2026-09-18, ten column moves across Executing, Code Review and
 * Planning, terminal mode): the connection trace's `session-swap` timeline
 * put ended-to-settled at 730-2466 ms, median 0.99 s, ninth of ten 2.40 s;
 * ended-to-bind at 360-535 ms. 8 s covers the slowest observed swap three
 * times over while still revealing a genuinely stalled spawn inside the
 * time a user would wait. See "Measuring a session swap" in
 * docs/developer-guide.md for the procedure. The Home feed's
 * ENDED_ROW_GRACE_MS is kept equal to it, so a swap that goes quiet here
 * goes quiet on the list surfaces for the same span.
 */
export const SESSION_SWAP_QUIET_MS = 8_000;

/**
 * The task's SESSION view: one live session, three surfaces. Terminal (the
 * raw 1:1 desktop mirror, the default), Chat (the readable feed), and
 * Changes (the diff) are absolutely-positioned siblings with only the active
 * one visible - all stay mounted so the xterm WebView never reloads and the
 * conversation keeps scroll position; switching is tap-only via the mode pill
 * in the footer (swipe belongs to the terminal's pan). The footer is
 * mode-aware: quick keys + dictation in Terminal (typing happens directly in
 * the terminal - tap it for the keyboard), the composer in Chat, nothing
 * extra in Changes.
 */
export function SessionScreen(): React.JSX.Element {
  const params = useLocalSearchParams<{ taskId: string; sessionId?: string; projectId?: string; mode?: string }>();
  const router = useRouter();
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
  const locatedSwimlaneId = useBoardStore((state) => findTaskById(state, taskId)?.task.swimlane_id ?? null);
  // The role of the column the task is in RIGHT NOW, optimistic overlay
  // included. Reading the optimistic value is what makes the Done check below
  // fire the instant the user confirms the move rather than a round trip
  // later - "fixing" this to read only authoritative snapshots reintroduces a
  // full "Switching session" window on every move to Done.
  const locatedColumnRole = useBoardStore((state) => {
    const located = findTaskById(state, taskId);
    if (!located) return null;
    const board = state.boardsByProjectId[located.projectId];
    return board?.columns.find((column) => column.id === located.task.swimlane_id)?.role ?? null;
  });
  // The header must not change what it says during a swap. Under the board's
  // 'sessions' projection the task leaves the snapshot for the whole gap, so
  // the located title and number go null; without this hold the title read
  // as the literal "Task" and the number vanished for a second or two. Held
  // while located (render-time state adjustment, the pattern this file uses
  // for lastBoundSessionId below), read while not.
  const [heldIdentity, setHeldIdentity] = useState<{ title: string; displayId: number | null } | null>(null);
  if (
    locatedTaskTitle !== null &&
    (heldIdentity === null || heldIdentity.title !== locatedTaskTitle || heldIdentity.displayId !== locatedDisplayId)
  ) {
    setHeldIdentity({ title: locatedTaskTitle, displayId: locatedDisplayId });
  }
  const taskTitle = locatedTaskTitle ?? heldIdentity?.title ?? 'Task';
  const headerDisplayId = taskLocated ? locatedDisplayId : (heldIdentity?.displayId ?? null);
  const projectId = params.projectId && params.projectId.length > 0 ? params.projectId : locatedProjectId;
  const paramSessionId = params.sessionId && params.sessionId.length > 0 ? params.sessionId : null;
  // The board is authoritative once it has located the task (a respawn swaps
  // the task's session_id under a mounted screen); the param only bridges the
  // gap before the FIRST board snapshot. See sessionResolution.ts.
  //
  // "First" is load-bearing: the sessions projection drops the task for the
  // whole of every later swap, and re-trusting the param there rebinds the
  // session this screen was OPENED with - after a few swaps a long-dead id,
  // which re-subscribed a corpse and re-keyed the quiet window (seen in the
  // release-build trace of 2026-09-18 as a second `ended` line 29 ms after
  // the first). Once located, a later "not located" resolves to null, exactly
  // as the full projection's sessionless task does, and the panes stay on
  // lastBoundSessionId below. Render-time state, the pattern this file uses.
  const [everLocated, setEverLocated] = useState(false);
  if (taskLocated && !everLocated) setEverLocated(true);
  const sessionId = resolveCurrentSessionId({
    taskLocated: taskLocated || everLocated,
    locatedSessionId,
    paramSessionId,
  });

  // Mode priority: an explicit route param (needs-you rows land on chat)
  // beats the task's remembered lens beats the terminal default. The
  // remembered lens is read once at mount - later store writes must not
  // yank the surface the user is looking at.
  const [mode, setMode] = useState<SessionMode>(() => {
    if (params.mode === 'chat' || params.mode === 'changes') return params.mode;
    return useSettingsStore.getState().preferredSessionLensByTaskId[taskId] ?? 'terminal';
  });

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
  // What the PANES and the FOOTER are bound to. The board's answer wins while
  // it has one; while it has none (the full projection reports a located task
  // with session_id null mid-swap, the sessions projection drops the task and
  // a board-entered screen has no param to fall back on) they stay on the
  // last session this screen bound rather than unmounting. Unmounting was the
  // xterm WebView being destroyed and rebuilt on every column move under the
  // Board tab, and ChatPane's "no session" empty state flashing under Home.
  // Everything that TALKS to the session (the open/close effect, the feed
  // status, the prompt dot, the mode request) stays on the real `sessionId`.
  const displaySessionId = sessionId ?? lastBoundSessionId;
  // The desktop's in-flight spawn-progress label for the session that just
  // ended (kangentic board #639). Nothing on this screen renders it any more;
  // it feeds the connection trace's `hasLabel` only, so a measured swap can
  // be told from a same-column respawn. Read on the same
  // `sessionId ?? lastBoundSessionId` key `boundSessionEnded` uses further
  // down, and for the same reason: once the board drops the sessionless task
  // the only sessionId left to key off is the one this screen already bound.
  const boundSpawnProgressLabel = useActivityStore((state) =>
    selectSessionSpawnProgressLabel(state, sessionId ?? lastBoundSessionId),
  );
  // The column the task sat in when the CURRENT session bound, and a latch
  // that opens when it changes. A column move that restarts the agent is a
  // session swap, and the board reports the move seconds before the desktop
  // has suspended the session; the latch is what lets the quiet window below
  // open on the move itself rather than on the end that follows.
  //
  // The latch is a LATCH, not a re-derived predicate. For a phone-initiated
  // move applyOptimisticMove writes the new swimlane the instant the user
  // confirms, long before the ended push; and under the board's 'sessions'
  // projection the task leaves the snapshot entirely once its session dies,
  // taking `locatedSwimlaneId` to null. Either way the evidence of the move is
  // gone by the time it is needed, so it is captured when it appears and held.
  const [swimlaneIdWhenSessionBound, setSwimlaneIdWhenSessionBound] = useState<string | null>(null);
  // The column the open latch is waiting on (null = closed), and the column
  // whose latch has already run out. Both are ids rather than booleans so an
  // expired latch cannot re-arm: the task is STILL in the column it moved to,
  // so a plain boolean re-armed on the very next render.
  //
  // There used to be a SESSION-keyed sibling latch here, opened by the
  // desktop's spawnProgressLabel for a same-column respawn. It chose between
  // "Switching session" and "Session ended" at the reveal; with one waiting
  // card for every case there is nothing left for it to choose, and the quiet
  // window below opens on any end of the bound session, label or not.
  const [swapWindowSwimlaneId, setSwapWindowSwimlaneId] = useState<string | null>(null);
  const [spentSwapSwimlaneId, setSpentSwapSwimlaneId] = useState<string | null>(null);
  // The column latch the quiet window below has ALREADY opened for, so a
  // window that ran out while the session was still alive is not re-opened
  // by the same move on the next render. Reset with the latch at the bind.
  const [veiledSwapSwimlaneId, setVeiledSwapSwimlaneId] = useState<string | null>(null);
  if (sessionId !== null && sessionId !== lastBoundSessionId) {
    setLastBoundSessionId(sessionId);
    // A successor bound: this column is the new baseline, and the move is over.
    setSwimlaneIdWhenSessionBound(locatedSwimlaneId);
    setSwapWindowSwimlaneId(null);
    setSpentSwapSwimlaneId(null);
    setVeiledSwapSwimlaneId(null);
  } else if (sessionId !== null && swimlaneIdWhenSessionBound === null && locatedSwimlaneId !== null) {
    // The board located the task after this screen bound its session from the
    // nav param: adopt the column as the baseline, never read it as a change.
    setSwimlaneIdWhenSessionBound(locatedSwimlaneId);
  } else if (
    swapWindowSwimlaneId === null &&
    swimlaneIdWhenSessionBound !== null &&
    locatedSwimlaneId !== null &&
    locatedSwimlaneId !== swimlaneIdWhenSessionBound &&
    locatedSwimlaneId !== spentSwapSwimlaneId &&
    // Two destinations promise no successor and leave this screen instead
    // (see leaveScreen below): a move to To Do is a full reset (session
    // killed, worktree removed), and a move to Done archives the task.
    !isTodoRole(locatedColumnRole) &&
    !isDoneRole(locatedColumnRole)
  ) {
    setSwapWindowSwimlaneId(locatedSwimlaneId);
  }
  useEffect(() => {
    if (swapWindowSwimlaneId === null) return;
    const waitingOnSwimlaneId = swapWindowSwimlaneId;
    const swapTimer = setTimeout(() => {
      setSpentSwapSwimlaneId(waitingOnSwimlaneId);
      setSwapWindowSwimlaneId(null);
    }, SESSION_SWAP_GRACE_MS);
    return () => clearTimeout(swapTimer);
  }, [swapWindowSwimlaneId]);
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

  /**
   * FINISHED AND RESET TASKS LEAVE THIS SCREEN.
   *
   * A move to Done suspends the agent, deletes the worktree and archives the
   * task; a move to To Do kills the session and removes the worktree. Neither
   * promises a successor, so waiting here would be waiting for nothing, and the
   * Changes pane would show read-diff's fallback to the PROJECT checkout once
   * `worktree_path` is cleared, the main checkout's working diff dressed as
   * this task's work. The screen goes back to wherever the task was opened
   * from (the board, the Agents feed), which is what confirming the move on
   * the sheet already implied. Never to the completed-task view: a move the
   * user just made is not a reason to push a new screen at them.
   *
   * Two signals. The COLUMN ROLE fires the instant a move is confirmed on
   * this phone (applyOptimisticMove writes the destination column before any
   * round trip) and on the next snapshot for a move made on the desktop under
   * the full projection. Gated on a bound session, so a To Do task opened
   * with no session (the board routes those to the edit form, but a stale
   * row can still land here) simply shows its empty state. The ARCHIVE covers
   * the rest: under the sessions projection a task moved to Done leaves the
   * snapshot exactly as it does for every swap, so the archive page is
   * requested once the session looks over, and the navigation is driven by a
   * reactive read of the store rather than by that request resolving.
   * loadArchivedTasks early-returns while any page is in flight, so a
   * BoardScreen fetch racing this one would otherwise make the request a
   * silent no-op and the screen would sit waiting forever.
   */
  const taskLeftForRole =
    lastBoundSessionId !== null && (isDoneRole(locatedColumnRole) || isTodoRole(locatedColumnRole));
  const maybeArchived = sessionEnded || (!taskLocated && lastBoundSessionId !== null);
  /**
   * Not a single one-shot: the first look can legitimately be too early.
   * Moving to Done writes the task into the done column optimistically, so
   * `locatedColumnRole` says 'done' before the desktop has archived anything -
   * that page comes back without the task, and a plain "fetched once" guard
   * would then never look again. So the fetch is keyed on WHY it fired, and
   * the task leaving the board (the authoritative signal, emitted in the same
   * tick as the archive row) is a second, decisive look.
   */
  const archiveFetchKey =
    maybeArchived && projectId !== null ? `${projectId}:${taskLocated ? 'located' : 'gone'}` : null;
  // A ref, not state: this only guards the fetch from repeating, and nothing
  // renders from it. As state it is a setState inside an effect - a cascading
  // render for no visible change, and an eslint error.
  const archiveFetchedForKeyRef = useRef<string | null>(null);
  // Whether a page for this project is ALREADY in flight, from this screen or
  // any other (BoardScreen fetches the same list). loadArchivedTasks
  // early-returns in that case - silently, resolving rather than throwing - so
  // firing into it would burn this key's one look on a request that never
  // happened, and the `.catch` below would not fire to give it back. That
  // strands a completed task under the ended overlay for the life of the
  // screen, which is the exact failure the two-key design above exists to
  // prevent. The in-flight page was also fetched BEFORE this key's evidence
  // existed, so it can legitimately come back without the task; waiting for it
  // to land and re-running is both correct and the only way to get a look that
  // reflects the archive row.
  const archiveFetchInFlight = useBoardStore((state) =>
    projectId !== null ? (state.archivedByProjectId[projectId]?.loading ?? false) : false,
  );
  useEffect(() => {
    if (archiveFetchKey === null || projectId === null) return;
    if (archiveFetchedForKeyRef.current === archiveFetchKey) return;
    if (archiveFetchInFlight) return;
    archiveFetchedForKeyRef.current = archiveFetchKey;
    void loadArchivedTasks({ projectId }).catch(() => {
      // Offline, or the desktop refused: the screen stays on the waiting
      // card, which is the honest answer when we cannot tell that it
      // completed. The task leaving the board still changes the key, so the
      // decisive second look survives a failed first one.
      //
      // The key is NOT given back here. A failure sets `loading` false on its
      // way out, which is a dependency of this effect, so freeing the key
      // would re-run it, re-fetch, fail again and spin - a tight retry loop
      // for as long as the desktop stays unreachable. (Before `loading` was a
      // dependency nothing could re-run this effect under an unchanged key, so
      // giving it back had no effect either way.)
    });
  }, [archiveFetchKey, projectId, archiveFetchInFlight]);
  // Select the STORED slice and derive from it: findArchivedTaskById builds a
  // fresh object per call, so calling it inside the selector hands
  // useSyncExternalStore a new snapshot every render and loops it.
  const archivedByProjectId = useBoardStore((state) => state.archivedByProjectId);
  const archivedProjectId = useMemo(
    () => findArchivedTaskById({ archivedByProjectId }, taskId)?.projectId ?? null,
    [archivedByProjectId, taskId],
  );
  // `!taskLocated` as well as the archive hit: an archive page held from an
  // earlier visit must not bounce a task that has since been moved back out of
  // Done and is live on the board again.
  const taskArchived = !taskLocated && archivedProjectId !== null;
  const leaveScreen = taskLeftForRole || taskArchived;
  useFocusEffect(
    // Focus-gated, and that is load bearing: the move sheet dismisses itself
    // with router.back() on success, and an unguarded pop from underneath
    // races that dismissal and intermittently leaves the sheet on screen.
    useCallback(() => {
      if (!leaveScreen) return;
      // Back to where the task was opened from, whichever tab that was. A
      // cold start straight onto this route (a notification tap) has nothing
      // behind it, and Home is where that tap would have landed anyway.
      if (router.canGoBack()) router.back();
      else router.replace('/');
    }, [leaveScreen, router]),
  );

  /**
   * THE QUIET WINDOW: one silent surface for every swap kind.
   *
   * Opens on ANY end of the bound session - a labelled or unlabelled
   * `session-ended`, the full board reporting the task sessionless, a refused
   * feed past its grace - keyed on the session that ended, in the same
   * id-not-boolean shape as the two latches above and for the same reason:
   * `sessionEnded` stays true for that session forever, so a boolean would
   * re-arm on the next render after the deadline and the card would never
   * reveal. The column latch no longer decides WHETHER something quiet shows,
   * only whether it can show on the move itself (below).
   *
   * It is NOT reset by the successor's bind (the ladder above resets the
   * column latch at the bind, deliberately; this one is left alone there).
   * The bind is a board fact, and it lands a round trip before the
   * successor's first frame exists; letting go then is what showed the old
   * frame, an empty grid and the new frame in sequence. "Awaiting paint" is
   * derived rather than stored: the window is open and the bound session is
   * no longer the one whose end opened it. It closes silently when that
   * successor has settled. At SESSION_SWAP_QUIET_MS with the dead session
   * still bound it does NOT close: the window enters its WAITING phase (the
   * pane cleared to the empty terminal under the same scrim, the footer down
   * to the switcher, Chat and Changes reachable) and stays there until a
   * successor binds, when the deadline restarts for that successor's paint.
   *
   * Never for a task on its way out of this screen (a move to To Do or Done,
   * an archived task; see leaveScreen above).
   *
   * THE MOVE OPENER. The board reports a column move seconds before the
   * session actually ends: the desktop interrupts the agent, waits for a
   * running tool, then suspends (measured live: eight seconds between the
   * move and the end while a typecheck finished). In that window the screen
   * used to show the dying session being interrupted, and the Home row hopped
   * sections. So the window also opens the moment the column latch above
   * opens, on the LIVE session, and the end that follows keeps it open rather
   * than opening a second one. The deadline counts from the END (it restarts
   * on the moving-to-ended flip), because the end is where nothing can be
   * shown; a move whose end has not come by the deadline simply drops the
   * veil - the session is still live and readable - and is not marked spent,
   * so the end re-opens it with a full window of its own.
   */
  const [quietWindowSessionId, setQuietWindowSessionId] = useState<string | null>(null);
  const [spentQuietSessionId, setSpentQuietSessionId] = useState<string | null>(null);
  // The session whose window passed the deadline with it still bound: from
  // then on the pane under the veil is CLEARED to the empty terminal. Kept for
  // the rest of the window, a re-key included (a successor that binds late
  // and dies again paints under the cleared pane, never over the dead
  // frame), and let go only when the window closes.
  const [quietWindowWaitingFor, setQuietWindowWaitingFor] = useState<string | null>(null);
  const quietWindowOpen = quietWindowSessionId !== null;
  const successorBound = quietWindowOpen && sessionId !== null && sessionId !== quietWindowSessionId;
  const successorPainted = useTerminalUiStore((state) =>
    selectTerminalPainted(state, successorBound ? sessionId : null),
  );
  const successorLens = useTranscriptStore((state) => selectChatLens(state, successorBound ? sessionId : null));
  // What "the successor is on screen" means depends on the lens the user is
  // looking at. Terminal: the WebView reported a NON-BLANK paint for it (the
  // terminal pane's hold keeps the old frame until then). Chat: its transcript
  // window landed - the pane skips seeds while it is not the visible page, so
  // a paint can never arrive in chat mode. Changes: never; the veil merely
  // yields there, and closing the window on a diff would put the stale frame
  // back on screen with nothing over it the moment the user returned.
  const successorSettled =
    successorBound &&
    (mode === 'terminal' ? successorPainted : mode === 'chat' ? successorLens !== 'loading' : false);
  if (quietWindowOpen && successorSettled) {
    setSpentQuietSessionId(quietWindowSessionId);
    setQuietWindowSessionId(null);
    setQuietWindowWaitingFor(null);
  } else if (
    sessionEnded &&
    lastBoundSessionId !== null &&
    // Opens when closed, and RE-KEYS when a newer bound session has died
    // while the window was still waiting on the previous one (A ended, B
    // bound, B ended before it painted): the deadline restarts for B.
    lastBoundSessionId !== quietWindowSessionId &&
    lastBoundSessionId !== spentQuietSessionId
  ) {
    if (leaveScreen) {
      // Handled WITHOUT a window: the screen is on its way out. Marked spent
      // because the role checks go inert once the task leaves the board
      // (locatedColumnRole is null then), and without the marker a reset
      // task dropped by the sessions projection would open a veil over its
      // own exit.
      setSpentQuietSessionId(lastBoundSessionId);
    } else {
      setQuietWindowSessionId(lastBoundSessionId);
    }
  } else if (
    !sessionEnded &&
    quietWindowSessionId === null &&
    swapWindowSwimlaneId !== null &&
    swapWindowSwimlaneId !== veiledSwapSwimlaneId &&
    sessionId !== null &&
    sessionId !== spentQuietSessionId &&
    !leaveScreen
  ) {
    // The move opener: the latch already applied the To Do / Done exclusions.
    setVeiledSwapSwimlaneId(swapWindowSwimlaneId);
    setQuietWindowSessionId(sessionId);
  }
  // Whether the pane under the veil is cleared (see quietWindowWaitingFor).
  const quietWindowCleared = quietWindowOpen && quietWindowWaitingFor !== null;
  // Which phase the open window is in, for the deadline: 'moving' while the
  // session it veils is still alive, 'ended' from its end (or a successor's
  // bind) on, 'waiting' once a deadline has passed with the dead session
  // still bound and no successor yet. The flip from moving to ended restarts
  // the deadline; so does a successor binding out of the waiting phase (its
  // paint gets a window of its own); the waiting phase itself has no
  // deadline.
  const quietWindowPhase = !quietWindowOpen
    ? null
    : successorBound
      ? 'ended'
      : quietWindowCleared
        ? 'waiting'
        : sessionEnded
          ? 'ended'
          : 'moving';
  const quietWindowWaiting = quietWindowPhase === 'waiting';
  // Read at fire time by the effects below (synced every render), so they can
  // key on the window alone: an announcement keyed on the label or the focus
  // as well would repeat mid-swap.
  const screenFocused = useScreenFocusActive();
  const swapContextRef = useRef({ hasLabel: false, located: false, focused: true, mode, ended: false });
  useEffect(() => {
    swapContextRef.current = {
      hasLabel: boundSpawnProgressLabel !== null,
      located: taskLocated,
      focused: screenFocused,
      mode,
      ended: sessionEnded,
    };
  });
  // The one deadline (same shape as the latch timer above). What it means
  // depends on the phase it fires in. Ended, with the dead session still
  // bound: the window does not close, it enters the waiting phase and stays
  // there for as long as it takes (the desktop's launch overlay has no
  // deadline either). Ended, with a successor bound but not yet settled: the
  // window closes silently and the pane's own hold carries on, since
  // `sessionEnded` is false for the successor; this is also what bounds a
  // successor that binds out of the waiting phase and never paints. Moving
  // (the end never came): closes WITHOUT being spent, so the end can open its
  // own. Waiting: no timer at all.
  const swapTraceRef = useRef({
    openedAt: 0,
    endedAt: null as number | null,
    bindAt: null as number | null,
    deadlineFor: null as string | null,
  });
  useEffect(() => {
    if (quietWindowSessionId === null || quietWindowPhase === 'waiting') return;
    const waitingOnSessionId = quietWindowSessionId;
    const quietTimer = setTimeout(() => {
      const bound = swapTraceRef.current.bindAt !== null;
      const ended = swapContextRef.current.ended || bound;
      const waiting = ended && !bound;
      traceConnection('session-swap', { phase: 'deadline', bound, ended, waiting });
      if (waiting) {
        setQuietWindowWaitingFor(waitingOnSessionId);
        return;
      }
      if (bound) {
        swapTraceRef.current.deadlineFor = waitingOnSessionId;
        setSpentQuietSessionId(waitingOnSessionId);
      }
      setQuietWindowSessionId(null);
      setQuietWindowWaitingFor(null);
    }, SESSION_SWAP_QUIET_MS);
    return () => clearTimeout(quietTimer);
    // quietWindowPhase is a dependency ON PURPOSE: its moving-to-ended flip
    // is what restarts the deadline from the end, and its waiting-to-ended
    // flip (a late successor binding) is what restarts it for the paint.
  }, [quietWindowSessionId, quietWindowPhase]);
  // The phase flip, once: the pane has cleared and there is nothing on
  // screen to read, so a screen reader hears why (the trace already carries
  // the deadline line above).
  useEffect(() => {
    if (quietWindowWaitingFor === null) return;
    if (swapContextRef.current.focused) {
      AccessibilityInfo.announceForAccessibility(SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL);
    }
  }, [quietWindowWaitingFor]);
  // Once per window, on the WINDOW opening rather than the veil mounting: a
  // Changes round-trip remounts the veil and must not re-announce. The visible
  // surface carries no text, so this announcement is the whole accessibility
  // story (a11y copy is exempt from the no-text ask). Skipped while another
  // route covers this screen.
  useEffect(() => {
    if (quietWindowSessionId === null) return;
    const now = Date.now();
    const openedByEnd = swapContextRef.current.ended;
    swapTraceRef.current = { openedAt: now, endedAt: openedByEnd ? now : null, bindAt: null, deadlineFor: null };
    traceConnection('session-swap', {
      phase: openedByEnd ? 'ended' : 'move',
      hasLabel: swapContextRef.current.hasLabel,
      located: swapContextRef.current.located,
    });
    if (swapContextRef.current.focused) {
      AccessibilityInfo.announceForAccessibility(SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL);
    }
  }, [quietWindowSessionId]);
  // The end arriving inside a window the move opened.
  useEffect(() => {
    if (quietWindowPhase !== 'ended' || swapTraceRef.current.endedAt !== null || successorBound) return;
    const now = Date.now();
    swapTraceRef.current.endedAt = now;
    traceConnection('session-swap', { phase: 'ended', sinceMoveMs: now - swapTraceRef.current.openedAt });
  }, [quietWindowPhase, successorBound]);
  useEffect(() => {
    if (!successorBound) return;
    const now = Date.now();
    const trace = swapTraceRef.current;
    trace.bindAt = now;
    traceConnection('session-swap', {
      phase: 'bind',
      sinceEndedMs: trace.endedAt === null ? 'n/a' : now - trace.endedAt,
      sinceMoveMs: now - trace.openedAt,
    });
  }, [successorBound]);
  useEffect(() => {
    if (spentQuietSessionId === null) return;
    const trace = swapTraceRef.current;
    if (trace.deadlineFor === spentQuietSessionId) return;
    const now = Date.now();
    traceConnection('session-swap', {
      phase: 'settled',
      mode: swapContextRef.current.mode,
      sinceEndedMs: trace.endedAt === null ? 'n/a' : now - trace.endedAt,
      sinceMoveMs: now - trace.openedAt,
      sinceBindMs: trace.bindAt === null ? null : now - trace.bindAt,
    });
    // The other half of the veil's accessibility story: the wait is over.
    if (swapContextRef.current.focused) {
      AccessibilityInfo.announceForAccessibility(SESSION_SWAP_SETTLED_ANNOUNCEMENT);
    }
  }, [spentQuietSessionId]);

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
  // ONE predicate, shared with ChatPane: the parser has to be on exactly when
  // the reading view is on, and computing it twice put them out of step while
  // the window was still loading, re-initialising the WebView for nothing.
  // On displaySessionId, not sessionId: a null id resolves to 'conversation'
  // and would flip the flag under the held pane mid-swap, which the pane
  // treats as a re-init of the dead session from its released ring.
  const chatFallbackActive = useTranscriptStore(
    (state) => selectChatLens(state, displaySessionId) === 'reading-view',
  );
  const agentLabel = useBoardStore((state) => findTaskById(state, taskId)?.task.agent ?? null);

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
    });
  }, [sessionId]);

  const onModeChange = useCallback(
    (nextMode: SessionMode) => {
      setMode(nextMode);
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

  /**
   * The veil yields to the panes the user can still read.
   *
   * It covers the whole pane area at zIndex 2, so switching the mode
   * underneath is not enough: an overlay that kept rendering left the user
   * looking at the same panel they had just tapped out of. No tier caught
   * it - the paired flow asserts `changes-scope` becomes visible, but all
   * three panes are always mounted and only their ACCESSIBILITY visibility
   * follows the mode, so that assertion passed with the pane fully covered.
   * It is the mirror of the stacking bug the veil's own docblock records:
   * that one surfaced because a TAP was swallowed, which is the only way a
   * stacking fault ever shows.
   *
   * Through the quiet phase it yields to Changes only (diffs outlive the
   * session; a swap's successor lands on the terminal and the chat, so those
   * stay covered). Once the pane has cleared it yields to Chat as well: the
   * transcript outlives the session too, and the switcher beneath is how the
   * user gets there. So a cleared window shows the veil in terminal mode
   * alone.
   */
  const overlaysYieldToChanges = mode === 'changes';
  const showQuietVeil =
    quietWindowOpen && !leaveScreen && (quietWindowCleared ? mode === 'terminal' : !overlaysYieldToChanges);
  // The veil occludes the panes, visually and for assistive technology.
  const overlayCoversPanes = showQuietVeil;
  // The footer never leaves. A footer that blinked out the instant the
  // session ended and back on the bind was one of the flashes the veil
  // exists to remove, and in the waiting phase the switcher is how the
  // transcript and the diff stay one tap away, and the way back from them.
  // Through the quiet phase it is held in its pre-swap state but INERT while
  // it points at the dead session (keys to a dead PTY are silently swallowed
  // and the composer would show an error), live again the moment a successor
  // binds, veil or not; in the waiting phase it is the switcher alone, in
  // every mode, since keys and messages have nowhere to go.
  const footerSuspended = quietWindowOpen && !quietWindowWaiting && displaySessionId === quietWindowSessionId;
  const footerSwitcherOnly = quietWindowWaiting;

  return (
    <Screen testID="session-screen">
      <TaskHeader taskTitle={taskTitle} sessionId={displaySessionId} displayId={headerDisplayId} taskId={taskId} />
      {/* behavior="padding" on BOTH platforms: edge-to-edge Android never
          resizes the window for the soft keyboard, so without JS-side
          padding the keyboard fully covers the composer (send button
          unreachable while typing). */}
      <KeyboardAvoidingView style={styles.flex} behavior="padding">
        <View style={styles.flex}>
          {/* All three panes stay mounted (the xterm WebView must never reload
              and the conversation keeps its scroll position), so they are
              absolutely-positioned siblings with only the active one visible
              rather than pages of a pager. This replaced a PagerView that was
              configured scrollEnabled={false}, so it contributed no scrolling
              at all - only page management, which `mode` already does. The
              pager also retained its ViewPager2 through a static
              Choreographer callback in PagerViewViewManagerImpl, which is the
              session-screen retention this change was made to fix. */}
          {/* collapsable={false} keeps this wrapper as a real native view.
              Android view flattening would otherwise dissolve a plain flex
              View, promoting the three panes into the parent alongside the
              overlays - one stacking context, where a pane's zIndex: 1
              outranks an overlay and swallows its taps. Both overlays set
              zIndex: 2 as well, so the fix holds under either reading; this
              keeps the next overlay added over these panes out of the same
              trap. */}
          {/* While the veil covers the panes, take ALL THREE out of the
              accessibility tree. Each pane's own props below follow `mode`
              alone, so the pane the user was last looking at stays exposed
              underneath the scrim: a screen reader swipes straight past the
              overlay into a session that is visually gone and cannot be
              touched. This is the assistive-technology half of the same
              occlusion the overlay's zIndex handles visually, and it needs
              both platforms' props because neither one covers the other. */}
          <View
            style={styles.flex}
            collapsable={false}
            accessibilityElementsHidden={overlayCoversPanes}
            importantForAccessibility={overlayCoversPanes ? 'no-hide-descendants' : 'auto'}
            testID="session-panes"
          >
            <View
              style={[styles.pane, mode === 'terminal' ? styles.paneVisible : styles.paneHidden]}
              pointerEvents={mode === 'terminal' ? 'auto' : 'none'}
              // A hidden pane is still in the view tree, so it has to be taken
              // out of the accessibility tree explicitly - otherwise a screen
              // reader walks all three surfaces and reads the terminal while
              // the user is looking at Chat. Both platforms need their own
              // prop; neither one covers the other.
              accessibilityElementsHidden={mode !== 'terminal'}
              importantForAccessibility={mode === 'terminal' ? 'auto' : 'no-hide-descendants'}
              testID="session-pane-terminal"
            >
              <TerminalTab
                sessionId={displaySessionId}
                active={mode === 'terminal'}
                cleanFeedEnabled={chatFallbackActive}
              />
            </View>
            <View
              style={[styles.pane, mode === 'chat' ? styles.paneVisible : styles.paneHidden]}
              pointerEvents={mode === 'chat' ? 'auto' : 'none'}
              accessibilityElementsHidden={mode !== 'chat'}
              importantForAccessibility={mode === 'chat' ? 'auto' : 'no-hide-descendants'}
              testID="session-pane-chat"
            >
              <ChatPane taskId={taskId} sessionId={displaySessionId} projectId={projectId} agentLabel={agentLabel} />
            </View>
            <View
              style={[styles.pane, mode === 'changes' ? styles.paneVisible : styles.paneHidden]}
              pointerEvents={mode === 'changes' ? 'auto' : 'none'}
              accessibilityElementsHidden={mode !== 'changes'}
              importantForAccessibility={mode === 'changes' ? 'auto' : 'no-hide-descendants'}
              testID="session-pane-changes"
            >
              <ChangesTab taskId={taskId} projectId={projectId} isActive={mode === 'changes'} />
            </View>
          </View>

          {/* Mid-swap the session is over but the TASK is not. The veil is the
              one surface, quiet phase and waiting phase alike; past the
              deadline it clears the pane under itself rather than revealing
              anything. It covers the PANE box only: the footer below is a
              sibling, so the switcher stays beneath it. */}
          {showQuietVeil ? <SessionSwapVeil waiting={quietWindowCleared} /> : null}
        </View>

        {showModeHint ? <ModeToggleHint onDismiss={dismissModeHint} /> : null}
        <SessionInputBar
          sessionId={displaySessionId}
          mode={mode}
          onModeChange={onModeChange}
          chatAttention={chatAttention}
          suspended={footerSuspended}
          switcherOnly={footerSwitcherOnly}
        />
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  // Absolutely positioned so all three panes occupy the same box and stay
  // mounted. Visibility is opacity + zIndex rather than `display: 'none'`,
  // which would drop the WebView's surface and force the terminal to
  // re-create its GL context on every lens switch.
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
});
