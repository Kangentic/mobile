import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import Animated, { ReduceMotion, cancelAnimation, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { AgentStatusIcon, AppHeader, Screen, Card, ConnectionBanner, EmptyState, Icon, Row, Stack, Text, Badge, Button, SectionHeader, useTheme } from '@/components';
import {
  selectTriageRows,
  sectionForEntry,
  type SessionActivityEntry,
  type TriageSection,
  useActivityStore,
} from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import { peekAwaitedPrompt, peekLastAssistantMessage, peekLastTerminalLine, refreshSnapshots } from '@/connection/actions';
import { buildPendingPromptSummary } from '@/conversation/pendingPromptSummary';
import { AllQuietEmptyState } from './home/AllQuietEmptyState';
import { ConnectingEmptyState } from './home/ConnectingEmptyState';

type TriageListRow =
  | { kind: 'section-header'; section: TriageSection; title: string }
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

/** Inbox recency, long form: 'just now', then minutes/hours/days ago. */
function relativeTimeLabel(epochMs: number, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - epochMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export function TriageHomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const bySessionId = useActivityStore((state) => state.bySessionId);
  const pairedState = useChannelStore((state) => state.pairedState);
  const [refreshing, setRefreshing] = useState(false);

  // Recency labels tick once a minute (Date.now is impure in render, so
  // the clock lives in state and updates from the interval callback).
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const ticker = setInterval(() => setNowMs(Date.now()), 60_000);
    return () => clearInterval(ticker);
  }, []);

  const rows = useMemo<TriageListRow[]>(() => {
    const sections = selectTriageRows({ bySessionId });
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
        listRows.push({ kind: 'section-header', section: section.section, title });
      }
      for (const entry of section.entries) listRows.push({ kind: 'activity', entry });
    }
    return listRows;
  }, [bySessionId]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refreshSnapshots()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, []);

  const established = useChannelStore((state) => state.established);

  if (pairedState === 'unpaired') {
    return (
      <Screen edges={['left', 'right']}>
        <AppHeader title="Agents" />
        <UnpairedEmptyState />
      </Screen>
    );
  }

  if (rows.length === 0 && established) {
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
            <SectionHeader title={item.title} testID={`section-header-${item.section}`} />
          ) : (
            <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
              <ActivityRow entry={item.entry} nowMs={nowMs} />
            </View>
          )
        }
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

/** Title-row height: fits the pills/badges so their arrival never reflows. */
const ROW_TITLE_MIN_HEIGHT = 24;

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
  nowMs,
}: {
  entry: SessionActivityEntry;
  nowMs: number;
}): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const taskTitle = useBoardStore((state) => {
    const board = state.boardsByProjectId[entry.projectId];
    return board?.tasksById[entry.taskId]?.title ?? null;
  });
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
  // and the icon already say the state. The row is title + project pill +
  // a two-line last-message snippet + recency.
  //
  // PREDICTABLE GEOMETRY: the snippet always renders (one reserved line
  // minimum, flexing to two when the message needs it) and the title row
  // has a constant min-height that fits the pills, so an async update
  // adjusts a card at most once - and never collapses a slot a thumb is
  // heading for.
  const snippetLineHeight = theme.typography.caption.lineHeight;
  return (
    <Card testID={`activity-row-${entry.sessionId}`} onPress={openTask}>
      <Animated.View
        pointerEvents="none"
        testID={`activity-row-${entry.sessionId}-pulse`}
        style={[
          styles.pulseOverlay,
          { backgroundColor: theme.colors.accent, borderRadius: theme.radii.md },
          pulseStyle,
        ]}
      />
      <Stack gap="xs">
        <Row gap="sm" style={[styles.spaceBetween, { minHeight: ROW_TITLE_MIN_HEIGHT }]}>
          <AgentStatusIcon kind={statusKind} testID={`activity-row-${entry.sessionId}-status`} />
          <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
            {taskTitle ?? 'Untitled task'}
          </Text>
          {/* No unread counter: activity volume while working is noise, and
              the snippet already carries what happened. */}
          {projectName ? <Badge label={projectName} color="primary" outlined /> : null}
        </Row>
        <Text
          variant="caption"
          color="muted"
          numberOfLines={2}
          style={{ minHeight: snippetLineHeight }}
          testID={`activity-row-${entry.sessionId}-snippet`}
        >
          {snippet ?? ''}
        </Text>
        {/* The utility strip: separated from content by a hairline. */}
        <Row
          gap="sm"
          style={[
            styles.timeRow,
            { borderTopColor: theme.colors.border, paddingTop: theme.spacing.sm, marginTop: theme.spacing.xs },
          ]}
        >
          <Text variant="caption" color="muted" style={styles.flex} testID={`activity-row-${entry.sessionId}-time`}>
            {relativeTimeLabel(entry.lastEventAt, nowMs)}
          </Text>
          <Icon name="chevron-forward" color="muted" size={14} />
        </Row>
      </Stack>
    </Card>
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
  spaceBetween: {
    justifyContent: 'space-between',
  },
  timeRow: {
    alignItems: 'center',
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  flex: {
    flex: 1,
  },
});
