import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import type { BoardColumnWire } from '@kangentic/protocol';
import { Button, Sheet, Stack, Text, TextField, useTheme } from '@/components';

export interface CreateTaskSheetProps {
  visible: boolean;
  columns: BoardColumnWire[];
  /** The column the pager is showing - the default target. */
  initialColumnName: string | null;
  onClose: () => void;
  /** column is the NAME string (the desktop's create_task resolves by name; 'Backlog' creates a backlog item). */
  onCreate: (input: { title: string; description: string; column: string }) => void;
  createInFlight: boolean;
  errorMessage: string | null;
}

const BACKLOG_COLUMN_NAME = 'Backlog';

export function CreateTaskSheet({
  visible,
  columns,
  initialColumnName,
  onClose,
  onCreate,
  createInFlight,
  errorMessage,
}: CreateTaskSheetProps): React.JSX.Element {
  const theme = useTheme();
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // null = the user has not picked yet: the selection FOLLOWS the visible
  // column until an explicit tap, and close() clears the explicit pick, so
  // no effect is needed to re-sync on open.
  const [pickedColumnName, setPickedColumnName] = useState<string | null>(null);
  const columnName = pickedColumnName ?? initialColumnName ?? columns[0]?.name ?? BACKLOG_COLUMN_NAME;

  const close = useCallback(() => {
    setTitle('');
    setDescription('');
    setPickedColumnName(null);
    onClose();
  }, [onClose]);

  const confirm = useCallback(() => {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0) return;
    onCreate({ title: trimmedTitle, description: description.trim(), column: columnName });
  }, [onCreate, title, description, columnName]);

  const columnChoices = [...columns.map((column) => column.name), BACKLOG_COLUMN_NAME];

  return (
    <Sheet visible={visible} onClose={close} title="New task" testID="create-task-sheet">
      <Stack gap="sm">
        <TextField
          value={title}
          onChangeText={setTitle}
          placeholder="Title"
          testID="create-task-title"
          autoFocus
        />
        <TextField
          value={description}
          onChangeText={setDescription}
          placeholder="Description (optional)"
          multiline
          testID="create-task-description"
        />
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={[styles.columnChips, { gap: theme.spacing.xs }]}>
            {columnChoices.map((choiceName) => {
              const isSelected = columnName === choiceName;
              return (
                <Pressable
                  key={choiceName}
                  testID={`create-task-column-${choiceName}`}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: isSelected }}
                  onPress={() => setPickedColumnName(choiceName)}
                  style={[
                    styles.columnChip,
                    {
                      minHeight: theme.minTouchSize,
                      paddingHorizontal: theme.spacing.md,
                      borderRadius: theme.radii.md,
                      borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                      backgroundColor: isSelected ? theme.colors.surfaceRaised : 'transparent',
                    },
                  ]}
                >
                  <Text variant="body" color={isSelected ? 'primary' : 'secondary'}>
                    {choiceName}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        </ScrollView>

        {errorMessage ? (
          <Text variant="caption" color="danger">
            {errorMessage}
          </Text>
        ) : null}

        <Button
          label={createInFlight ? 'Creating...' : 'Create task'}
          onPress={confirm}
          disabled={title.trim().length === 0 || createInFlight}
          testID="create-task-confirm"
        />
      </Stack>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  columnChips: {
    flexDirection: 'row',
  },
  columnChip: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
