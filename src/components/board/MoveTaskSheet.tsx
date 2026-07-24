import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { BoardColumnWire, BoardTaskWire } from '@kangentic/protocol';
import { Button, Icon, Row, Sheet, Stack, Text, useTheme } from '@/components';

export interface MoveTaskSheetProps {
  visible: boolean;
  task: BoardTaskWire | null;
  columns: BoardColumnWire[];
  onClose: () => void;
  /** Always lands the task at the bottom of the target column - the one true Kanban "append" convention; no top/bottom choice. */
  onMove: (targetSwimlaneId: string) => void;
  moveInFlight: boolean;
  errorMessage: string | null;
}

/** Long-press move flow: pick a column, confirm. Drag-and-drop across a one-column-at-a-time pager is a later refinement. */
export function MoveTaskSheet({ visible, task, columns, onClose, onMove, moveInFlight, errorMessage }: MoveTaskSheetProps): React.JSX.Element {
  const theme = useTheme();
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);

  // This component stays mounted across opens (only the inner Sheet unmounts
  // on hide), and every caller closes a successful move by flipping `visible`
  // rather than routing through `close`, so without this the selection would
  // survive into the next open - pre-enabling Move with no visible choice and,
  // in the multi-project Triage reuse, firing a move to a column absent from
  // the next task's board. Reset whenever the sheet hides, adjusted during
  // render (not a useEffect) so it lands before the hidden frame ever commits.
  const [previousVisible, setPreviousVisible] = useState(visible);
  if (visible !== previousVisible) {
    setPreviousVisible(visible);
    if (!visible) setSelectedColumnId(null);
  }

  const close = useCallback(() => {
    setSelectedColumnId(null);
    onClose();
  }, [onClose]);

  const confirm = useCallback(() => {
    if (selectedColumnId) onMove(selectedColumnId);
  }, [onMove, selectedColumnId]);

  return (
    <Sheet visible={visible} onClose={close} title="Move" testID="move-task-sheet">
      <Stack gap="sm">
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
                <Icon name={isSelected ? 'radio-button-on' : 'radio-button-off'} color={isSelected ? 'accent' : 'secondary'} size={20} />
                <Text variant="body" style={styles.flex}>
                  {column.name}
                </Text>
                {isCurrent ? (
                  // Hand-rolled rather than the shared Badge primitive: Badge
                  // has no accent-tinted fill variant, so it cannot reproduce
                  // this accentMuted stadium look without extending it.
                  <View
                    style={[
                      styles.currentBadge,
                      { backgroundColor: theme.colors.accentMuted, borderRadius: theme.radii.full },
                    ]}
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
    </Sheet>
  );
}

const styles = StyleSheet.create({
  columnRow: {
    justifyContent: 'center',
  },
  columnRowContent: {
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
  currentBadge: {
    paddingHorizontal: 8,
    paddingVertical: 2,
  },
  currentBadgeText: {
    fontWeight: '600',
  },
});
