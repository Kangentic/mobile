import React, { useCallback, useEffect, useState } from 'react';
import { Pressable, StyleSheet } from 'react-native';
import type { BoardTaskWire } from '@kangentic/protocol';
import { Icon, Row, Sheet, Stack, Text, useTheme, type TextColorRole } from '@/components';

export interface TaskActionsSheetProps {
  visible: boolean;
  task: BoardTaskWire | null;
  /** False when the board has no done-role column (archive is a move into it). */
  archiveAvailable: boolean;
  onClose: () => void;
  onMove: () => void;
  onEdit: () => void;
  onArchive: () => void;
  onDelete: () => void;
  actionInFlight: boolean;
  errorMessage: string | null;
}

/** How long the armed delete confirmation stays armed before it relaxes back. */
const DELETE_CONFIRM_WINDOW_MS = 5000;

/**
 * The long-press hub for a board card: the full task lifecycle from the
 * phone. Delete is a two-step in-sheet confirm (tap arms it, a second tap
 * within the window fires) - no system Alert, so it stays themed and
 * Maestro-testable. Deleting also kills the task's live desktop session.
 */
export function TaskActionsSheet({
  visible,
  task,
  archiveAvailable,
  onClose,
  onMove,
  onEdit,
  onArchive,
  onDelete,
  actionInFlight,
  errorMessage,
}: TaskActionsSheetProps): React.JSX.Element {
  const [deleteArmed, setDeleteArmed] = useState(false);

  useEffect(() => {
    if (!deleteArmed) return;
    const disarmTimer = setTimeout(() => setDeleteArmed(false), DELETE_CONFIRM_WINDOW_MS);
    return () => clearTimeout(disarmTimer);
  }, [deleteArmed]);

  const close = useCallback(() => {
    setDeleteArmed(false);
    onClose();
  }, [onClose]);

  const onDeletePress = useCallback(() => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setDeleteArmed(false);
    onDelete();
  }, [deleteArmed, onDelete]);

  return (
    <Sheet visible={visible} onClose={close} title={task ? task.title : 'Task'} testID="task-actions-sheet">
      <Stack gap="xs">
        <ActionRow
          label="Move to column"
          iconName="swap-horizontal"
          onPress={onMove}
          disabled={actionInFlight}
          testID="task-action-move"
        />
        <ActionRow
          label="Edit task"
          iconName="create"
          onPress={onEdit}
          disabled={actionInFlight}
          testID="task-action-edit"
        />
        <ActionRow
          label="Archive (move to Done)"
          iconName="archive"
          onPress={onArchive}
          disabled={actionInFlight || !archiveAvailable}
          caption={archiveAvailable ? null : 'No Done column on this board'}
          testID="task-action-archive"
        />
        <ActionRow
          label={deleteArmed ? 'Tap again to delete' : 'Delete task'}
          iconName="trash"
          color="danger"
          onPress={onDeletePress}
          disabled={actionInFlight}
          caption={deleteArmed ? 'Removes the task and stops its session on your desktop' : null}
          testID={deleteArmed ? 'task-action-delete-confirm' : 'task-action-delete'}
        />
        {errorMessage ? (
          <Text variant="caption" color="danger">
            {errorMessage}
          </Text>
        ) : null}
      </Stack>
    </Sheet>
  );
}

function ActionRow({
  label,
  iconName,
  onPress,
  disabled,
  testID,
  color = 'primary',
  caption = null,
}: {
  label: string;
  iconName: React.ComponentProps<typeof Icon>['name'];
  onPress: () => void;
  disabled: boolean;
  testID: string;
  color?: TextColorRole;
  caption?: string | null;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={[
        styles.actionRow,
        {
          minHeight: theme.minTouchSize,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.radii.md,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Row gap="sm" style={styles.actionRowContent}>
        <Icon name={iconName} color={color === 'danger' ? 'danger' : 'secondary'} size={20} />
        <Stack gap="xs" style={styles.flex}>
          <Text variant="body" color={color}>
            {label}
          </Text>
          {caption ? (
            <Text variant="caption" color="muted">
              {caption}
            </Text>
          ) : null}
        </Stack>
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    justifyContent: 'center',
    paddingVertical: 8,
  },
  actionRowContent: {
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
});
