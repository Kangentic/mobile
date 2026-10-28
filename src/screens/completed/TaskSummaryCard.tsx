import React, { useCallback, useId, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Defs, LinearGradient, Rect, Stop } from 'react-native-svg';
import { Clock } from 'lucide-react-native';
import type { TaskReportSummaryStateWire } from '@kangentic/protocol';
import { Button, MarkdownBlock, Stack, Text, useTheme } from '@/components';
import { ReportCard } from './ReportCard';

/** The desktop's clamp, `max-h-[7.5rem]`: a height, not a line count, about six lines of body text. */
const CLAMP_HEIGHT = 120;
/** How far the fade reaches up from the cut, so a half-drawn line reads as continuing rather than broken. */
const FADE_HEIGHT = 36;
const CLOCK_ICON_SIZE = 14;

/** The desktop's line for a summary that is not written, by why (its SummaryTab copy). */
function stateLine(summaryState: TaskReportSummaryStateWire | null): string | null {
  switch (summaryState?.kind) {
    case 'pending':
      return 'Summary pending';
    case 'off':
      return 'Task summaries are off';
    case 'indexing-off':
      return 'Knowledge Graph indexing is off';
    default:
      return null;
  }
}

/**
 * The Summary's first card: what the task did, in the desktop's written
 * summary. With none written, the desktop's reason, then the agent's last
 * message in its place. The desktop's Open Settings button is not here: the
 * phone has no Knowledge Graph settings to open.
 */
export function TaskSummaryCard({
  summaryState,
  lastMessage,
}: {
  summaryState: TaskReportSummaryStateWire | null;
  lastMessage: string | null;
}): React.JSX.Element {
  const theme = useTheme();
  const line = stateLine(summaryState);
  return (
    <ReportCard title="Task summary" testID="completed-summary-task">
      {summaryState?.kind === 'written' ? (
        <Text color="secondary" selectable testID="completed-summary-task-text">
          {summaryState.text}
        </Text>
      ) : null}
      {line !== null ? (
        <View testID="completed-summary-task-state" style={[styles.stateLine, { gap: theme.spacing.xs }]}>
          {summaryState?.kind === 'pending' ? <Clock size={CLOCK_ICON_SIZE} color={theme.colors.textMuted} /> : null}
          <Text color="muted">{line}</Text>
        </View>
      ) : null}
      {lastMessage !== null ? (
        <Stack gap="xs">
          <Text variant="caption" color="muted" style={styles.lastMessageHeading}>
            Last message
          </Text>
          <ClampedMarkdown markdown={lastMessage} testID="completed-summary-last-message" />
        </Stack>
      ) : null}
    </ReportCard>
  );
}

/**
 * Markdown cut at the desktop's 120 pt, with Show all / Show less once the
 * text is taller than that. The inner view keeps its natural height inside
 * the clipped one, so its layout says whether there is more to show. The fade
 * is a static gradient, drawn once, never animated.
 */
function ClampedMarkdown({ markdown, testID }: { markdown: string; testID: string }): React.JSX.Element {
  const theme = useTheme();
  const [expanded, setExpanded] = useState(false);
  const [contentHeight, setContentHeight] = useState(0);
  const overflows = contentHeight > CLAMP_HEIGHT + 1;
  const onContentLayout = useCallback((event: LayoutChangeEvent) => {
    const nextHeight = event.nativeEvent.layout.height;
    setContentHeight((currentHeight) => (currentHeight === nextHeight ? currentHeight : nextHeight));
  }, []);
  const onToggle = useCallback(() => setExpanded((current) => !current), []);
  const gradientId = `clamp-fade-${useId().replace(/[^A-Za-z0-9_-]/g, '')}`;

  return (
    <Stack gap="sm">
      <View style={expanded ? null : styles.clamped}>
        <View onLayout={onContentLayout} testID={`${testID}-content`}>
          <MarkdownBlock markdown={markdown} testID={testID} />
        </View>
        {!expanded && overflows ? (
          <View pointerEvents="none" style={styles.fade} testID={`${testID}-fade`}>
            <Svg width="100%" height={FADE_HEIGHT}>
              <Defs>
                <LinearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                  <Stop offset="0" stopColor={theme.colors.surface} stopOpacity={0} />
                  <Stop offset="1" stopColor={theme.colors.surface} stopOpacity={1} />
                </LinearGradient>
              </Defs>
              <Rect x="0" y="0" width="100%" height={FADE_HEIGHT} fill={`url(#${gradientId})`} />
            </Svg>
          </View>
        ) : null}
      </View>
      {overflows ? (
        <Button
          variant="ghost"
          label={expanded ? 'Show less' : 'Show all'}
          onPress={onToggle}
          testID={`${testID}-toggle`}
        />
      ) : null}
    </Stack>
  );
}

const styles = StyleSheet.create({
  stateLine: {
    alignItems: 'center',
    flexDirection: 'row',
  },
  lastMessageHeading: {
    fontWeight: '600',
  },
  clamped: {
    maxHeight: CLAMP_HEIGHT,
    overflow: 'hidden',
  },
  fade: {
    bottom: 0,
    height: FADE_HEIGHT,
    left: 0,
    position: 'absolute',
    right: 0,
  },
});
