import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Badge, Button, Icon, Row, SheetScrollerSlot, Stack, Text, sheetRowSurface, useTheme } from '@/components';
import { CapabilityError } from '@/channel';
import { moveTaskOptimistic } from '@/connection/actions';
import { findTaskById, selectColumnsOrdered, selectColumnTaskCount, useBoardStore } from '@/state/boardStore';
import { triggerHaptic } from '@/lib/haptics';
import { workflowMoveTargetIds } from '@/workflow/workflowMove';
import { normalizeWorkflowState } from '@/workflow/workflowState';
import {
  clampSheetContentHeight,
  LIST_FLOOR_HEIGHT,
  MOVE_SHEET_RESERVED_HEIGHT,
} from '@/lib/sheetContentHeights';

/** The current column is not a target, so it recedes behind the choices. */
const CURRENT_COLUMN_OPACITY = 0.55;
/** A column a workflow refuses: the disabled strength every sheet row uses (SheetActionRow). */
const REFUSED_COLUMN_OPACITY = 0.4;

/**
 * Move a task to another column, as a native form sheet route.
 *
 * Being a route also collapses three copies of this flow into one: the board,
 * the triage feed and the session screen each held their own visible/inFlight/
 * error state and their own moveTaskOptimistic call. They now all navigate
 * here, so the target-position rule (always append to the bottom of the target
 * column, the one true Kanban convention) is stated once.
 */
/**
 * Keeps the column list inside the sheet rather than growing it past the
 * screen: 'fitToContents' sizes the sheet to its content, so a board with
 * enough columns would otherwise push the Move button below the fold with no
 * way to scroll down to it. The cap derives from the window height, and the
 * reserve (everything else this sheet needs around the list) is budgeted in
 * sheetContentHeights.ts next to the math that consumes it.
 *
 * A capped ScrollView rather than a FlashList because a board's columns are a
 * handful, set by hand on the desktop - the cap is about the sheet's height,
 * not about virtualizing a list that grows without bound.
 */
export function MoveTaskScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { taskId, projectId } = useLocalSearchParams<{ taskId?: string; projectId?: string }>();
  const listMaxHeight = clampSheetContentHeight({
    windowHeight,
    reservedHeight: MOVE_SHEET_RESERVED_HEIGHT + insets.bottom,
    floorHeight: LIST_FLOOR_HEIGHT,
  });

  // Select stable store references only; derive the arrays with useMemo. A
  // selector that returns a fresh array every render loops useSyncExternalStore.
  const board = useBoardStore((state) => (projectId ? (state.boardsByProjectId[projectId] ?? null) : null));
  const task = useBoardStore((state) => (taskId ? (findTaskById(state, taskId)?.task ?? null) : null));
  const columns = useMemo(() => (board ? selectColumnsOrdered(board) : []), [board]);

  // The columns a hand may move this task to (protocol 0.21.0): every other
  // column for an ordinary task; for a workflow task, the desktop's rule
  // (workflowAllowsMove). A refused column stays listed and disabled, with no
  // reason, as the desktop's menu keeps it (design sign-off, screens 3 to 5).
  const allowedColumnIds = useMemo(() => (task ? workflowMoveTargetIds(task, columns) : new Set<string>()), [task, columns]);

  const [chosenColumnId, setChosenColumnId] = useState<string | null>(null);
  // A running workflow's human gate is chosen already (screen 4). Keyed on the
  // gate itself, never on "one column open": a paused card on a three-column
  // board has only Done open, and pre-choosing it would put the archive the
  // hub refuses one tap away. A pick a newer row has since refused falls back
  // to the gate, or to nothing.
  const gateTargetId = task?.workflow && normalizeWorkflowState(task.workflow.state) === 'running' ? task.workflow.gate_target_id : null;
  const gateColumnId = gateTargetId !== null && allowedColumnIds.has(gateTargetId) ? gateTargetId : null;
  const selectedColumnId = chosenColumnId !== null && allowedColumnIds.has(chosenColumnId) ? chosenColumnId : gateColumnId;
  const [moveInFlight, setMoveInFlight] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const confirm = useCallback(() => {
    if (!selectedColumnId || !projectId || !taskId || !board) return;
    setMoveInFlight(true);
    setErrorMessage(null);
    void moveTaskOptimistic({
      projectId,
      taskId,
      targetSwimlaneId: selectedColumnId,
      targetPosition: selectColumnTaskCount(board, selectedColumnId),
    })
      .then(() => {
        triggerHaptic('taskMoved');
        router.back();
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof CapabilityError ? error.message : 'Move failed - check the connection');
      })
      .finally(() => setMoveInFlight(false));
  }, [selectedColumnId, projectId, taskId, board, router]);

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: theme.colors.surfaceOverlay,
          padding: theme.spacing.lg,
          paddingBottom: theme.spacing.xl + insets.bottom,
        },
      ]}
      testID="move-task-sheet"
    >
      <Stack gap="sm">
        <Text variant="title">Move</Text>
        {task ? (
          <Text variant="body" color="secondary" numberOfLines={2}>
            {task.title}
          </Text>
        ) : null}
        <SheetScrollerSlot>
          <ScrollView
            style={{ maxHeight: listMaxHeight }}
            contentContainerStyle={{ paddingBottom: theme.spacing.sm }}
            keyboardShouldPersistTaps="handled"
            testID="move-target-list"
          >
            {columns.map((column) => {
              const isCurrent = task?.swimlane_id === column.id;
              const isRefused = !isCurrent && !allowedColumnIds.has(column.id);
              const isSelected = selectedColumnId === column.id;
              return (
                <Pressable
                  key={column.id}
                  testID={`move-target-${column.id}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected, disabled: isCurrent || isRefused }}
                  disabled={isCurrent || isRefused}
                  onPress={() => setChosenColumnId(column.id)}
                  // One highlight, for the user's pick: the current column is
                  // not a choice (you cannot move a task to where it is), so it
                  // fades with a quiet tag rather than wearing the accent too.
                  style={[
                    styles.columnRow,
                    sheetRowSurface(theme, isSelected),
                    {
                      minHeight: theme.minTouchSize,
                      paddingHorizontal: theme.spacing.md,
                      marginBottom: theme.spacing.xs,
                      opacity: isCurrent ? CURRENT_COLUMN_OPACITY : isRefused ? REFUSED_COLUMN_OPACITY : 1,
                    },
                  ]}
                >
                  <Row gap="sm" style={styles.columnRowContent}>
                    <Icon
                      name={isSelected ? 'radio-button-on' : 'radio-button-off'}
                      color={isSelected ? 'accent' : isCurrent ? 'muted' : 'secondary'}
                      size={20}
                    />
                    <Text variant="body" color={isCurrent ? 'secondary' : 'primary'} style={styles.flex}>
                      {column.name}
                    </Text>
                    {isCurrent ? <Badge label="Current" shape="pill" align="center" testID={`move-target-${column.id}-current`} /> : null}
                  </Row>
                </Pressable>
              );
            })}
          </ScrollView>
        </SheetScrollerSlot>

        {errorMessage ? (
          <Text variant="caption" color="danger">
            {errorMessage}
          </Text>
        ) : null}

        <View style={{ marginTop: theme.spacing.xs }}>
          <Button
            label={moveInFlight ? 'Moving...' : 'Move'}
            onPress={confirm}
            disabled={selectedColumnId === null || moveInFlight}
            testID="move-confirm"
          />
        </View>
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  columnRow: {
    justifyContent: 'center',
  },
  columnRowContent: {
    alignItems: 'center',
  },
  container: {
    // Deliberately not flex: 1 - 'fitToContents' needs measurable content.
    width: '100%',
  },
  flex: {
    flex: 1,
  },
});
