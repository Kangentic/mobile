import React, { useCallback, useMemo, useState } from 'react';
import { View } from 'react-native';
import { FlashList, type ListRenderItemInfo } from '@shopify/flash-list';
import type { BoardTaskWire, SessionSummaryWire } from '@kangentic/protocol';
import { Skeleton, Text, useTheme } from '@/components';
import { headerStripModel } from '@/taskReport/headerStrip';
import { summaryItemKey, summaryItems, type SummaryItem, type SummaryPhase } from '@/taskReport/summaryItems';
import { CommitsCard } from './CommitsCard';
import { CompletedHeaderStrip } from './CompletedHeaderStrip';
import { FileChangedRow, FilesChangedFooter, FilesChangedHeader } from './FilesChangedCard';
import { RouteCard } from './RouteCard';
import { TaskSummaryCard } from './TaskSummaryCard';
import { UsageRow } from './UsageRow';

/** The desktop's loading blocks are `h-24`. */
const LOADING_CARD_HEIGHT = 96;
/** The strip's two figure rows and its foot, roughly, so the cards do not jump when it lands. */
const LOADING_STRIP_HEIGHT = 150;

/** Items that start a new card (or the unavailable line) get the gap between cards above them. */
function startsBlock(item: SummaryItem): boolean {
  return item.kind !== 'strip' && item.kind !== 'loading' && item.kind !== 'fileRow' && item.kind !== 'filesFooter';
}

/**
 * The Summary segment: the header strip, then the report cards, as one
 * FlashList (see `summaryItems` for why each changed file is its own row).
 * The strip spans the width; the cards sit inside the screen's side margin,
 * with the first one closer to the strip than the cards are to each other.
 */
export function SummaryPane({
  task,
  summary,
  read,
  lastMessage,
}: {
  task: BoardTaskWire;
  summary: SessionSummaryWire | null;
  read: SummaryPhase;
  lastMessage: string | null;
}): React.JSX.Element {
  const theme = useTheme();
  const [filesExpanded, setFilesExpanded] = useState(false);
  const onShowAllFiles = useCallback(() => setFilesExpanded(true), []);
  // One clock per open, so every relative time on the screen agrees. A
  // completed task's times do not move, so it never needs to tick.
  const [nowMs] = useState(() => Date.now());

  const items = useMemo(() => {
    const report = read.phase === 'ready' ? read.report : null;
    const strip = headerStripModel(report, summary, task, new Date(nowMs));
    return summaryItems({ read, strip, lastMessage, hasUsage: summary !== null, filesExpanded });
  }, [read, summary, task, lastMessage, filesExpanded, nowMs]);

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<SummaryItem>) => {
      const sideMargin = item.kind === 'strip' ? 0 : theme.spacing.md;
      const gapAbove = startsBlock(item) ? (index <= 1 ? theme.spacing.md : theme.spacing.lg) : 0;
      return (
        <View style={{ paddingHorizontal: sideMargin, paddingTop: gapAbove }}>
          {renderSummaryItem(item, { task, summary, nowMs, onShowAllFiles })}
        </View>
      );
    },
    [theme, task, summary, nowMs, onShowAllFiles],
  );

  return (
    <FlashList<SummaryItem>
      testID="completed-task-summary"
      data={items}
      keyExtractor={summaryItemKey}
      getItemType={(item) => item.kind}
      renderItem={renderItem}
      contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
    />
  );
}

function renderSummaryItem(
  item: SummaryItem,
  context: { task: BoardTaskWire; summary: SessionSummaryWire | null; nowMs: number; onShowAllFiles: () => void },
): React.JSX.Element | null {
  switch (item.kind) {
    case 'loading':
      return <SummaryLoading />;
    case 'strip':
      return (
        <CompletedHeaderStrip
          strip={item.strip}
          prState={context.task.pr_state}
          prMergeReadiness={context.task.pr_merge_readiness}
        />
      );
    case 'taskSummary':
      return <TaskSummaryCard summaryState={item.summaryState} lastMessage={item.lastMessage} />;
    case 'unavailable':
      return (
        <Text color="muted" testID="completed-summary-unavailable">
          Could not read this task&apos;s record
        </Text>
      );
    case 'route':
      return <RouteCard route={item.route} />;
    case 'commits':
      return <CommitsCard commits={item.commits} commitCount={item.commitCount} nowMs={context.nowMs} />;
    case 'filesHeader':
      return <FilesChangedHeader fileCount={item.fileCount} />;
    case 'fileRow':
      return <FileChangedRow file={item.file} index={item.index} />;
    case 'filesFooter':
      return <FilesChangedFooter hiddenCount={item.hiddenCount} filesSent={item.filesSent} onShowAll={context.onShowAllFiles} />;
    case 'usage':
      return context.summary !== null ? <UsageRow summary={context.summary} /> : null;
  }
}

/**
 * While the report is read: a strip-sized block and the desktop's two card
 * blocks. Nothing shows a figure yet, because the desktop's strip waits for
 * its report too and a figure that changed under the reader would be worse.
 */
function SummaryLoading(): React.JSX.Element {
  const theme = useTheme();
  return (
    <View testID="completed-summary-loading" style={{ padding: theme.spacing.md, gap: theme.spacing.lg }}>
      <Skeleton height={LOADING_STRIP_HEIGHT} borderRadius={theme.radii.md} />
      <Skeleton height={LOADING_CARD_HEIGHT} borderRadius={theme.radii.md} />
      <Skeleton height={LOADING_CARD_HEIGHT} borderRadius={theme.radii.md} />
    </View>
  );
}
