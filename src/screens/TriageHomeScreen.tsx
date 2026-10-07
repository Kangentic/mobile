import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  RefreshControl,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { useRouter } from 'expo-router';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import type { BoardTaskWire } from '@kangentic/protocol';
import { AppHeader, Screen, ConnectionBanner, EmptyState, Button, NowTickProvider, SectionHeader, useTheme } from '@/components';
import type { AgentStatusKind } from '@/components/AgentStatusIcon';
import { TaskCard } from '@/components/board/TaskCard';
import { cardSessionDisplay, toCardSession } from '@/components/board/cardSessionDisplay';
import { buildJourneyTrack } from '@/components/board/columnTrack';
import {
  FEED_SECTION_ORDER,
  FEED_SECTION_TITLES,
  feedRowKey,
  selectFeedSections,
  type FeedRow,
  type FeedSection,
  type FeedSectionSources,
} from '@/screens/home/feedSections';
import {
  selectTaskRespawn,
  selectWaitingSince,
  sectionForEntry,
  type SessionActivityEntry,
  useActivityStore,
} from '@/state/activityStore';
import { selectTaskColumn, useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import { useSettingsStore } from '@/state/settingsStore';
import {
  peekAwaitedPrompt,
  peekLastAssistantMessage,
  peekLastTerminalLine,
  refreshSnapshots,
} from '@/connection/actions';
import { buildPendingPromptSummary, collapseToSnippetText } from '@/conversation/pendingPromptSummary';
import { createBoundedTaskQueue, type BoundedTaskQueue } from '@/lib/boundedTaskQueue';
import { subscribeToMemoryPressure } from '@/observability/memoryPressure';
import { MapperLoad } from '@/devsupport/MapperLoad';
import { useConcurrencyProbeDepth } from '@/devsupport/concurrencyProbe';
import { AllQuietEmptyState } from './home/AllQuietEmptyState';
import { ConnectingEmptyState } from './home/ConnectingEmptyState';
import { FilteredEmptyState } from './home/FilteredEmptyState';
import { SectionFilterButton } from './home/SectionFilterButton';
import { SectionLandingPulse } from './home/SectionLandingPulse';

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
    pr_merge_readiness: null,
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
  | { kind: 'section-header'; section: FeedSection; title: string; count: number; alwaysOpen: boolean }
  | FeedRow;

/** The four store slices `selectFeedSections` reads, from outside React (the snippet warm-up's effect). */
function currentFeedSources(): FeedSectionSources {
  const activityState = useActivityStore.getState();
  return {
    bySessionId: activityState.bySessionId,
    respawnByTaskId: activityState.respawnByTaskId,
    spawnProgressLabelBySessionId: activityState.spawnProgressLabelBySessionId,
    boardsByProjectId: useBoardStore.getState().boardsByProjectId,
  };
}

export function TriageHomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const bySessionId = useActivityStore((state) => state.bySessionId);
  // The rest of what decides a row's SECTION (feedSections): the respawn in
  // flight and the labelled ends say whether a preparing card was running or
  // paused, and the boards carry the 0.16.0 `spawn_progress` / `resumable`
  // fields plus the sessionless task rows. The boards change on every
  // snapshot, so the memo below re-runs on each one as well as on each
  // activity event (read from the code; its cost is not measured).
  const respawnByTaskId = useActivityStore((state) => state.respawnByTaskId);
  const spawnProgressLabelBySessionId = useActivityStore((state) => state.spawnProgressLabelBySessionId);
  const boardsByProjectId = useBoardStore((state) => state.boardsByProjectId);
  const pairedState = useChannelStore((state) => state.pairedState);
  const [refreshing, setRefreshing] = useState(false);

  const collapsedTriageSections = useSettingsStore((state) => state.collapsedTriageSections);
  // The section filter (SectionFilterScreen). A hidden section draws neither
  // its header nor its rows, where a collapsed one keeps its header.
  const hiddenTriageSections = useSettingsStore((state) => state.hiddenTriageSections);

  const { rows, feedRowCount } = useMemo(() => {
    const sections = selectFeedSections({ bySessionId, respawnByTaskId, spawnProgressLabelBySessionId, boardsByProjectId });
    // Total per TITLE first (needs-you + idle share the "Idle" title), so
    // the header shows the right count even when only one of the two
    // sections underneath it has entries.
    const countByTitle = new Map<string, number>();
    let totalRows = 0;
    for (const sectionKind of FEED_SECTION_ORDER) {
      const section = sections.find((candidate) => candidate.section === sectionKind);
      if (!section) continue;
      const title = FEED_SECTION_TITLES[sectionKind];
      countByTitle.set(title, (countByTitle.get(title) ?? 0) + section.rows.length);
      totalRows += section.rows.length;
    }
    // The titles that draw at all: a section with rows that the filter shows.
    const shownTitles = new Set<string>();
    for (const section of sections) {
      if (section.rows.length === 0) continue;
      const title = FEED_SECTION_TITLES[section.section];
      if (!hiddenTriageSections.includes(title)) shownTitles.add(title);
    }
    // The only section on screen is always open, whatever its stored collapse:
    // collapsed, it was the whole feed reduced to one header over an empty
    // page (reported on the Pixel: Idle and Active shown, Active collapsed, no
    // agent idle). The stored preference is untouched, so it applies again
    // the moment a second section has rows.
    const loneTitle = shownTitles.size === 1 ? ([...shownTitles][0] ?? null) : null;
    const listRows: TriageListRow[] = [];
    const emittedTitles = new Set<string>();
    for (const sectionKind of FEED_SECTION_ORDER) {
      const section = sections.find((candidate) => candidate.section === sectionKind);
      // Empty sections render nothing: the feed leads with what matters
      // instead of headers over blank space. needs-you + idle share the
      // Idle header (one title, prompt cards first).
      if (!section || section.rows.length === 0) continue;
      const title = FEED_SECTION_TITLES[section.section];
      if (hiddenTriageSections.includes(title)) continue;
      const alwaysOpen = title === loneTitle;
      if (!emittedTitles.has(title)) {
        emittedTitles.add(title);
        listRows.push({ kind: 'section-header', section: section.section, title, count: countByTitle.get(title) ?? 0, alwaysOpen });
      }
      // The header row always renders (so it stays tappable to re-expand,
      // except the lone section's, which is held open and never collapses);
      // a collapsed title just skips the rows underneath it. No exception
      // for needs-you - a user may want to defer even a pending prompt
      // until they're back at their desk.
      if (!alwaysOpen && collapsedTriageSections.includes(title)) continue;
      for (const row of section.rows) listRows.push(row);
    }
    return { rows: listRows, feedRowCount: totalRows };
  }, [bySessionId, respawnByTaskId, spawnProgressLabelBySessionId, boardsByProjectId, collapsedTriageSections, hiddenTriageSections]);

  // Whether anything on screen actually needs a clock. Correct for an empty or
  // all-working feed and nothing more: one idle session makes it true, and a
  // feed of idle sessions is the case this screen exists for. The provider's
  // focus gate is what stops the timer in practice.
  const anySessionWaiting = useMemo(
    () => Object.values(bySessionId).some((entry) => selectWaitingSince(entry) !== null),
    [bySessionId],
  );

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
  /**
   * Reveal the feed once, assembled - not row by row as it arrives.
   *
   * The bootstrap declares EVERY project's board desired, and each board
   * answers in its own round-trip. `hasHydratedSnapshot` flips on the first
   * one, so the feed used to paint a fraction of its rows and then grow once
   * per remaining project, re-sorting and re-anchoring each time. Cold start
   * read as agents flickering in and the page lurching. Worse, if the first
   * board to answer had no live session the feed briefly claimed "All quiet"
   * while the rest were still in flight.
   *
   * `projects` is the declared set, so "every project has a board" is an
   * exact completion signal rather than a guessed delay. The deadline is only
   * a floor under a project that is slow or never answers.
   */
  const allBoardsAnswered = useBoardStore(
    (state) => state.projects.length > 0 && state.projects.every((project) => state.boardsByProjectId[project.id] !== undefined),
  );
  // Monotonic: the deadline only ever passes. Never reset on a disconnect -
  // a reconnect should resume the assembled feed, not blank it back to the
  // connecting state, and it also keeps a later project-list refresh (which
  // briefly makes allBoardsAnswered false again) from doing the same.
  const [revealDeadlinePassed, setRevealDeadlinePassed] = useState(false);
  useEffect(() => {
    if (!established || revealDeadlinePassed) return undefined;
    const timer = setTimeout(() => setRevealDeadlinePassed(true), FEED_REVEAL_DEADLINE_MS);
    return () => clearTimeout(timer);
  }, [established, revealDeadlinePassed]);

  /**
   * Warm each session's snippet as soon as that session is known, rather than
   * when its row mounts.
   *
   * Waiting only on the boards revealed a complete, correctly ordered feed
   * whose description slots were all still EMPTY, and a beat later every one
   * of them filled in at once - the slots are fixed-height so nothing moved,
   * but the text still arrived as a second wave. Sessions register as each
   * board snapshot lands, so starting their peeks here overlaps them with the
   * remaining board round-trips and they are normally resolved by the time
   * the feed reveals; the row's own peek then hits the cache and paints in
   * its first frame.
   *
   * Deliberately does NOT gate the reveal. Whether you can see your agents at
   * all must not depend on a transcript-window fetch succeeding - a slow peek
   * should cost one row's snippet, not the whole feed.
   *
   * BOUNDED, and that bound is the whole point. This used to be a bare `for`
   * loop firing every peek unawaited, so a user with many live agents issued
   * one transcript-window fetch PER SESSION simultaneously. Those entries
   * carry full tool inputs and results and are bounded only by the protocol's
   * per-frame 4 MiB decoded cap - there is no aggregate bound anywhere - and
   * each one inflates to a byte array, then a UTF-16 string, then a parsed
   * object graph. Nothing retains any of it (this screen retains nothing), so
   * it never read as a leak; it was peak SIMULTANEOUS TRANSIENT allocation
   * that scaled linearly with fleet size, which is what a foreground
   * out-of-memory kill on a memory-tight device looks like. Sentry MOBILE-8 is
   * the report that led here. The queue makes the peak a constant.
   */
  const concurrencyProbeDepth = useConcurrencyProbeDepth();
  const warmedSessionIdsRef = useRef(new Set<string>());
  const warmQueueRef = useRef<BoundedTaskQueue | null>(null);
  warmQueueRef.current ??= createBoundedTaskQueue(concurrencyProbeDepth ?? SNIPPET_WARM_CONCURRENCY);

  // The A/B knob, inert outside a probe build. `setMaxConcurrent` rather than a
  // fresh queue: a replacement starts at activeCount 0 while the original's
  // tasks are still running, so the two together would exceed either depth and
  // the arm would measure something that never ships. See boundedTaskQueue.
  useEffect(() => {
    warmQueueRef.current?.setMaxConcurrent(concurrencyProbeDepth ?? SNIPPET_WARM_CONCURRENCY);
  }, [concurrencyProbeDepth]);

  // Under memory pressure, stop feeding the queue. Warms not yet started are
  // pure optimisation - every row fetches its own snippet when it mounts,
  // consulting its own caches and not this set - so dropping them costs
  // latency and nothing else, while removing the largest discretionary
  // allocator on this screen at the moment the OS says it is short.
  // `warmedSessionIdsRef` is deliberately NOT cleared: re-enqueueing dropped
  // sessions is the one thing that would undo the saving.
  //
  // Fires on EVERY severity, unlike the store shedders, which wait for
  // 'serious'. The asymmetry is deliberate and follows the cost: dropping a
  // queued warm costs one snippet arriving a beat later, while dropping a
  // transcript costs a visible refetch of something the user may be reading. So
  // the cheap reaction takes the earliest hint and the expensive one does not.
  useEffect(() => subscribeToMemoryPressure(() => warmQueueRef.current?.clear()), []);
  // The effect below needs to run when the SET of sessions changes, so this
  // selector has to be set-valued. It must NOT be reduced to a count: a
  // snapshot that drops one session and adds another leaves the count
  // identical, and the new session would then never be warmed. Returning a
  // joined string rather than an array is also deliberate - a fresh array
  // identity every call would defeat Zustand's equality check and re-render
  // the feed on every activity event.
  const knownSessionIds = useActivityStore((state) => Object.keys(state.bySessionId).sort().join(','));
  useEffect(() => {
    if (!established) return;
    const warmQueue = warmQueueRef.current;
    if (warmQueue === null) return;
    // Enqueue in FEED order, not hash order, so the sessions a user is about
    // to look at are warmed first. Recomputed from the store rather than read
    // off the `rows` memo on purpose: depending on `rows` would re-run this
    // effect on every activity event, which is exactly what the set-valued
    // `knownSessionIds` selector above exists to avoid.
    //
    // This changes the ORDER and nothing else. `selectFeedSections` partitions
    // every entry into exactly one of the closed `FeedSection` union's members,
    // and FEED_SECTION_ORDER lists them all - so every session the previous
    // `Object.values(bySessionId)` loop reached is still reached exactly once.
    // A future section added to the union without being added to
    // FEED_SECTION_ORDER would silently stop warming its sessions.
    const sections = selectFeedSections(currentFeedSources());
    // A section the filter hides mounts no rows, so its snippets would be
    // fetched for nothing; unhiding it mounts the rows, which peek for
    // themselves.
    const hiddenTitles = useSettingsStore.getState().hiddenTriageSections;
    for (const sectionKind of FEED_SECTION_ORDER) {
      const section = sections.find((candidate) => candidate.section === sectionKind);
      if (!section) continue;
      if (hiddenTitles.includes(FEED_SECTION_TITLES[sectionKind])) continue;
      for (const row of section.rows) {
        // A task row has no session, so there is nothing to peek.
        if (row.kind !== 'session') continue;
        const entry = row.entry;
        if (warmedSessionIdsRef.current.has(entry.sessionId)) continue;
        // A queued or paused card shows the task's description, never the
        // agent's message (ActivityRow), so a warm would fetch a line nothing
        // draws.
        if (entry.sessionStatus === 'queued' || entry.sessionStatus === 'suspended') continue;
        // An ended session has nothing left to peek: the desktop tore its
        // read-stream subscription down, so this would be a request that can
        // only fail. Such an entry used to be pruned within a few hundred ms
        // and the loop rarely saw one - it is now RETAINED for the length of a
        // swap (see reconcileSessionsFromBoards), so without this every swap
        // would enqueue a doomed peek. The row keeps the body it already had.
        if (entry.feedStatus === 'ended') continue;
        // Already pushed by a 0.8.0+ desktop: warming it would re-fetch, over
        // the wire, the exact line we were just handed for free.
        if (entry.messagePreview !== null && sectionForEntry(entry) !== 'needs-you') continue;
        warmedSessionIdsRef.current.add(entry.sessionId);
        const sessionId = entry.sessionId;
        const awaitedPromptId = entry.awaitedPromptId;
        const isPermission = sectionForEntry(entry) === 'needs-you';
        warmQueue.enqueue(() =>
          // No terminal fallback here: see peekSnippet. The row asks again
          // with it enabled once it mounts.
          peekSnippet(sessionId, awaitedPromptId, isPermission, 0, false).catch(() => {
            // The row retries on its own once mounted; a failed warm just
            // means that one snippet arrives late.
            warmedSessionIdsRef.current.delete(sessionId);
          }),
        );
      }
    }
  }, [knownSessionIds, established]);

  const feedReady = allBoardsAnswered || revealDeadlinePassed;

  // Long-press hub, the same form-sheet route the board uses. The row carries
  // its OWN projectId (rather than one screen-level id, as the board has)
  // because a triage feed spans every paired project at once.
  //
  // Stable identity: an inline arrow here would be a fresh prop on every
  // TriageHomeScreen render, which defeats ActivityRow's React.memo for
  // every visible card in the feed.
  const onLongPressTask = useCallback(
    (task: BoardTaskWire, projectId: string) => {
      router.push({ pathname: '/task-actions', params: { taskId: task.id, projectId } });
    },
    [router],
  );


  /**
   * The feed leads with what needs the user: Needs You, then Idle, then the
   * agents that are still working. Rows arrive incrementally as the snapshot
   * lands, and FlashList v2 enables maintainVisibleContentPosition by
   * default, so it holds whatever row it first anchored while higher-priority
   * rows insert ABOVE it - with 8+ agents the feed opened parked at the
   * bottom, showing the working sessions and hiding the ones waiting on you.
   * Pin to the top until the user scrolls, then leave them alone.
   */
  const listRef = useRef<FlashListRef<TriageListRow>>(null);
  /**
   * Whether the list is currently resting at the top, recomputed from the
   * scroll offset rather than latched the first time the user drags.
   *
   * A one-way latch would be safe only by accident: it happens to protect a
   * user who has scrolled, but it makes "at the top" a one-time event, and
   * anything that remounted the screen would re-arm it under someone who had
   * deliberately scrolled away. Reading the position instead makes the rule
   * exact and self-correcting - at the top, new rows keep you at the top;
   * scrolled away, nothing moves you; scroll back up and pinning resumes.
   *
   * It is the same contract the conversation feed gets from
   * maintainVisibleContentPosition's autoscrollToBottomThreshold, on the
   * opposite edge: pinned while you sit at the edge, released the moment you
   * leave it.
   */
  const restingAtTopRef = useRef(true);
  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    restingAtTopRef.current = event.nativeEvent.contentOffset.y <= TOP_ANCHOR_TOLERANCE_PX;
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (!restingAtTopRef.current) return;
    listRef.current?.scrollToOffset({ offset: 0, animated: false });
  }, []);

  if (pairedState === 'unpaired') {
    return (
      <Screen edges={['left', 'right']}>
        <AppHeader title="Agents" />
        <UnpairedEmptyState />
      </Screen>
    );
  }

  // Paired: the header carries the section filter in every state, so a
  // preference can be set before anything is running.
  const header = <AppHeader title="Agents" actions={<SectionFilterButton />} />;

  if (rows.length === 0 && established && hasHydratedSnapshot && feedReady) {
    return (
      <Screen edges={['left', 'right']}>
        {header}
        <ConnectionBanner />
        {/* Nothing drawn because the filter hides it is not "All quiet". */}
        {feedRowCount > 0 && hiddenTriageSections.length > 0 ? <FilteredEmptyState /> : <AllQuietEmptyState />}
      </Screen>
    );
  }

  // Paired with nothing to show while the channel comes up, or with the board
  // fan-out still landing: the Overseer holds the center (the banner still
  // escalates a long outage to Offline).
  if (rows.length === 0 || !feedReady) {
    return (
      <Screen edges={['left', 'right']}>
        {header}
        <ConnectionBanner />
        <ConnectingEmptyState />
      </Screen>
    );
  }

  return (
    <Screen edges={['left', 'right']}>
      {header}
      <ConnectionBanner />
      {/* One clock for the whole feed. Wrapping the list rather than each row
          is the point: N rows showing the same instant need one timer, not N,
          and only the rows that actually render a time subscribe to it. It
          renders no view of its own, so the list's layout is unchanged. */}
      <NowTickProvider enabled={anySessionWaiting}>
        <FlashList<TriageListRow>
          ref={listRef}
          testID="triage-home-list"
          data={rows}
          onScroll={onScroll}
          scrollEventThrottle={64}
          onContentSizeChange={onContentSizeChange}
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
          keyExtractor={(row) => (row.kind === 'section-header' ? `section-${row.section}` : feedRowKey(row))}
          getItemType={(row) => row.kind}
          renderItem={({ item }) =>
            item.kind === 'section-header' ? (
              <SectionHeader
                title={item.title}
                // Keyed by the TITLE the user sees, not the underlying section.
                // "Idle" is shared by needs-you and idle, and which of the two
                // leads changes as a prompt arrives or resolves - so a
                // section-keyed id silently renames itself mid-session, which is
                // exactly the kind of moving selector an E2E flow cannot hold.
                // The collapse state is title-keyed for the same reason.
                testID={`section-header-${item.title.toLowerCase()}`}
                count={item.count}
                alwaysOpen={item.alwaysOpen}
                collapsed={collapsedTriageSections.includes(item.title)}
                onToggle={() => void useSettingsStore.getState().toggleTriageSectionCollapsed(item.title)}
              />
            ) : item.kind === 'session' ? (
              <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
                <ActivityRow entry={item.entry} onLongPressTask={onLongPressTask} />
              </View>
            ) : (
              <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
                <SessionlessTaskRow task={item.task} projectId={item.projectId} onLongPressTask={onLongPressTask} />
              </View>
            )
          }
        />
      </NowTickProvider>
    </Screen>
  );
}

function UnpairedEmptyState(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  return (
    <EmptyState
      testID="unpaired-empty-state"
      title="No desktop paired"
      caption="Connect your phone to Kangentic."
      overseerSize={90}
      overseerAnimate="blink-loop"
    >
      {/* Short label ("Pair") would hug tight; widen it into a substantial
          primary CTA - the hero action of this setup screen. */}
      <Button
        label="Pair"
        onPress={() => router.push('/pair')}
        testID="triage-pair-cta"
        style={{ paddingHorizontal: theme.spacing.xxl * 2 }}
      />
    </EmptyState>
  );
}

/** Lines the snippet slot always occupies, whatever it currently holds (see the row's fixed-geometry note). */
const SNIPPET_LINES = 2;

/**
 * How long the feed waits for every declared board before revealing itself
 * anyway. Only a floor under a project that is slow or never answers - the
 * normal path reveals as soon as the last board lands.
 */
const FEED_REVEAL_DEADLINE_MS = 2500;

/**
 * How far from offset 0 still counts as "resting at the top" for the feed's
 * anchor. Small on purpose: enough to absorb overscroll bounce and rounding,
 * not enough to grab someone who has deliberately scrolled down a little.
 */
const TOP_ANCHOR_TOLERANCE_PX = 8;


/** How long a row waits before retrying a failed snippet peek. */
const SNIPPET_PEEK_RETRY_MS = 6000;

/**
 * How long the snippet key must hold still before the row fetches it.
 *
 * The key carries unreadCount, which climbs once per engine event. A fresh
 * launch (and any catch-up burst) delivers those events back-to-back, so an
 * unsettled fetch painted a DIFFERENT older message per increment and the
 * row visibly flickered through the backlog. Waiting for the burst to stop
 * means one fetch, of the final state, and a row that fills in once.
 */
const SNIPPET_SETTLE_MS = 350;

/**
 * While a session is actively working its unread counter bumps on every
 * engine event; a snippet this old is still honest context, and the
 * throttle keeps a busy session from refetching a heavy transcript
 * window per event. Idle rows pass 0: the final message just landed and
 * must be fresh.
 */
const WORKING_SNIPPET_FRESHNESS_MS = 20_000;

/**
 * How many snippet pre-warms may be in flight at once.
 *
 * Small on purpose. Each one decodes a transcript window carrying full tool
 * inputs and results, so this number multiplies the protocol's per-frame
 * decoded cap to give the screen's peak transient footprint - the quantity
 * that was previously unbounded and scaled with the number of live agents.
 * Three keeps the pipe busy across a round trip without letting the peak grow
 * with the fleet; the pre-warm is an optimisation (rows fetch their own
 * snippet on mount regardless), so erring low costs latency, never content.
 */
export const SNIPPET_WARM_CONCURRENCY = 3;

/**
 * A row's snippet source, shared with the feed's pre-warm so both resolve
 * through the same caches: the pending decision when a prompt waits,
 * otherwise the agent's last message, falling back to the last readable
 * terminal line for transcript-less (codex-style) agents that still stream a
 * PTY. Throws when the message fetch failed AND left no fallback - the
 * caller treats that as retryable rather than as "no preview", since
 * successes cache and a stuck blank would never heal on its own.
 *
 * Takes primitives rather than the entry object so the row's effect can keep
 * depending on the few fields that should actually trigger a refetch.
 *
 * `allowTerminalFallback` exists for the pre-warm, which passes false. The
 * fallback is a FULL PTY scrollback (`peekLastTerminalLine` subscribes with
 * `terminal: true`, then makes a second round trip to put the subscription
 * back), and its trigger is content-shaped rather than agent-shaped: any
 * window whose eight entries happen to hold no assistant text takes it. Firing
 * that once per session, concurrently, at cold start is the heaviest term on
 * this screen. A row that mounts asks again with the fallback enabled, so a
 * transcript-less agent still gets its snippet - just gated by the row instead
 * of by the size of the fleet.
 */
async function peekSnippet(
  sessionId: string,
  awaitedPromptId: string | null,
  isPermission: boolean,
  freshnessMs: number,
  allowTerminalFallback = true,
): Promise<string | null> {
  if (isPermission && awaitedPromptId !== null) {
    const promptSummary = buildPendingPromptSummary(await peekAwaitedPrompt(sessionId, awaitedPromptId));
    if (promptSummary !== null) return promptSummary;
    // Nothing specific to say about the prompt: show what the agent last said
    // rather than a line restating the Idle section, so fall through.
  }
  let messagePeekFailed = false;
  const messageText = await peekLastAssistantMessage(sessionId, freshnessMs).catch(() => {
    messagePeekFailed = true;
    return null;
  });
  const snippetText = messageText ?? (allowTerminalFallback ? await peekLastTerminalLine(sessionId, freshnessMs) : null);
  if (snippetText === null && messagePeekFailed) throw new Error('snippet peek failed');
  return snippetText;
}

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
  // TaskCard, plus one Agents-only addition: the band across the top naming
  // the project and drawing the column's step track. A session can outlive its
  // task's board entry briefly (e.g. a snapshot race), so a located-but-absent
  // task falls back to a minimal stand-in rather than crashing.
  const locatedTask = useBoardStore((state) => state.boardsByProjectId[entry.projectId]?.tasksById[entry.taskId] ?? null);
  const task = locatedTask ?? fallbackTask(entry);
  // The ticket number, exactly as the desktop card and the Board tab show it:
  // after the title, whenever the task's OWN board has Ticket Numbers on (the
  // feed spans every project, and each keeps its own setting). It came back
  // once the project left the title row and freed the width it needed. Never
  // on the fallback stand-in, whose display_id is a placeholder 0.
  const boardShowsTicketNumbers = useBoardStore(
    (state) => state.boardsByProjectId[entry.projectId]?.showTicketNumbers ?? false,
  );
  const showTicketNumbers = locatedTask !== null && boardShowsTicketNumbers;
  const projectName = useBoardStore(
    (state) => state.projects.find((project) => project.id === entry.projectId)?.name ?? null,
  );
  /**
   * The column strip's data. Both selectors return references the store
   * already holds - a column ELEMENT of the board's own array, and that array
   * itself - so neither re-renders the row unless the board actually changed.
   * Never `selectColumnsOrdered` here: it builds a fresh sorted array per call,
   * which would re-render every row on every store write.
   *
   * The column is null whenever no cached board locates the task (the fallback
   * stand-in), which is what makes the strip draw empty rather than guess. It
   * keys on that alone, never on swap state: through a column move's swap the
   * strip shows the task's NEW column while a board still holds the task, and
   * the empty band if the sessions projection drops it for the sessionless
   * gap - either way never the old column, and never a height change.
   */
  const column = useBoardStore((state) => selectTaskColumn(state, entry.taskId));
  const boardColumns = useBoardStore((state) => state.boardsByProjectId[entry.projectId]?.columns ?? null);

  /**
   * Which of the desktop card's states this row is in (cardSessionDisplay):
   * running, queued, suspended, a respawn's step, or ended. TASK-keyed for the
   * respawn, because a column move leaves the task sessionless for several
   * seconds and this row only still exists because reconcileSessionsFromBoards
   * retains it for exactly that window.
   *
   * Only a RUNNING row reads as an agent: the status icon, the agent's last
   * message as the body, and the wait time all belong to it, as on the desktop
   * card. Every other state draws no icon, shows the task's description, and
   * says what it is in the footer ("Queued...", "Paused", the desktop's step).
   */
  const respawn = useActivityStore((state) => selectTaskRespawn(state, entry.taskId));
  const sessionDisplay = cardSessionDisplay({ session: toCardSession(entry), respawn, task: locatedTask });
  const isRunning = sessionDisplay.kind === 'running';
  // The band also carries the wait time (it moved up from the end of the body
  // line), so a waiting row's band changes when `waitingSinceMs` does. It is
  // the touch stand-in for the desktop card's "Idle for 4m" tooltip, so it
  // shows exactly where that tooltip exists: a running session waiting on you.
  const waitingSinceMs = isRunning ? selectWaitingSince(entry) : null;
  const columnStrip = useMemo(
    () => ({ column, track: buildJourneyTrack(boardColumns ?? [], column?.id ?? null), projectName, waitingSinceMs }),
    [column, boardColumns, projectName, waitingSinceMs],
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
  // None at all for a session that is not running, as the desktop card draws
  // it: a queued session in particular sits at `state: 'idle'` (the desktop
  // holds a placeholder with no PTY, so it never reports thinking), and only
  // `sessionStatus` keeps it from wearing the envelope.
  const statusKind: AgentStatusKind | null = !isRunning ? null : working ? 'working' : entry.unreadCount > 0 ? 'idle-unread' : 'idle';

  // Inbox-style snippet, the row's body for EVERY state: the pending
  // decision when a prompt waits, otherwise the agent's last message
  // (context for thinking rows too). WHEN to refetch is decided entirely by
  // the effect's dependency array below (the prompt id, or unreadCount, which
  // bumps on every new message), so a re-render never refetches.
  const awaitedPromptId = entry.awaitedPromptId;
  const [peekedSnippet, setPeekedSnippet] = useState<{ text: string | null } | null>(null);
  const [peekRetryNonce, setPeekRetryNonce] = useState(0);
  // The last text resolved, shown until a newer one REPLACES it - never
  // cleared while a refetch is in flight. Blanking it on each refetch flashed
  // the row text -> empty -> text on every engine event.
  const snippet = peekedSnippet !== null ? peekedSnippet.text : null;
  // While working, a slightly stale snippet is fine (the throttle stops a
  // busy session from refetching a heavy window on every event); at idle
  // the final message must be fresh, and the freshness flip on the
  // working-to-idle transition refires the effect to fetch it.
  const snippetFreshnessMs = working ? WORKING_SNIPPET_FRESHNESS_MS : 0;
  // "Has this row ever resolved a peek" as a ref, not the state value: the
  // effect only needs it to choose immediate-vs-settled, and depending on the
  // snippet state would re-run the effect on every resolved peek.
  const hasResolvedPeekRef = useRef(false);
  /**
   * A desktop on protocol 0.8.0+ pushes the message preview on the activity
   * feed, so this row already has its line and must NOT fetch one - skipping
   * the peek here is where the per-session transcript requests actually go
   * away. A prompt-pending row still peeks: its body is the pending decision,
   * which the preview does not describe.
   */
  const previewPushedByDesktop = !isPermission && entry.messagePreview !== null;
  useEffect(() => {
    // Only a running row shows the agent's message, so nothing else fetches
    // one. For a swap there is nothing that COULD be fetched either: a
    // retained ghost's session is gone desktop-side, so a peek would
    // retry-loop against a dead id.
    if (!isRunning) return undefined;
    if (previewPushedByDesktop) return undefined;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    // Let a burst settle before REFETCHING: each unreadCount bump re-runs
    // this effect and clears the previous timer, so a catch-up storm
    // resolves to one peek for the LAST key instead of one paint per event.
    // The FIRST peek has no burst to absorb and the card is waiting on it,
    // so it fires immediately - delaying it would only slow the cold start
    // the settle exists to smooth.
    const settleTimer = hasResolvedPeekRef.current ? setTimeout(runPeek, SNIPPET_SETTLE_MS) : (runPeek(), null);

    function runPeek(): void {
      if (cancelled) return;
      // The feed pre-warms these before it reveals itself, so on cold start
      // this call resolves straight from the peek caches and the row paints
      // its snippet in its first frame rather than a beat later.
      //
      // One exception, deliberate: a session whose window holds no assistant
      // text was pre-warmed WITHOUT the terminal fallback, so its snippet is
      // not cached and this call is what fetches it. That row paints empty
      // first and fills a beat later - the cost of not letting a cold start
      // fire one full PTY scrollback per live session at once.
      void peekSnippet(entry.sessionId, awaitedPromptId, isPermission, snippetFreshnessMs)
        .then((snippetText) => {
          if (cancelled) return;
          hasResolvedPeekRef.current = true;
          // Re-resolving the SAME text must not touch state: a new object
          // would re-render the row (and restart its animations) for a
          // snippet that did not actually change.
          setPeekedSnippet((previous) => (previous !== null && previous.text === snippetText ? previous : { text: snippetText }));
        })
        .catch(() => {
          // Not connected yet or a transient fetch failure: retry shortly.
          // The loop self-terminates on the first resolved peek (results
          // cache by key, so repeat runs after that are free).
          if (!cancelled) {
            retryTimer = setTimeout(() => setPeekRetryNonce((nonce) => nonce + 1), SNIPPET_PEEK_RETRY_MS);
          }
        });
    }

    return () => {
      cancelled = true;
      if (settleTimer !== null) clearTimeout(settleTimer);
      if (retryTimer !== null) clearTimeout(retryTimer);
    };
  }, [
    entry.sessionId,
    entry.unreadCount,
    isPermission,
    awaitedPromptId,
    peekRetryNonce,
    snippetFreshnessMs,
    previewPushedByDesktop,
    isRunning,
  ]);

  // No status filler ("Thinking", "Waiting for..."): the section header
  // and the icon already say the state. FIXED GEOMETRY: the snippet slot is
  // always exactly two lines tall and centres whatever it holds. A live
  // snippet changes length constantly (each new agent message replaces it),
  // and a slot that grew from one line to two shifted every card below it
  // mid-read. Reserving both lines up front costs one line of space and
  // buys a feed that never moves under the thumb.
  //
  // The elapsed-wait label is the one exception, and it is not a counter-example
  // to the rule above: "Thinking" restates what the icon already says, while
  // "4h 7m" is information nothing else on this screen carries. It earns the
  // space by answering the question this feed exists for - who is waiting on
  // me, and for how long - and it obeys the geometry rule strictly, riding in
  // the fixed-height band at the top of the card (`columnStrip.waitingSinceMs`
  // above) so no row changes height. A working row passes null and renders
  // nothing at all: the label appears exactly when the agent's last message has
  // stopped moving (see `snippetFreshnessMs` above - an idle row's snippet is
  // refetched at freshness 0 precisely because it is the last word). A row that
  // is not running passes null too (see `waitingSinceMs`).
  const snippetSlotHeight = theme.typography.caption.lineHeight * SNIPPET_LINES;
  const testID = `activity-row-${entry.sessionId}`;
  /**
   * A row that is not running shows the task's description, as the desktop
   * card does: its message trail only shows while a session runs. Queued,
   * paused, a respawn's step and an ended session all say what they are in the
   * footer instead (cardSessionDisplay).
   *
   * For a running row, body preference, cheapest first:
   *   1. the desktop's pushed preview (protocol 0.8.0+) - already on a feed
   *      the app receives, so it costs no request at all;
   *   2. this row's own transcript peek - the fallback for an older desktop,
   *      and for a prompt-pending row whose summary is the pending decision;
   *   3. the task description from the board snapshot, so a card is never
   *      blank while either of the above is still resolving. It rides in on a
   *      snapshot the feed already has, so it costs nothing, while a peek is a
   *      transcript fetch that can take seconds on a long session. Without it
   *      the feed revealed with every body empty and filled them a beat later,
   *      which read as a second load.
   * A prompt-pending row puts its own peek first, since the pending decision
   * is the most useful line it can show. When the prompt has nothing specific
   * to say, the peek falls through to the agent's last message (peekSnippet),
   * and the pushed preview covers the wait: never a generic "waiting for
   * approval" line, which would only restate the Idle section and its icon.
   */
  const descriptionText = collapseToSnippetText(task.description);
  const bodyText = isRunning
    ? ((isPermission ? (snippet ?? entry.messagePreview) : (entry.messagePreview ?? snippet)) ?? descriptionText)
    : descriptionText;

  return (
    <>
      <TaskCard
        testID={testID}
        task={task}
        statusKind={statusKind}
        showTicketNumbers={showTicketNumbers}
        sessionDisplay={sessionDisplay}
        usage={entry.usage}
        columnStrip={columnStrip}
        bodyText={bodyText}
        bodyNumberOfLines={SNIPPET_LINES}
        bodyMinHeight={snippetSlotHeight}
        onPress={openTask}
        onLongPress={onLongPress}
        // One subtle tint fade when the row lands in a new section, mounted
        // only for its own window and taken down by a JS timer (see
        // SectionLandingPulse for why a Reanimated frame cannot be trusted to
        // clear it). The key does the recycling work: a new change, or a
        // FlashList rebind to another session, remounts it from scratch.
        overlay={
          entry.sectionChangedAt !== null ? (
            <SectionLandingPulse
              key={`${entry.sessionId}:${entry.sectionChangedAt}`}
              changedAtMs={entry.sectionChangedAt}
              testID={`${testID}-pulse`}
            />
          ) : null
        }
      />
      {/* Inert in every shipped build (the probe flag is off): the idle-CPU
          mapper-count experiment only. See src/devsupport/MapperLoad.tsx. */}
      <MapperLoad />
    </>
  );
});

/**
 * A card for a board task the desktop keeps in its `'sessions'` projection
 * with NO session on it (protocol 0.16.0): a paused task the desktop offers
 * Resume for, or a first start whose agent does not exist yet ("Creating
 * worktree..."). The feed only draws one when no activity entry claims the
 * task: a pause the phone watched keeps the session's own row in place (see
 * reconcileSessionsFromBoards), so this is the cold-start face of the same
 * card.
 *
 * Deliberately the session row minus everything a session supplies: no status
 * icon, no wait time, no snippet (the body is the description, as on every
 * card that is not running), no usage, no landing pulse. The footer says what
 * it is ("Paused", the desktop's step) through the same cardSessionDisplay.
 * Tapping opens the session screen with no session id, where the board row
 * offers Resume (useResumeOffer) or the launch veil waits for the agent.
 */
const SessionlessTaskRow = React.memo(function SessionlessTaskRow({
  task,
  projectId,
  onLongPressTask,
}: {
  task: BoardTaskWire;
  projectId: string;
  onLongPressTask: (task: BoardTaskWire, projectId: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const showTicketNumbers = useBoardStore((state) => state.boardsByProjectId[projectId]?.showTicketNumbers ?? false);
  const projectName = useBoardStore((state) => state.projects.find((project) => project.id === projectId)?.name ?? null);
  // Same reference-stable selectors as ActivityRow's band (see its note).
  const column = useBoardStore((state) => selectTaskColumn(state, task.id));
  const boardColumns = useBoardStore((state) => state.boardsByProjectId[projectId]?.columns ?? null);
  const columnStrip = useMemo(
    () => ({ column, track: buildJourneyTrack(boardColumns ?? [], column?.id ?? null), projectName, waitingSinceMs: null }),
    [column, boardColumns, projectName],
  );
  const respawn = useActivityStore((state) => selectTaskRespawn(state, task.id));
  const sessionDisplay = cardSessionDisplay({ session: null, respawn, task });

  const openTask = useCallback(() => {
    router.push({ pathname: '/task/[taskId]', params: { taskId: task.id, projectId } });
  }, [router, task.id, projectId]);
  const onLongPress = useCallback(() => onLongPressTask(task, projectId), [onLongPressTask, task, projectId]);

  return (
    <TaskCard
      testID={`task-row-${task.id}`}
      task={task}
      statusKind={null}
      showTicketNumbers={showTicketNumbers}
      sessionDisplay={sessionDisplay}
      usage={null}
      columnStrip={columnStrip}
      bodyText={collapseToSnippetText(task.description)}
      bodyNumberOfLines={SNIPPET_LINES}
      bodyMinHeight={theme.typography.caption.lineHeight * SNIPPET_LINES}
      onPress={openTask}
      onLongPress={onLongPress}
    />
  );
});
