import React, { useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Stack as RouterStack, useLocalSearchParams } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import type { ReadDiffScope } from '@kangentic/protocol';
import { MonoText, Screen, Skeleton, Stack, Text, useTheme } from '@/components';
import { DiffLineCell } from '@/components/diff/DiffLineCell';
import { buildUnifiedDiffLines, maxLineLength, type DiffLine } from '@/diff/diffLines';
import { useDiffStore } from '@/state/diffStore';
import { fetchDiffFileContent } from '@/connection/actions';

const DIFF_CONTEXT_LINES = 3;
/** Approximate monospace advance width at the 12px caption size, for horizontal-scroll sizing. */
const MONO_CHARACTER_WIDTH_PX = 7.2;
/** Two line-number gutter columns (34px each) plus their padding. */
const LINE_NUMBER_GUTTER_TOTAL_WIDTH_PX = 76;
/**
 * Varying widths (percent of the pane) for the loading skeleton's mono lines,
 * shaped like a code diff rather than uniform bars. Fixed, not random, so the
 * loading state never shimmers differently between visits.
 */
const LOADING_SKELETON_LINE_WIDTHS = ['92%', '68%', '80%', '44%', '74%', '58%', '86%', '38%', '70%', '62%', '50%', '78%'] as const;
/** Skeleton bar height matching the 12px mono diff line. */
const LOADING_SKELETON_LINE_HEIGHT = 12;

function isReadDiffScope(value: string | undefined): value is ReadDiffScope {
  return value === 'working' || value === 'staged' || value === 'branch';
}

/**
 * The per-file unified diff: fetched once on mount into the diff store,
 * computed with jsdiff, rendered as a FlashList of DiffLineCell rows inside a
 * horizontal ScrollView sized to the longest line (lines never wrap).
 */
export function FileDiffScreen(): React.JSX.Element {
  const theme = useTheme();
  const params = useLocalSearchParams<{ taskId: string; projectId: string; path: string; scope: string }>();
  const taskId = params.taskId ?? '';
  const projectId = params.projectId ?? '';
  const filePath = params.path ?? '';
  const scope: ReadDiffScope = isReadDiffScope(params.scope) ? params.scope : 'working';
  const { width: windowWidth } = useWindowDimensions();
  const [fetchFailed, setFetchFailed] = useState(false);

  useEffect(() => {
    if (taskId.length === 0 || projectId.length === 0 || filePath.length === 0) return;
    fetchDiffFileContent({ taskId, projectId, filePath, scope }).catch(() => setFetchFailed(true));
  }, [taskId, projectId, filePath, scope]);

  const content = useDiffStore((state) => state.byTaskId[taskId]?.contentByPath[filePath] ?? null);

  const lines = useMemo<DiffLine[]>(
    () => (content === null ? [] : buildUnifiedDiffLines(content.original, content.modified, { context: DIFF_CONTEXT_LINES })),
    [content],
  );

  const contentWidth = Math.max(
    Math.ceil(maxLineLength(lines) * MONO_CHARACTER_WIDTH_PX) + LINE_NUMBER_GUTTER_TOTAL_WIDTH_PX,
    windowWidth,
  );

  let body: React.JSX.Element;
  if (content === null && fetchFailed) {
    body = (
      <Stack gap="sm" style={styles.centered}>
        <Text variant="body" color="danger">
          Could not load this diff
        </Text>
      </Stack>
    );
  } else if (content === null) {
    body = (
      <View
        testID="file-diff-skeleton"
        style={[
          styles.flex,
          { backgroundColor: theme.colors.codeBackground, padding: theme.spacing.md, gap: theme.spacing.sm },
        ]}
      >
        {LOADING_SKELETON_LINE_WIDTHS.map((lineWidth, lineIndex) => (
          <Skeleton key={`file-diff-skeleton-line-${lineIndex}`} width={lineWidth} height={LOADING_SKELETON_LINE_HEIGHT} />
        ))}
      </View>
    );
  } else if (lines.length === 0) {
    body = (
      <Stack gap="sm" style={styles.centered}>
        <Text variant="body" color="secondary">
          No changes in this file
        </Text>
      </Stack>
    );
  } else {
    body = (
      <ScrollView horizontal style={styles.flex} contentContainerStyle={styles.growingContent}>
        <View style={{ width: contentWidth, backgroundColor: theme.colors.codeBackground }}>
          <FlashList<DiffLine>
            testID="file-diff-lines"
            data={lines}
            keyExtractor={(_line, index) => String(index)}
            getItemType={(line) => line.kind}
            renderItem={({ item }) => <DiffLineCell line={item} />}
          />
        </View>
      </ScrollView>
    );
  }

  // The header names the file; the banner keeps the full repo-relative path.
  const fileName = filePath.split('/').pop() ?? filePath;

  return (
    <Screen testID="file-diff-screen">
      {/*
        headerBackTitle is set explicitly because iOS derives the back button's
        label from the PREVIOUS screen's title, and the screen this is always
        pushed from - task/[taskId]/index - renders headerShown: false and so
        has no title to borrow. expo-router then falls back to the route's
        FILE PATH, and the back button read literally "task/[taskId]/index"
        on every iPhone. Android draws a bare chevron and never showed it,
        which is why it survived to a store screenshot.
      */}
      <RouterStack.Screen
        options={{
          title: fileName.length > 0 ? fileName : 'Changes',
          headerBackTitle: 'Session',
        }}
      />
      <View style={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }}>
        <MonoText size="caption" color="secondary" numberOfLines={1} testID="file-diff-path">
          {filePath}
        </MonoText>
      </View>
      {body}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  growingContent: {
    flexGrow: 1,
  },
  centered: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
