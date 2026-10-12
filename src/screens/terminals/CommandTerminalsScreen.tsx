import React, { useCallback, useEffect, useMemo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  ActivityMarkIcon,
  Button,
  NowTickProvider,
  Row,
  Stack,
  StatusSpinner,
  Text,
  sheetRowSurface,
  useNowTick,
  useTheme,
} from '@/components';
import { launchCommandTerminal, stopCommandTerminal } from '@/connection/actions';
import { formatActivityLine } from '@/lib/activityLine';
import { useActivityStore } from '@/state/activityStore';
import { COMMAND_TERMINAL_LIMIT, selectCommandTerminals, useBoardStore } from '@/state/boardStore';
import { useCommandTerminalStore } from '@/state/commandTerminalStore';
import { commandTerminalTone, projectTerminals, type ProjectTerminal } from './terminalDisplay';

/** Shown under the list while any row's Stop was refused (design change 3). */
export const STOP_FAILED_MESSAGE = 'Stop failed - check the connection';

const ROW_MARK_SIZE = 18;
const STOP_MARK_SIZE = 16;

/**
 * A project's Command Terminals, as a native form sheet route (design changes
 * 2 and 3): just the title, one raised row per terminal with its name over
 * what it is doing, a one-tap Stop on each, and New terminal, greyed out at
 * four with no text under it.
 *
 * A row opens its terminal by REPLACING this sheet rather than pushing over
 * it: a full screen pushed above a native form sheet opens inside the sheet's
 * own presentation on iOS. New does the same, so a start that fails routes
 * back to the Board.
 *
 * When the last terminal ends while the sheet is open, the sheet closes, and
 * the header button is back to its "new terminal" mark.
 */
export function CommandTerminalsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { projectId: projectIdParam } = useLocalSearchParams<{ projectId?: string }>();
  const projectId = projectIdParam !== undefined && projectIdParam.length > 0 ? projectIdParam : null;
  const listed = useBoardStore((state) => selectCommandTerminals(state, projectId));
  const launchesById = useCommandTerminalStore((state) => state.launchesById);
  const stopsBySessionId = useCommandTerminalStore((state) => state.stopsBySessionId);
  const terminals = useMemo(
    () => (projectId !== null ? projectTerminals(listed, Object.values(launchesById), projectId) : []),
    [listed, launchesById, projectId],
  );
  const anyNeedsYou = useActivityStore((state) =>
    terminals.some((terminal) => terminal.sessionId !== null && commandTerminalTone(state.bySessionId[terminal.sessionId] ?? null) === 'needs-you'),
  );
  const stopFailed = terminals.some((terminal) => terminal.sessionId !== null && stopsBySessionId[terminal.sessionId] === 'failed');
  const atLimit = terminals.length >= COMMAND_TERMINAL_LIMIT;

  // Closes once there is nothing left to list: the last terminal stopped or
  // ended while the sheet was open.
  const empty = terminals.length === 0;
  useEffect(() => {
    if (empty && router.canGoBack()) router.back();
  }, [empty, router]);

  const openTerminal = useCallback(
    (sessionId: string) => {
      if (projectId === null) return;
      router.replace({ pathname: '/command-terminal', params: { sessionId, projectId } });
    },
    [projectId, router],
  );

  const onNew = useCallback(() => {
    if (projectId === null) return;
    const launchId = launchCommandTerminal(projectId);
    router.replace({ pathname: '/command-terminal', params: { launchId, projectId } });
  }, [projectId, router]);

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.surfaceOverlay, padding: theme.spacing.lg, paddingBottom: theme.spacing.xl + insets.bottom }]}
      testID="command-terminals-sheet"
    >
      <NowTickProvider enabled={anyNeedsYou}>
        <Stack gap="sm">
          <Text variant="title">Command Terminals</Text>
          <Stack gap="xs">
            {terminals.map((terminal) => (
              <TerminalRow
                key={terminal.sessionId ?? `starting-${terminal.slot}`}
                terminal={terminal}
                stopping={terminal.sessionId !== null && stopsBySessionId[terminal.sessionId] === 'stopping'}
                onOpen={openTerminal}
              />
            ))}
          </Stack>
          {stopFailed ? (
            <Text variant="caption" color="danger" testID="command-terminals-stop-failed">
              {STOP_FAILED_MESSAGE}
            </Text>
          ) : null}
          <Button
            label="New terminal"
            leading={<ActivityMarkIcon mark="terminal-new" tone="rest" size={ROW_MARK_SIZE} />}
            variant="primary"
            disabled={atLimit || projectId === null}
            onPress={onNew}
            testID="command-terminals-new"
          />
        </Stack>
      </NowTickProvider>
    </View>
  );
}

/**
 * One terminal: its mark in its tone, its name over the desktop's words for
 * what it is doing, and a one-tap Stop. Stopping dims the row and reads
 * "Stopping..." until the desktop has ended it and the board drops the row.
 */
function TerminalRow({
  terminal,
  stopping,
  onOpen,
}: {
  terminal: ProjectTerminal;
  stopping: boolean;
  onOpen: (sessionId: string) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const nowMs = useNowTick();
  const sessionId = terminal.sessionId;
  const entry = useActivityStore((state) => (sessionId !== null ? (state.bySessionId[sessionId] ?? null) : null));
  const tone = commandTerminalTone(entry);
  const activityLine = stopping
    ? 'Stopping...'
    : entry !== null
      ? formatActivityLine(entry, nowMs)
      : 'Starting...';
  const testIdKey = sessionId ?? `starting-${terminal.slot}`;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${terminal.name}`}
      accessibilityState={{ disabled: sessionId === null || stopping }}
      disabled={sessionId === null || stopping}
      onPress={() => {
        if (sessionId !== null) onOpen(sessionId);
      }}
      testID={`command-terminal-row-${testIdKey}`}
      style={[styles.row, sheetRowSurface(theme), { minHeight: theme.minTouchSize, paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }]}
    >
      <Row gap="sm" style={[styles.rowContent, { opacity: stopping ? 0.5 : 1 }]}>
        <ActivityMarkIcon mark="terminal-idle" tone={stopping ? 'rest' : tone} size={ROW_MARK_SIZE} />
        <Stack gap="xs" style={styles.flex}>
          <Text variant="bodyStrong" numberOfLines={1}>
            {terminal.name}
          </Text>
          <Text variant="caption" color="muted" numberOfLines={1} testID={`command-terminal-row-${testIdKey}-activity`}>
            {activityLine}
          </Text>
        </Stack>
        {stopping ? (
          <View style={[styles.stopTarget, { minWidth: theme.minTouchSize, minHeight: theme.minTouchSize }]}>
            <StatusSpinner size={STOP_MARK_SIZE} color={theme.colors.textMuted} testID={`command-terminal-row-${testIdKey}-stopping`} />
          </View>
        ) : sessionId !== null ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Stop ${terminal.name}`}
            onPress={() => void stopCommandTerminal(sessionId)}
            testID={`command-terminal-row-${testIdKey}-stop`}
            style={({ pressed }) => [
              styles.stopButton,
              {
                minHeight: theme.minTouchSize,
                paddingHorizontal: theme.spacing.sm,
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.surface,
                borderColor: theme.colors.border,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <Row gap="xs" style={styles.rowContent}>
              <ActivityMarkIcon mark="control-stop-idle" tone="rest" size={STOP_MARK_SIZE} />
              <Text variant="caption" color="secondary">
                Stop
              </Text>
            </Row>
          </Pressable>
        ) : null}
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    // Deliberately not flex: 1 - 'fitToContents' needs measurable content.
    width: '100%',
  },
  row: {
    justifyContent: 'center',
  },
  rowContent: {
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
  stopTarget: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopButton: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
