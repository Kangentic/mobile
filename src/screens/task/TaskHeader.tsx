import React, { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GitCompareArrows } from 'lucide-react-native';
import type { BoardColumnWire } from '@kangentic/protocol';
import { AgentStatusIcon, ConnectionBanner, IconButton, MonoText, Row, Text, useTheme } from '@/components';
import { getColumnIcon } from '@/components/board/columnIcons';
import { sectionForEntry, useActivityStore } from '@/state/activityStore';
import { findTaskById, selectTaskColumn, useBoardStore } from '@/state/boardStore';

export interface TaskHeaderProps {
  taskTitle: string;
  sessionId: string | null;
  /** The task's #N, shown top-right when the board's Ticket Numbers setting is on (pass null to hide). */
  displayId?: number | null;
  /**
   * When set, the header shows the task's current-column chip: tap opens the
   * move-task sheet, long-press the actions hub. Renders only once a cached
   * board locates the task (an unlocated task has no column and nothing to
   * move within; MoveTaskScreen renders a dead sheet on a null board).
   * CompletedTaskScreen passes nothing: archived tasks are on no board.
   */
  taskId?: string | null;
  /** When set, the header shows the Changes chip (the Session screen's second destination). */
  onOpenChanges?: () => void;
}

const COLUMN_CHIP_MAX_WIDTH = 120;
const COLUMN_CHIP_ICON_SIZE = 14;
const COLUMN_CHIP_DOT_SIZE = 8;

export function TaskHeader({ taskTitle, sessionId, displayId = null, taskId = null, onOpenChanges }: TaskHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const activityEntry = useActivityStore((state) => (sessionId ? (state.bySessionId[sessionId] ?? null) : null));
  const column = useBoardStore((state) => (taskId ? selectTaskColumn(state, taskId) : null));
  // locatedProjectId deliberately, never a route-param fallback: MoveTaskScreen
  // needs the board that actually HOLDS the task, which is findTaskById's
  // project by construction; a param only bridges the pre-snapshot window,
  // where the chip is hidden anyway.
  const locatedProjectId = useBoardStore((state) => (taskId ? (findTaskById(state, taskId)?.projectId ?? null) : null));
  const showColumnChip = column !== null && locatedProjectId !== null;

  const openMoveSheet = useCallback(() => {
    if (!taskId || !locatedProjectId) return;
    router.push({ pathname: '/move-task', params: { taskId, projectId: locatedProjectId } });
  }, [router, taskId, locatedProjectId]);

  const openActionsSheet = useCallback(() => {
    if (!taskId || !locatedProjectId) return;
    router.push({ pathname: '/task-actions', params: { taskId, projectId: locatedProjectId } });
  }, [router, taskId, locatedProjectId]);

  return (
    <>
      <Row
        gap="sm"
        style={[
          styles.header,
          {
            paddingTop: insets.top,
            paddingHorizontal: theme.spacing.xs,
            backgroundColor: theme.colors.surface,
            borderBottomColor: theme.colors.border,
          },
        ]}
      >
        <IconButton iconName="chevron-back" onPress={() => router.back()} testID="task-back-button" accessibilityLabel="Back" />
        {/* The same status language as the feed and board cards: green
            spinner while working, yellow mail for every idle state. */}
        {activityEntry ? (
          <AgentStatusIcon
            kind={sectionForEntry(activityEntry) === 'working' ? 'working' : 'idle'}
            testID="task-header-status"
          />
        ) : null}
        <Text variant="bodyStrong" numberOfLines={1} style={styles.title}>
          {taskTitle}
        </Text>
        {displayId !== null ? (
          // The header row's own padding is only xs; whichever element is
          // last carries an sm margin so it does not kiss the screen edge -
          // the column chip when it renders, this number otherwise.
          <MonoText
            size="caption"
            color="muted"
            style={{ marginRight: showColumnChip ? 0 : theme.spacing.sm }}
            testID="task-header-display-id"
          >
            #{displayId}
          </MonoText>
        ) : null}
        {column && locatedProjectId ? (
          <ColumnChip column={column} onPress={openMoveSheet} onLongPress={openActionsSheet} />
        ) : null}
        {onOpenChanges ? (
          // Icon-only with a full touch target: the title keeps its room and
          // the affordance still reads as a button (raised circle, pressed dim).
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="View changes"
            testID="task-header-changes"
            onPress={onOpenChanges}
            style={({ pressed }) => [
              styles.changesButton,
              {
                width: theme.minTouchSize,
                height: theme.minTouchSize,
                borderRadius: theme.minTouchSize / 2,
                backgroundColor: theme.colors.surfaceRaised,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <GitCompareArrows size={20} color={theme.colors.textSecondary} />
          </Pressable>
        ) : null}
      </Row>
      <ConnectionBanner />
    </>
  );
}

/**
 * The task's current column: status first (the session view has no other
 * indication of where the task sits), command second (tap = move sheet,
 * long-press = actions hub). A compact raised pill at caption volume, in the
 * header's own affordance language (raised fill, pressed dim, no outline) -
 * a bordered chip here read as a foreign button next to the plain title and
 * #N. The 44pt touch box lives on the invisible Pressable around the pill,
 * and the width cap keeps a long column name from squeezing the flex title
 * past its ellipsis.
 */
function ColumnChip({
  column,
  onPress,
  onLongPress,
}: {
  column: BoardColumnWire;
  onPress: () => void;
  onLongPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const ColumnIcon = getColumnIcon(column);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Move task, currently in ${column.name}`}
      testID="task-header-column"
      onPress={onPress}
      onLongPress={onLongPress}
      style={[styles.columnChipTarget, { minHeight: theme.minTouchSize, marginRight: theme.spacing.sm }]}
    >
      {({ pressed }) => (
        <Row
          gap="xs"
          style={[
            styles.columnChipPill,
            {
              borderRadius: theme.radii.full,
              paddingHorizontal: theme.spacing.sm,
              paddingVertical: theme.spacing.xs,
              backgroundColor: theme.colors.surfaceRaised,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          {/* ColumnChipBar's icon fallback, verbatim: the desktop's column icon
              tinted with the column's color, a plain color dot for a column
              with neither a custom icon nor a role default. */}
          {ColumnIcon !== null ? (
            <ColumnIcon size={COLUMN_CHIP_ICON_SIZE} color={column.color} strokeWidth={2} />
          ) : column.color ? (
            <View style={[styles.columnDot, { backgroundColor: column.color }]} />
          ) : null}
          <Text variant="caption" color="secondary" numberOfLines={1} style={styles.columnChipLabel}>
            {column.name}
          </Text>
        </Row>
      )}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    flex: 1,
  },
  changesButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  columnChipTarget: {
    justifyContent: 'center',
    maxWidth: COLUMN_CHIP_MAX_WIDTH,
    flexShrink: 0,
  },
  columnChipPill: {
    alignItems: 'center',
  },
  columnChipLabel: {
    flexShrink: 1,
  },
  columnDot: {
    width: COLUMN_CHIP_DOT_SIZE,
    height: COLUMN_CHIP_DOT_SIZE,
    borderRadius: COLUMN_CHIP_DOT_SIZE / 2,
  },
});
