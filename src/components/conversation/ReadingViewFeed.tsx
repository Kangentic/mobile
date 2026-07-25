import React, { useCallback, useRef, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { MonoText, Text, useTheme } from '@/components';
import { useReadingViewStore } from '@/state/readingViewStore';

export interface ReadingViewFeedProps {
  sessionId: string;
  /** Shown as a caption so the source of the feed is honest (e.g. the agent name). */
  agentLabel: string | null;
}

const JUMP_TO_LATEST_THRESHOLD_PX = 600;

// A stable identity: an inline object literal re-triggers FlashList layout on
// every render, and this feed re-renders on every cleaned-output revision.
const MAINTAIN_VISIBLE_CONTENT_POSITION = { autoscrollToBottomThreshold: 0.2 } as const;

interface ReadingViewRow {
  key: string;
  text: string;
}

/**
 * The chat lens for sessions WITHOUT a structured transcript (codex, gemini,
 * plain shells): a readable, auto-cleaned line feed derived live from the
 * terminal by the WebView's clean feed. Terminal = exact; this = readable.
 * Input in this mode still composes agent messages; the terminal lens is one
 * tap away for full fidelity.
 */
export function ReadingViewFeed({ sessionId, agentLabel }: ReadingViewFeedProps): React.JSX.Element {
  const theme = useTheme();
  const readingState = useReadingViewStore((state) => state.bySessionId[sessionId] ?? null);
  const lines = readingState?.lines ?? [];

  const rows: ReadingViewRow[] = lines.map((text, index) => ({
    // Keys are positional within a revisioned buffer: a reset renumbers, which
    // is correct (the frame REPLACED the content).
    key: `line-${index}`,
    text,
  }));

  const listRef = useRef<FlashListRef<ReadingViewRow>>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const showJumpToLatestRef = useRef(false);

  // Same initial anchor as the transcript feed: this lens is the newest-output
  // view, so it opens at the newest line and hands over on the first drag.
  const userTookOverScrollRef = useRef(false);
  const onScrollBeginDrag = useCallback(() => {
    userTookOverScrollRef.current = true;
  }, []);
  const onContentSizeChange = useCallback(() => {
    if (userTookOverScrollRef.current || rows.length === 0) return;
    listRef.current?.scrollToEnd({ animated: false });
  }, [rows.length]);

  const onScroll = useCallback((event: NativeSyntheticEvent<NativeScrollEvent>) => {
    const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
    const distanceFromBottom = contentSize.height - layoutMeasurement.height - contentOffset.y;
    const nextShowJumpToLatest = distanceFromBottom > JUMP_TO_LATEST_THRESHOLD_PX;
    if (nextShowJumpToLatest === showJumpToLatestRef.current) return;
    showJumpToLatestRef.current = nextShowJumpToLatest;
    setShowJumpToLatest(nextShowJumpToLatest);
  }, []);

  const renderItem = useCallback(
    ({ item, index }: { item: ReadingViewRow; index: number }) => (
      <MonoText size="caption" testID={`reading-view-line-${index}`} style={styles.line}>
        {item.text}
      </MonoText>
    ),
    [],
  );

  return (
    <View style={styles.flex}>
      <View
        testID="reading-view-caption"
        style={{
          backgroundColor: theme.colors.surface,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.xs,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        }}
      >
        <Text variant="caption" color="muted">
          {agentLabel ? `${agentLabel} session · ` : ''}Cleaned live view, derived from the terminal
        </Text>
      </View>
      {rows.length === 0 ? (
        <View style={styles.empty}>
          <Text variant="body" color="secondary">
            Waiting for output...
          </Text>
        </View>
      ) : (
        <FlashList<ReadingViewRow>
          ref={listRef}
          testID="reading-view-list"
          data={rows}
          keyExtractor={(row) => row.key}
          renderItem={renderItem}
          onScroll={onScroll}
          onScrollBeginDrag={onScrollBeginDrag}
          onContentSizeChange={onContentSizeChange}
          scrollEventThrottle={64}
          maintainVisibleContentPosition={MAINTAIN_VISIBLE_CONTENT_POSITION}
          contentContainerStyle={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }}
          // This lens shares the composer with the transcript one. No row is
          // tappable today, so this is consistency rather than a live bug -
          // but the moment one becomes tappable it would be.
          keyboardShouldPersistTaps="handled"
        />
      )}
      {showJumpToLatest ? (
        <Pressable
          accessibilityRole="button"
          testID="reading-view-jump-to-latest"
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

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  line: {
    flexShrink: 1,
  },
  empty: {
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
