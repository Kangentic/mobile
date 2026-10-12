import React, { useCallback } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ActivityMarkIcon, Icon, SheetActionRow, Stack, Text, useTheme } from '@/components';
import { stopCommandTerminal } from '@/connection/actions';
import { COMMAND_TERMINAL_FALLBACK_NAME, selectCommandTerminal, useBoardStore } from '@/state/boardStore';

/**
 * A Command Terminal's long-press sheet on the Agents feed (design change 19):
 * the task actions hub's family (the terminal's name, raised rows), with the
 * two actions a terminal has. "Stop terminal" is the desktop's own label; one
 * tap stops it (change 3) and closes the sheet. No Move, Edit, Archive or
 * Delete: a terminal has no task to act on.
 *
 * Open REPLACES this sheet with the terminal's screen, for the reason the
 * Terminals sheet does (CommandTerminalsScreen): a screen pushed after a native
 * modal is expected to open inside it on iOS.
 */
export function CommandTerminalActionsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { sessionId: sessionIdParam, projectId: projectIdParam } = useLocalSearchParams<{ sessionId?: string; projectId?: string }>();
  const sessionId = sessionIdParam !== undefined && sessionIdParam.length > 0 ? sessionIdParam : null;
  const projectId = projectIdParam !== undefined && projectIdParam.length > 0 ? projectIdParam : null;
  const terminal = useBoardStore((state) => selectCommandTerminal(state, sessionId));

  const onOpen = useCallback(() => {
    if (sessionId === null || projectId === null) return;
    router.replace({ pathname: '/command-terminal', params: { sessionId, projectId } });
  }, [sessionId, projectId, router]);

  const onStop = useCallback(() => {
    if (sessionId === null) return;
    void stopCommandTerminal(sessionId);
    router.back();
  }, [sessionId, router]);

  const unavailable = sessionId === null || projectId === null || terminal === null;

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.surfaceOverlay, padding: theme.spacing.lg, paddingBottom: theme.spacing.xl + insets.bottom }]}
      testID="command-terminal-actions-sheet"
    >
      <Stack gap="xs">
        <Text variant="title" numberOfLines={2}>
          {terminal?.name ?? COMMAND_TERMINAL_FALLBACK_NAME}
        </Text>
        <SheetActionRow
          label="Open terminal"
          glyph={<Icon name="terminal" color="secondary" size={20} />}
          onPress={onOpen}
          disabled={unavailable}
          testID="command-terminal-action-open"
        />
        <SheetActionRow
          label="Stop terminal"
          glyph={<ActivityMarkIcon mark="control-stop-idle" tone="danger" size={20} />}
          color="danger"
          onPress={onStop}
          disabled={unavailable}
          testID="command-terminal-action-stop"
        />
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Deliberately not flex: 1 - 'fitToContents' needs measurable content.
    width: '100%',
  },
});
