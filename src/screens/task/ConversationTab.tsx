import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import type { TranscriptEntryWire } from '@kangentic/protocol';
import { Stack, Text, useTheme } from '@/components';
import { AskUserQuestionCard } from '@/components/conversation/AskUserQuestionCard';
import { LiveTailCell } from '@/components/conversation/LiveTailCell';
import { MarkdownCell } from '@/components/conversation/MarkdownCell';
import { PermissionPromptCard } from '@/components/conversation/PermissionPromptCard';
import { SystemDividerCell } from '@/components/conversation/SystemDividerCell';
import { ThinkingCell } from '@/components/conversation/ThinkingCell';
import { ToolCallCard } from '@/components/conversation/ToolCallCard';
import { ToolResultCell } from '@/components/conversation/ToolResultCell';
import { UserMessageCell } from '@/components/conversation/UserMessageCell';
import { findAwaitedToolUse } from '@/conversation/pendingPromptSummary';
import {
  buildConversationCells,
  type ConversationCell,
  type PendingPromptDescriptor,
} from '@/conversation/transcriptCells';
import { loadOlderTranscript, loadTranscriptTail } from '@/connection/actions';
import { getRetentionProbeVariant } from '@/devsupport/retentionProbe';
import { getBufferedData, subscribeChunks } from '@/state/terminalFeed';
import { useActivityStore } from '@/state/activityStore';
import { useChannelStore } from '@/state/channelStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { createLiveTailBuffer, type LiveTailBuffer } from '@/terminal/liveTail';

export interface ConversationTabProps {
  taskId: string;
  sessionId: string | null;
  projectId: string | null;
}

const LIVE_TAIL_MAX_LINES = 12;
const LIVE_TAIL_FLUSH_INTERVAL_MS = 250;
const JUMP_TO_LATEST_THRESHOLD_PX = 600;
/** How close to the top of the loaded window a scroll gets before the next older page is fetched. */
const PAGE_OLDER_THRESHOLD_PX = 1200;

// A stable identity (an inline object literal re-triggers FlashList layout
// every render). `startRenderingFromBottom` is deliberately omitted: on a
// transcript shorter than the viewport it makes FlashList v2 re-anchor to the
// bottom in a layout loop ("Maximum update depth exceeded"). We pin to the
// bottom manually via scrollToEnd on the first content instead, and
// autoscrollToBottomThreshold keeps it pinned as the turn streams.
const MAINTAIN_VISIBLE_CONTENT_POSITION = { autoscrollToBottomThreshold: 0.2 } as const;

const EMPTY_ENTRIES: TranscriptEntryWire[] = [];

/** How long the content size must hold still before the settled list is shown. */
const SETTLE_QUIET_MS = 120;
/** Hard cap on that wait: a continuously streaming session never goes quiet, and must still appear. */
const SETTLE_DEADLINE_MS = 700;

/** The conversation-terminal surface: the flattened transcript cell feed for the task's session. */
export function ConversationTab({ sessionId }: ConversationTabProps): React.JSX.Element {
  if (sessionId === null) {
    return (
      <Stack gap="sm" style={styles.emptyState}>
        <Text variant="body" color="secondary">
          No active session for this task
        </Text>
      </Stack>
    );
  }
  return <ConversationFeed sessionId={sessionId} />;
}

function ConversationFeed({ sessionId }: { sessionId: string }): React.JSX.Element {
  const theme = useTheme();
  const transcript = useTranscriptStore((state) => state.bySessionId[sessionId]);
  const entries = transcript?.entries ?? EMPTY_ENTRIES;
  const tailRevision = transcript?.tailRevision ?? 0;
  const needsTailFetch = transcript?.needsTailFetch ?? false;
  const hasMoreHistory = (transcript?.startIndex ?? 0) > 0;
  const established = useChannelStore((state) => state.established);
  const activityEntry = useActivityStore((state) => state.bySessionId[sessionId] ?? null);

  // Self-heal: whenever the store flags that its window is missing or
  // unpatchable (reset signal, delta gap, delta before any window) and the
  // channel is up, re-fetch the newest window. openSessionScreen does the
  // first fetch; this covers reconnects and mid-stream resets.
  useEffect(() => {
    if (!needsTailFetch || !established) return;
    void loadTranscriptTail(sessionId).catch(() => {
      // Still disconnected or a transient failure: the flag stays set and
      // the next established/flag change retries.
    });
  }, [needsTailFetch, established, sessionId]);

  /**
   * The list opens anchored at the newest message, so it begins life inside
   * the top threshold and would page in history the user never asked for -
   * and that older page prepends AFTER the initial anchor has run, pushing
   * every cell down and parking the viewport in empty space (observed live:
   * a blank chat that filled in only once you scrolled). So paging waits for
   * a real scroll.
   *
   * That wait is why paging is driven from onScroll rather than FlashList's
   * onStartReached: onStartReached is EDGE-triggered. It fires once on the
   * way into the threshold, and declining it there consumes the only event -
   * the list then sits pinned at the top of its window loading nothing, which
   * is exactly what happened when this was gated on onStartReached. A scroll
   * offset is level-triggered and cannot be swallowed.
   */
  const userTookOverScrollRef = useRef(false);
  const onScrollBeginDrag = useCallback(() => {
    userTookOverScrollRef.current = true;
  }, []);

  // Scroll-up pagination: one in-flight older-page request at a time.
  const loadingOlderRef = useRef(false);
  const pageOlderIfNeeded = useCallback(
    (offsetFromTop: number) => {
      if (!userTookOverScrollRef.current) return;
      if (offsetFromTop > PAGE_OLDER_THRESHOLD_PX) return;
      if (!hasMoreHistory || loadingOlderRef.current) return;
      loadingOlderRef.current = true;
      void loadOlderTranscript(sessionId)
        .catch(() => {
          // Transient failure: the next scroll event retries.
        })
        .finally(() => {
          loadingOlderRef.current = false;
        });
    },
    [hasMoreHistory, sessionId],
  );

  // LIVE TAIL: raw PTY chunks feed a cleaner buffer; re-renders are throttled
  // to one snapshot per ~250ms while chunks stream.
  const liveTailBufferRef = useRef<LiveTailBuffer | null>(null);
  if (liveTailBufferRef.current === null) {
    liveTailBufferRef.current = createLiveTailBuffer({ maxLines: LIVE_TAIL_MAX_LINES });
  }
  const [liveTailLines, setLiveTailLines] = useState<string[]>([]);
  const flushTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingFlush = useCallback(() => {
    if (flushTimeoutRef.current !== null) {
      clearTimeout(flushTimeoutRef.current);
      flushTimeoutRef.current = null;
    }
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushTimeoutRef.current !== null) return;
    flushTimeoutRef.current = setTimeout(() => {
      flushTimeoutRef.current = null;
      setLiveTailLines(liveTailBufferRef.current?.snapshotLines() ?? []);
    }, LIVE_TAIL_FLUSH_INTERVAL_MS);
  }, []);

  useEffect(() => {
    const liveTailBuffer = liveTailBufferRef.current;
    if (liveTailBuffer === null) return undefined;
    liveTailBuffer.reset();
    liveTailBuffer.append(getBufferedData(sessionId));
    setLiveTailLines(liveTailBuffer.snapshotLines());
    const unsubscribe = subscribeChunks(sessionId, (event) => {
      if (event.kind === 'dims') return; // geometry concerns the xterm pane, not the cleaned tail
      if (event.kind === 'seed') liveTailBuffer.reset();
      liveTailBuffer.append(event.data);
      scheduleFlush();
    });
    return () => {
      unsubscribe();
      clearPendingFlush();
    };
  }, [sessionId, scheduleFlush, clearPendingFlush]);

  // The settled transcript replaces the tail: only NEW settled content at
  // the window's end resets the live-tail buffer (tailRevision). Older-page
  // prepends and mid-window edits leave the in-progress stream render alone.
  const previousTailRevisionRef = useRef(tailRevision);
  useEffect(() => {
    if (previousTailRevisionRef.current === tailRevision) return;
    previousTailRevisionRef.current = tailRevision;
    liveTailBufferRef.current?.reset();
    clearPendingFlush();
    setLiveTailLines([]);
  }, [tailRevision, clearPendingFlush]);

  // PENDING PROMPT: the awaited tool_use may not have arrived in the
  // transcript yet; the card renders a generic state until it does.
  const awaitedPromptId = activityEntry?.awaitedPromptId ?? null;
  const awaitedPromptOptions = activityEntry?.awaitedPromptOptions ?? null;
  const pendingPrompt = useMemo<PendingPromptDescriptor | null>(() => {
    if (awaitedPromptId === null) return null;
    const awaitedToolUse = findAwaitedToolUse(entries, sessionId, awaitedPromptId);
    return {
      promptId: awaitedPromptId,
      sessionId,
      toolUseId: awaitedToolUse?.toolUseId ?? null,
      toolName: awaitedToolUse?.name ?? null,
      input: awaitedToolUse?.input ?? null,
      options: awaitedPromptOptions,
    };
  }, [awaitedPromptId, entries, sessionId, awaitedPromptOptions]);

  const liveTailLinesForCells = activityEntry?.state === 'thinking' ? liveTailLines : null;
  const cells = useMemo(
    () => buildConversationCells(entries, { liveTailLines: liveTailLinesForCells, pendingPrompt }),
    [entries, liveTailLinesForCells, pendingPrompt],
  );

  const listRef = useRef<FlashListRef<ConversationCell>>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  // Ref-track the current value so a scroll storm (auto-scroll on mount)
  // dispatches a React update only on a real transition, never re-entrantly.
  const showJumpToLatestRef = useRef(false);
  const onScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      pageOlderIfNeeded(contentOffset.y);
      const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
      const nextShowJumpToLatest = distanceFromBottom > JUMP_TO_LATEST_THRESHOLD_PX;
      if (nextShowJumpToLatest === showJumpToLatestRef.current) return;
      showJumpToLatestRef.current = nextShowJumpToLatest;
      setShowJumpToLatest(nextShowJumpToLatest);
    },
    [pageOlderIfNeeded],
  );

  const renderItem = useCallback(
    ({ item }: { item: ConversationCell }) => renderConversationCell(item, sessionId),
    [sessionId],
  );

  /**
   * HOLD THE LIST INVISIBLE UNTIL IT HAS SETTLED AT THE BOTTOM.
   *
   * The anchoring below is correct but it is not free of visual cost: the
   * window assembles over several frames, and each one paints at the previous
   * offset before scrollToEnd moves it. The net effect is the content visibly
   * streaming in and scrolling away under the reader - flashes of text nobody
   * asked to see.
   *
   * Rather than fight the layout (startRenderingFromBottom is the obvious fix
   * and loops - see MAINTAIN_VISIBLE_CONTENT_POSITION), the list still does
   * all of that work, just off-screen. It renders at opacity 0 until the
   * content size has been QUIET for a beat, which is the earliest moment the
   * bottom anchor is the real bottom. The reader sees one thing: the newest
   * message, already in place.
   *
   * Two guards keep this from ever hiding the feed for good: a hard deadline
   * from mount (a session that streams continuously never goes quiet), and an
   * immediate reveal when there are no cells, so the empty state is not held
   * back by a settle that will never come.
   */
  const [revealed, setRevealed] = useState(false);
  const revealTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleReveal = useCallback(() => {
    if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
    revealTimerRef.current = setTimeout(() => {
      revealTimerRef.current = null;
      setRevealed(true);
    }, SETTLE_QUIET_MS);
  }, []);

  useEffect(() => {
    // Deadline, and the empty-list case, both independent of content size.
    const deadline = setTimeout(() => setRevealed(true), SETTLE_DEADLINE_MS);
    return () => {
      clearTimeout(deadline);
      if (revealTimerRef.current !== null) clearTimeout(revealTimerRef.current);
    };
  }, []);
  if (cells.length === 0 && !revealed) setRevealed(true);

  /**
   * Land at the newest message on open (replaces startRenderingFromBottom
   * without its layout loop). Deliberately NOT latched to the first
   * content-size change: a session's window is assembled over several frames
   * (the open fetch lands, cells build, the streaming tail appends, cell
   * heights get measured), so anchoring once at the first change anchors to a
   * list that is a fraction of its final height. Re-anchoring on every change
   * until the user drags is what actually keeps the newest message on screen,
   * and it hands control over the instant they scroll.
   */
  const onContentSizeChange = useCallback(() => {
    if (userTookOverScrollRef.current || cells.length === 0) return;
    listRef.current?.scrollToEnd({ animated: false });
    scheduleReveal();
  }, [cells.length, scheduleReveal]);

  return (
    <View style={styles.flex}>
      {/* opacity, not conditional mounting: the list has to lay out and
          measure to find its own bottom, so it must be rendered - just not
          watched while it does it. */}
      <View style={[styles.flex, { opacity: revealed ? 1 : 0 }]} pointerEvents={revealed ? 'auto' : 'none'}>
      <FlashList<ConversationCell>
        ref={listRef}
        testID="conversation-list"
        data={cells}
        keyExtractor={(cell) => cell.key}
        getItemType={(cell) => cell.kind}
        renderItem={renderItem}
        onScroll={onScroll}
        onScrollBeginDrag={onScrollBeginDrag}
        scrollEventThrottle={64}
        onContentSizeChange={onContentSizeChange}
        maintainVisibleContentPosition={MAINTAIN_VISIBLE_CONTENT_POSITION}
        // The composer sits on this same screen, so the keyboard is routinely
        // up while a prompt card is on screen. The default ("never") spends
        // the first tap dismissing the keyboard, which on this list means the
        // first tap on Approve or Deny does nothing - the single worst control
        // in the app to make people tap twice.
        keyboardShouldPersistTaps="handled"
      />
      </View>
      {showJumpToLatest ? (
        <Pressable
          accessibilityRole="button"
          testID="jump-to-latest"
          onPress={() => listRef.current?.scrollToEnd({ animated: true })}
          style={[
            styles.jumpToLatest,
            {
              minHeight: theme.minTouchSize,
              borderRadius: theme.minTouchSize / 2,
              backgroundColor: theme.colors.surfaceRaised,
              borderColor: theme.colors.border,
              paddingHorizontal: theme.spacing.lg,
              bottom: theme.spacing.lg,
            },
          ]}
        >
          <Text variant="caption" color="accent">
            Jump to latest
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

function renderConversationCell(cell: ConversationCell, sessionId: string): React.JSX.Element {
  // Retention bisect: keeps the list, drops every cell's own view tree.
  if (getRetentionProbeVariant() === 'plain-cells') {
    return <Text variant="body">{cell.kind}</Text>;
  }
  switch (cell.kind) {
    case 'user-message':
      return <UserMessageCell cell={cell} />;
    case 'markdown':
      return <MarkdownCell cell={cell} />;
    case 'thinking':
      return <ThinkingCell cell={cell} />;
    case 'tool-call':
      return <ToolCallCard cell={cell} />;
    case 'tool-result-orphan':
      return <ToolResultCell cell={cell} />;
    case 'system-divider':
      return <SystemDividerCell cell={cell} />;
    case 'live-tail':
      return <LiveTailCell lines={cell.lines} />;
    case 'permission-prompt':
      return <PermissionPromptCard sessionId={sessionId} prompt={cell.prompt} />;
    case 'ask-user-question':
      return <AskUserQuestionCard sessionId={sessionId} prompt={cell.prompt} />;
  }
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  jumpToLatest: {
    position: 'absolute',
    alignSelf: 'center',
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
