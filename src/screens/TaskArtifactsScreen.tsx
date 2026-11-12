import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ExternalLink, Link2 } from 'lucide-react-native';
import { SheetActionRow, SheetScrollerSlot, Stack, Text, useTheme } from '@/components';
import { ARTIFACTS_SHEET_RESERVED_HEIGHT, LIST_FLOOR_HEIGHT, clampSheetContentHeight } from '@/lib/sheetContentHeights';
import type { TaskArtifactLink } from '@/lib/taskArtifacts';
import { reportHandledError } from '@/observability/crashReporting';
import { ARTIFACT_OPEN_FAILED_MESSAGE, openArtifactLink, useTaskArtifactLinks } from './artifacts/taskArtifactLinks';

/** The hub's glyph size (SheetActionRow's icons). */
const ROW_GLYPH_SIZE = 20;
const TRAILING_GLYPH_SIZE = 16;

/**
 * A task's links (protocol 0.28.0) as a native form sheet: the desktop's
 * Artifacts menu (`ArtifactsMenu.tsx`), for a task with more than one. Opened
 * from the long-press hub's Artifacts row, the one place the phone shows a
 * task's links (design decisions D2 and E2: no header button, no completed
 * strip chip); a single link opens from the hub's row directly.
 *
 * One raised row per link: its name, and under it the site it lives on, where
 * the desktop names the tool (the wire carries no platform, so no logo). A tap
 * opens it in the OS handler and closes the sheet; a link the OS refuses keeps
 * the sheet open and says so. A capped ScrollView, as the Workflows sheet's:
 * the desktop sends at most 20 links a task, and the cap is about the sheet's
 * height, not about virtualizing a list that grows without bound.
 */
export function TaskArtifactsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { taskId } = useLocalSearchParams<{ taskId?: string }>();
  const links = useTaskArtifactLinks(taskId !== undefined && taskId.length > 0 ? taskId : null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const listMaxHeight = clampSheetContentHeight({
    windowHeight,
    reservedHeight: ARTIFACTS_SHEET_RESERVED_HEIGHT + insets.bottom,
    floorHeight: LIST_FLOOR_HEIGHT,
  });

  // A late open resolving after the sheet was swiped away must not pop
  // whatever screen is on top by then.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const openLink = useCallback(
    (link: TaskArtifactLink) => {
      setErrorMessage(null);
      openArtifactLink(link).then(
        () => {
          if (mountedRef.current && router.canGoBack()) router.back();
        },
        (error: unknown) => {
          reportHandledError('task-artifact-open', error);
          if (mountedRef.current) setErrorMessage(ARTIFACT_OPEN_FAILED_MESSAGE);
        },
      );
    },
    [router],
  );

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.surfaceOverlay, padding: theme.spacing.lg, paddingBottom: theme.spacing.xl + insets.bottom }]}
      testID="task-artifacts-sheet"
    >
      <Stack gap="sm">
        <Text variant="title">Artifacts</Text>
        <SheetScrollerSlot>
          <ScrollView style={{ maxHeight: listMaxHeight }} keyboardShouldPersistTaps="handled" testID="task-artifacts-list">
            <Stack gap="xs">
              {links.map((link, index) => (
                <SheetActionRow
                  key={`${index}-${link.url}`}
                  label={link.name}
                  caption={link.host}
                  glyph={<Link2 size={ROW_GLYPH_SIZE} color={theme.colors.textSecondary} />}
                  trailing={<ExternalLink size={TRAILING_GLYPH_SIZE} color={theme.colors.textMuted} />}
                  singleLineLabel
                  accessibilityRole="link"
                  onPress={() => openLink(link)}
                  disabled={false}
                  testID={`task-artifacts-row-${index}`}
                />
              ))}
            </Stack>
          </ScrollView>
        </SheetScrollerSlot>
        {errorMessage !== null ? (
          <Text variant="caption" color="danger" testID="task-artifacts-error">
            {errorMessage}
          </Text>
        ) : null}
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Not flex: 1 - 'fitToContents' needs measurable content.
    width: '100%',
  },
});
