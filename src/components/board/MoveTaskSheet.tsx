import React, { useCallback, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import type { BoardColumnWire, BoardTaskWire } from '@kangentic/protocol';
import { Button, Icon, Row, Sheet, Stack, Text, useTheme } from '@/components';

export interface MoveTaskSheetProps {
  visible: boolean;
  task: BoardTaskWire | null;
  columns: BoardColumnWire[];
  onClose: () => void;
  /** targetPosition: 0 for top; the target column's task count for bottom. */
  onMove: (targetSwimlaneId: string, position: 'top' | 'bottom') => void;
  moveInFlight: boolean;
  errorMessage: string | null;
}

/** Long-press move flow: pick a column and top/bottom, confirm. Drag-and-drop across a one-column-at-a-time pager is a later refinement. */
export function MoveTaskSheet({ visible, task, columns, onClose, onMove, moveInFlight, errorMessage }: MoveTaskSheetProps): React.JSX.Element {
  const theme = useTheme();
  const [selectedColumnId, setSelectedColumnId] = useState<string | null>(null);
  const [position, setPosition] = useState<'top' | 'bottom'>('bottom');

  const close = useCallback(() => {
    setSelectedColumnId(null);
    setPosition('bottom');
    onClose();
  }, [onClose]);

  const confirm = useCallback(() => {
    if (selectedColumnId) onMove(selectedColumnId, position);
  }, [onMove, selectedColumnId, position]);

  return (
    <Sheet visible={visible} onClose={close} title={task ? `Move "${task.title}"` : 'Move task'} testID="move-task-sheet">
      <Stack gap="sm">
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
                  backgroundColor: isSelected ? theme.colors.surfaceRaised : 'transparent',
                  opacity: isCurrent ? 0.4 : 1,
                },
              ]}
            >
              <Row gap="sm" style={styles.columnRowContent}>
                <Icon name={isSelected ? 'radio-button-on' : 'radio-button-off'} color={isSelected ? 'accent' : 'secondary'} size={20} />
                <Text variant="body" style={styles.flex}>
                  {column.name}
                </Text>
                {isCurrent ? (
                  <Text variant="caption" color="muted">
                    current
                  </Text>
                ) : null}
              </Row>
            </Pressable>
          );
        })}

        <Row gap="sm">
          <PositionToggle label="Top" active={position === 'top'} onPress={() => setPosition('top')} testID="move-position-top" />
          <PositionToggle label="Bottom" active={position === 'bottom'} onPress={() => setPosition('bottom')} testID="move-position-bottom" />
        </Row>

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

function PositionToggle({
  label,
  active,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
  testID: string;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[
        styles.positionToggle,
        {
          minHeight: theme.minTouchSize,
          borderRadius: theme.radii.md,
          borderColor: active ? theme.colors.accent : theme.colors.border,
          backgroundColor: active ? theme.colors.surfaceRaised : 'transparent',
        },
      ]}
    >
      <Text variant="body" color={active ? 'primary' : 'secondary'}>
        {label}
      </Text>
    </Pressable>
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
  positionToggle: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
