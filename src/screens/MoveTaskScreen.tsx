import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, Icon, Row, Stack, Text, useTheme } from '@/components';
import { CapabilityError } from '@/channel';
import { moveTaskOptimistic } from '@/connection/actions';
import { findTaskById, selectColumnsOrdered, selectColumnTaskCount, useBoardStore } from '@/state/boardStore';
import { triggerHaptic } from '@/lib/haptics';

/**
 * Move a task to another column, as a native form sheet route.
 *
 * Being a route also collapses three copies of this flow into one: the board,
 * the triage feed and the session screen each held their own visible/inFlight/
 * error state and their own moveTaskOptimistic call. They now all navigate
 * here, so the target-position rule (always append to the bottom of the target
 * column, the one true Kanban convention) is stated once.
 */
export function MoveTaskScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { taskId, projectId } = useLocalSearchParams<{ taskId?: string; projectId?: string }>();

  // Select stable store references only; derive the arrays with useMemo. A
  // selector that returns a fresh array every render loops useSyncExternalStore.
  const board = useBoardStore((state) => (projectId ? (state.boardsByProjectId[projectId] ?? null) : null));
  const task = useBoardStore((state) => (taskId ? (findTaskById(state, taskId)?.task ?? null) : null));
  const columns = useMemo(() => (board ? selectColumnsOrdered(board) : []), [board]);

  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
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
        {columns.map((column) => {
          const isCurrent = task?.swimlane_id === column.id;
          const isSelected = selectedColumnId === column.id;
          return (
            <Pressable
              key={column.id}
              testID={`move-target-${column.id}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected, disabled: isCurrent }}
              disabled={isCurrent}
              onPress={() => setSelectedColumnId(column.id)}
              style={[
                styles.columnRow,
                {
                  minHeight: theme.minTouchSize,
                  paddingHorizontal: theme.spacing.md,
                  borderRadius: theme.radii.md,
                  backgroundColor: isCurrent
                    ? theme.colors.accentSubtle
                    : isSelected
                      ? theme.colors.surfaceRaised
                      : 'transparent',
                },
              ]}
            >
              <Row gap="sm" style={styles.columnRowContent}>
                <Icon
                  name={isSelected ? 'radio-button-on' : 'radio-button-off'}
                  color={isSelected ? 'accent' : 'secondary'}
                  size={20}
                />
                <Text variant="body" style={styles.flex}>
                  {column.name}
                </Text>
                {isCurrent ? (
                  // Hand-rolled rather than the shared Badge primitive: Badge
                  // has no accent-tinted fill variant, so it cannot reproduce
                  // this accentMuted stadium look without extending it.
                  <View
                    style={[styles.currentBadge, { backgroundColor: theme.colors.accentMuted, borderRadius: theme.radii.full }]}
                  >
                    <Text variant="caption" color="accent" style={styles.currentBadgeText}>
                      Current
                    </Text>
                  </View>
                ) : null}
              </Row>
            </Pressable>
          );
        })}

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
  currentBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  currentBadgeText: {
    fontWeight: '600',
  },
  flex: {
    flex: 1,
  },
});
