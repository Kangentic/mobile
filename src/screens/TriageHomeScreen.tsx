import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import Animated, { ReduceMotion, cancelAnimation, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import type { BoardTaskWire } from '@kangentic/protocol';
import { AppHeader, Screen, ConnectionBanner, EmptyState, Button, SectionHeader, useTheme } from '@/components';
import { TaskCard } from '@/components/board/TaskCard';
import { TaskActionsSheet } from '@/components/board/TaskActionsSheet';
import { MoveTaskSheet } from '@/components/board/MoveTaskSheet';
import { EditTaskSheet } from '@/components/board/EditTaskSheet';
import {
  selectTriageRows,
  sectionForEntry,
  type SessionActivityEntry,
  type TriageSection,
  useActivityStore,
} from '@/state/activityStore';
import { selectColumnsOrdered, selectTasksForColumn, useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import { CapabilityError } from '@/channel';
import {
  archiveTask,
  deleteTaskFromBoard,
  moveTaskOptimistic,
  peekAwaitedPrompt,
  peekLastAssistantMessage,
  peekLastTerminalLine,
  refreshSnapshots,
  updateTaskFields,
} from '@/connection/actions';
import { buildPendingPromptSummary } from '@/conversation/pendingPromptSummary';
import { triggerHaptic } from '@/lib/haptics';
import { AllQuietEmptyState } from './home/AllQuietEmptyState';
import { ConnectingEmptyState } from './home/ConnectingEmptyState';

/** A task targeted for an action from the Triage feed, bundled with its project id - the feed spans multiple projects, unlike the board's single screen-level project. */
interface TriageActionTarget {
  task: BoardTaskWire;
  projectId: string;
}

function messageForActionError(error: unknown, fallback: string): string {
  return error instanceof CapabilityError ? error.message : error instanceof Error ? error.message : fallback;
}

/**
 * A session can briefly outlive its task's board entry (e.g. a snapshot
 * race on cold start), so a located-but-absent task falls back to this
 * minimal stand-in rather than crashing the shared TaskCard.
 */
function fallbackTask(entry: SessionActivityEntry): BoardTaskWire {
  return {
    id: entry.taskId,
    display_id: 0,
    title: 'Untitled task',
    description: '',
    swimlane_id: '',
    position: 0,
    agent: null,
    session_id: entry.sessionId,
    worktree_path: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    base_branch: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    archived_at: null,
    created_at: '',
    updated_at: '',
  };
}

type TriageListRow =
  | { kind: 'section-header'; section: TriageSection; title: string; count: number }
  | { kind: 'activity'; entry: SessionActivityEntry };

// Kangentic's Thinking/Idle is TURN-based, not presence-based (desktop
// vocabulary: the project tooltip counts "N thinking, N idle"). A session
// is Thinking while a turn is in flight; Idle once the turn ends OR a
// prompt waits on the user (desktop counts permission in the idle bucket:
// both mean it is the user's move). Idle therefore ranks ABOVE Thinking,
// and prompt cards render at the top of Idle under the shared header.
const SECTION_ORDER: TriageSection[] = ['needs-you', 'idle', 'working'];
const SECTION_TITLES: Record<TriageSection, string> = {
  'needs-you': 'Idle',
  idle: 'Idle',
  working: 'Thinking',
};

export function TriageHomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const bySessionId = useActivityStore((state) => state.bySessionId);
  const pairedState = useChannelStore((state) => state.pairedState);
  const [refreshing, setRefreshing] = useState(false);

  const collapsedTriageSection = useSettingsStore((state) => state.collapsedTriageSection);

  const rows = useMemo<TriageListRow[]>(() => {
    const sections = selectTriageRows({ bySessionId });
    // Total per TITLE first (needs-you + idle share the "Idle" title), so
    // the header shows the right count even when only one of the two
    // sections underneath it has entries.
    const countByTitle = new Map<string, number>();
    for (const sectionKind of SECTION_ORDER) {
      const section = sections.find((candidate) => candidate.section === sectionKind);
      if (!section) continue;
      const title = SECTION_TITLES[sectionKind];
      countByTitle.set(title, (countByTitle.get(title) ?? 0) + section.entries.length);
    }
    const listRows: TriageListRow[] = [];
    const emittedTitles = new Set<string>();
    for (const sectionKind of SECTION_ORDER) {
      const section = sections.find((candidate) => candidate.section === sectionKind);
      // Empty sections render nothing: the feed leads with what matters
      // instead of headers over blank space. needs-you + idle share the
      // Idle header (one title, prompt cards first).
      if (!section || section.entries.length === 0) continue;
      const title = SECTION_TITLES[section.section];
      if (!emittedTitles.has(title)) {
        emittedTitles.add(title);
        listRows.push({ kind: 'section-header', section: section.section, title, count: countByTitle.get(title) ?? 0 });
      }
      // The header row always renders (so it stays tappable to re-expand);
      // a collapsed title just skips the rows underneath it. No exception
      // for needs-you - a user may want to defer even a pending prompt
      // until they're back at their desk.
      if (collapsedTriageSection === title) continue;
      for (const entry of section.entries) listRows.push({ kind: 'activity', entry });
    }
    return listRows;
  }, [bySessionId, collapsedTriageSection]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refreshSnapshots()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, []);

  const established = useChannelStore((state) => state.established);
  // Gates "All quiet" on real data, not just channel-up: `established` flips
  // true before the first board snapshot lands (bootstrap runs after
  // establishment), so without this the empty feed briefly reads "All
  // quiet" on cold start before the desktop's actual sessions populate it.
  const hasHydratedSnapshot = useBoardStore((state) => state.hasHydratedSnapshot);

  // Long-press hub, reusing the exact same TaskActionsSheet/MoveTaskSheet/
  // EditTaskSheet trio the board uses. Every target bundles its own
  // projectId (rather than one screen-level id, as the board has) since a
  // triage feed spans every paired project at once.
  const boardsByProjectId = useBoardStore((state) => state.boardsByProjectId);
  const [actionsTarget, setActionsTarget] = useState<TriageActionTarget | null>(null);
  const [actionsInFlight, setActionsInFlight] = useState(false);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<TriageActionTarget | null>(null);
  const [moveInFlight, setMoveInFlight] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<TriageActionTarget | null>(null);
  const [editInFlight, setEditInFlight] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  const moveColumns = useMemo(() => {
    const board = moveTarget ? boardsByProjectId[moveTarget.projectId] : null;
    return board ? selectColumnsOrdered(board) : [];
  }, [moveTarget, boardsByProjectId]);
  const actionsArchiveAvailable = useMemo(() => {
    const board = actionsTarget ? boardsByProjectId[actionsTarget.projectId] : null;
    return board ? selectColumnsOrdered(board).some((column) => column.role === 'done') : false;
  }, [actionsTarget, boardsByProjectId]);

  // Stable identity: an inline arrow here would be a fresh prop on every
  // TriageHomeScreen render, which defeats ActivityRow's React.memo for
  // every visible card in the feed.
  const onLongPressTask = useCallback((task: BoardTaskWire, projectId: string) => {
    setActionsError(null);
    setActionsTarget({ task, projectId });
  }, []);

  const onMove = useCallback(
    (targetSwimlaneId: string) => {
      if (!moveTarget) return;
      const board = boardsByProjectId[moveTarget.projectId];
      if (!board) return;
      const targetPosition = selectTasksForColumn(board, targetSwimlaneId).length;
      setMoveInFlight(true);
      setMoveError(null);
      void moveTaskOptimistic({
        projectId: moveTarget.projectId,
        taskId: moveTarget.task.id,
        targetSwimlaneId,
        targetPosition,
      })
        .then(() => {
          triggerHaptic('taskMoved');
          setMoveTarget(null);
        })
        .catch((error: unknown) => {
          setMoveError(error instanceof CapabilityError ? error.message : 'Move failed - check the connection');
        })
        .finally(() => setMoveInFlight(false));
    },
    [moveTarget, boardsByProjectId],
  );

  const onEditSave = useCallback(
    (fields: { title?: string; description?: string }) => {
      if (!editTarget) return;
      setEditInFlight(true);
      setEditError(null);
      void updateTaskFields({ projectId: editTarget.projectId, taskId: editTarget.task.id, ...fields })
        .then(() => setEditTarget(null))
        .catch((error: unknown) => setEditError(messageForActionError(error, 'Edit failed - check the connection')))
        .finally(() => setEditInFlight(false));
    },
    [editTarget],
  );

  const onArchive = useCallback(() => {
    if (!actionsTarget) return;
    setActionsInFlight(true);
    setActionsError(null);
    void archiveTask({ projectId: actionsTarget.projectId, taskId: actionsTarget.task.id })
      .then(() => setActionsTarget(null))
      .catch((error: unknown) => setActionsError(messageForActionError(error, 'Archive failed - check the connection')))
      .finally(() => setActionsInFlight(false));
  }, [actionsTarget]);

  const onDelete = useCallback(() => {
    if (!actionsTarget) return;
    setActionsInFlight(true);
    setActionsError(null);
    void deleteTaskFromBoard({ projectId: actionsTarget.projectId, taskId: actionsTarget.task.id })
      .then(() => {
        triggerHaptic('destructiveConfirmed');
        setActionsTarget(null);
      })
      .catch((error: unknown) => setActionsError(messageForActionError(error, 'Delete failed - check the connection')))
      .finally(() => setActionsInFlight(false));
  }, [actionsTarget]);

  if (pairedState === 'unpaired') {
    return (
      <Screen edges={['left', 'right']}>
        <AppHeader title="Agents" />
        <UnpairedEmptyState />
      </Screen>
    );
  }

  if (rows.length === 0 && established && hasHydratedSnapshot) {
    return (
      <Screen edges={['left', 'right']}>
        <AppHeader title="Agents" />
        <ConnectionBanner />
        <AllQuietEmptyState />
      </Screen>
    );
  }

  // Paired with nothing to show while the channel comes up: the Overseer
  // holds the center (the banner still escalates a long outage to Offline).
  if (rows.length === 0) {
    return (
      <Screen edges={['left', 'right']}>
        <AppHeader title="Agents" />
        <ConnectionBanner />
        <ConnectingEmptyState />
      </Screen>
    );
  }

  return (
    <Screen edges={['left', 'right']}>
      <AppHeader title="Agents" />
      <ConnectionBanner />
      <FlashList<TriageListRow>
        testID="triage-home-list"
        data={rows}
        refreshControl={
          // tintColor styles iOS; colors + progressBackgroundColor style
          // Android (stock is a white circle, jarring on the warm theme).
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.colors.textSecondary}
            colors={[theme.colors.accent]}
            progressBackgroundColor={theme.colors.surfaceOverlay}
          />
        }
        keyExtractor={(row) => (row.kind === 'section-header' ? `section-${row.section}` : row.entry.sessionId)}
        getItemType={(row) => (row.kind === 'section-header' ? 'section-header' : 'activity')}
        renderItem={({ item }) =>
          item.kind === 'section-header' ? (
            <SectionHeader
              title={item.title}
              testID={`section-header-${item.section}`}
              count={item.count}
              collapsed={collapsedTriageSection === item.title}
              onToggle={() => void useSettingsStore.getState().toggleTriageSectionCollapsed(item.title)}
            />
          ) : (
            <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
              <ActivityRow entry={item.entry} onLongPressTask={onLongPressTask} />
            </View>
          )
        }
      />

      <TaskActionsSheet
        visible={actionsTarget !== null}
        task={actionsTarget?.task ?? null}
        archiveAvailable={actionsArchiveAvailable}
        onClose={() => setActionsTarget(null)}
        onMove={() => {
          setMoveError(null);
          setMoveTarget(actionsTarget);
          setActionsTarget(null);
        }}
        onEdit={() => {
          setEditError(null);
          setEditTarget(actionsTarget);
          setActionsTarget(null);
        }}
        onArchive={onArchive}
        onDelete={onDelete}
        actionInFlight={actionsInFlight}
        errorMessage={actionsError}
      />
      <MoveTaskSheet
        visible={moveTarget !== null}
        task={moveTarget?.task ?? null}
        columns={moveColumns}
        onClose={() => setMoveTarget(null)}
        onMove={onMove}
        moveInFlight={moveInFlight}
        errorMessage={moveError}
      />
      <EditTaskSheet
        visible={editTarget !== null}
        task={editTarget?.task ?? null}
        onClose={() => setEditTarget(null)}
        onSave={onEditSave}
        saveInFlight={editInFlight}
        errorMessage={editError}
      />
    </Screen>
  );
}

function UnpairedEmptyState(): React.JSX.Element {
  const router = useRouter();
  return (
    <EmptyState
      testID="unpaired-empty-state"
      title="No desktop paired"
      caption="Steer your agents from anywhere."
      overseerSize={90}
      overseerAnimate="blink-loop"
    >
      <Button label="Pair with your desktop" onPress={() => router.push('/pair')} testID="triage-pair-cta" />
    </EmptyState>
  );
}

/** How long a row waits before retrying a failed snippet peek. */
const SNIPPET_PEEK_RETRY_MS = 6000;

/**
 * While a session is actively working its unread counter bumps on every
 * engine event; a snippet this old is still honest context, and the
 * throttle keeps a busy session from refetching a heavy transcript
 * window per event. Idle rows pass 0: the final message just landed and
 * must be fresh.
 */
const WORKING_SNIPPET_FRESHNESS_MS = 20_000;

/**
 * The landing pulse: a row that just changed sections tints briefly at
 * its new position so the eye can track the move. Marked event-side only
 * (see activityStore.sectionChangedAt), so a reconnect snapshot that
 * reshuffles everything stays silent.
 */
const SECTION_PULSE_WINDOW_MS = 3000;
const SECTION_PULSE_MAX_OPACITY = 0.16;
const SECTION_PULSE_FADE_MS = 700;

const ActivityRow = React.memo(function ActivityRow({
  entry,
  onLongPressTask,
}: {
  entry: SessionActivityEntry;
  onLongPressTask: (task: BoardTaskWire, projectId: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  // The full task (not just title): the Agents feed renders the EXACT SAME
  // card as the board - labels, PR, usage bar - via the same shared
  // TaskCard, plus the project name sharing the title row (the
  // board's only structural addition). The ticket number is the one
  // deliberate exception: a triage feed cares about status/title/last
  // message, not the ticket ID, so it is always off here regardless of the
  // board's own showTicketNumbers setting (the board is the ticket-reference
  // view). That also keeps the fallback stand-in's placeholder display_id
  // off screen. A session can outlive its task's board entry briefly (e.g. a
  // snapshot race), so a located-but-absent task falls back to that minimal
  // stand-in rather than crashing.
  const locatedTask = useBoardStore((state) => state.boardsByProjectId[entry.projectId]?.tasksById[entry.taskId] ?? null);
  const task = locatedTask ?? fallbackTask(entry);
  const projectName = useBoardStore(
    (state) => state.projects.find((project) => project.id === entry.projectId)?.name ?? null,
  );

  const section = sectionForEntry(entry);
  const working = section === 'working';
  const isPermission = section === 'needs-you';

  const openTask = useCallback(() => {
    router.push({
      pathname: '/task/[taskId]',
      // A prompt-pending row lands on the chat lens, where the answerable
      // prompt card lives; everything else opens the terminal default.
      params: isPermission
        ? { taskId: entry.taskId, sessionId: entry.sessionId, projectId: entry.projectId, mode: 'chat' }
        : { taskId: entry.taskId, sessionId: entry.sessionId, projectId: entry.projectId },
    });
  }, [router, entry.taskId, entry.sessionId, entry.projectId, isPermission]);

  const onLongPress = useCallback(() => {
    onLongPressTask(task, entry.projectId);
  }, [onLongPressTask, task, entry.projectId]);

  // Desktop-parity status treatment: green spinner while the agent works,
  // the yellow mail envelope for EVERY idle session (a pending prompt is
  // idle too - all idle rows are equal priority, first come first served).
  const statusKind = working ? 'working' : entry.unreadCount > 0 ? 'idle-unread' : 'idle';

  // One subtle tint fade when the row lands in a new section. The cleanup
  // zeroes the shared value: FlashList recycles row instances, and a
  // reused card must never inherit a mid-flight pulse.
  const sectionChangedAt = entry.sectionChangedAt;
  const pulseOpacity = useSharedValue(0);
  useEffect(() => {
    if (sectionChangedAt !== null && Date.now() - sectionChangedAt < SECTION_PULSE_WINDOW_MS) {
      pulseOpacity.value = SECTION_PULSE_MAX_OPACITY;
      pulseOpacity.value = withTiming(0, { duration: SECTION_PULSE_FADE_MS, reduceMotion: ReduceMotion.System });
    }
    return () => {
      cancelAnimation(pulseOpacity);
      pulseOpacity.value = 0;
    };
  }, [sectionChangedAt, pulseOpacity]);
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulseOpacity.value }));

  // Inbox-style snippet, the row's body for EVERY state: the pending
  // decision when a prompt waits, otherwise the agent's last message
  // (context for thinking rows too). The peek result records WHICH
  // refresh key it belongs to (the prompt id, or unreadCount which bumps
  // on new messages), so re-renders never refetch.
  const awaitedPromptId = entry.awaitedPromptId;
  const snippetKey = isPermission ? `prompt:${awaitedPromptId}` : `message:${entry.sessionId}:${entry.unreadCount}`;
  const [peekedSnippet, setPeekedSnippet] = useState<{ key: string; text: string | null } | null>(null);
  const [peekRetryNonce, setPeekRetryNonce] = useState(0);
  const snippet = peekedSnippet !== null && peekedSnippet.key === snippetKey ? peekedSnippet.text : null;
  // While working, a slightly stale snippet is fine (the throttle stops a
  // busy session from refetching a heavy window on every event); at idle
  // the final message must be fresh, and the freshness flip on the
  // working-to-idle transition refires the effect to fetch it.
  const snippetFreshnessMs = working ? WORKING_SNIPPET_FRESHNESS_MS : 0;
  useEffect(() => {
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const currentKey = isPermission ? `prompt:${awaitedPromptId}` : `message:${entry.sessionId}:${entry.unreadCount}`;
    const peek =
      isPermission && awaitedPromptId !== null
        ? peekAwaitedPrompt(entry.sessionId, awaitedPromptId).then((toolUse) => buildPendingPromptSummary(toolUse))
        : (async () => {
            // Transcript-less agents (codex-style) still stream a PTY, and
            // a huge session's window fetch can fail outright: either way
            // fall back to the last readable terminal line, and treat a
            // failed fetch with no fallback as retryable, not as "no
            // preview" (successes cache, so a stuck blank never heals on
            // its own).
            let messagePeekFailed = false;
            const messageText = await peekLastAssistantMessage(entry.sessionId, snippetFreshnessMs).catch(() => {
              messagePeekFailed = true;
              return null;
            });
            const snippetText = messageText ?? (await peekLastTerminalLine(entry.sessionId, snippetFreshnessMs));
            if (snippetText === null && messagePeekFailed) throw new Error('snippet peek failed');
            return snippetText;
          })();
    void peek
      .then((snippetText) => {
        if (!cancelled) setPeekedSnippet({ key: currentKey, text: snippetText });
      })
      .catch(() => {
        // Not connected yet or a transient fetch failure: retry shortly.
        // The loop self-terminates on the first resolved peek (results
        // cache by key, so repeat runs after that are free).
        if (!cancelled) {
          retryTimer = setTimeout(() => setPeekRetryNonce((nonce) => nonce + 1), SNIPPET_PEEK_RETRY_MS);
        }
      });
    return () => {
      cancelled = true;
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [entry.sessionId, entry.unreadCount, isPermission, awaitedPromptId, peekRetryNonce, snippetFreshnessMs]);

  // No status filler ("Thinking", "Waiting for..."): the section header
  // and the icon already say the state. PREDICTABLE GEOMETRY: the snippet
  // always renders (one reserved line minimum, flexing to two when the
  // message needs it), so an async update adjusts a card at most once -
  // and never collapses a slot a thumb is heading for.
  const snippetLineHeight = theme.typography.caption.lineHeight;
  const testID = `activity-row-${entry.sessionId}`;
  return (
    <TaskCard
      testID={testID}
      task={task}
      statusKind={statusKind}
      showTicketNumbers={false}
      usage={entry.usage}
      projectName={projectName}
      bodyText={snippet ?? ''}
      bodyMinHeight={snippetLineHeight}
      onPress={openTask}
      onLongPress={onLongPress}
      overlay={
        <Animated.View
          pointerEvents="none"
          testID={`${testID}-pulse`}
          style={[styles.pulseOverlay, { backgroundColor: theme.colors.accent, borderRadius: theme.radii.md }, pulseStyle]}
        />
      }
    />
  );
});

const styles = StyleSheet.create({
  pulseOverlay: {
    bottom: 0,
    left: 0,
    position: 'absolute',
    right: 0,
    top: 0,
  },
});
