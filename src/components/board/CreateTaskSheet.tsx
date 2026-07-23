import React, { useCallback, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardColumnWire } from '@kangentic/protocol';
import { Button, SHEET_MAX_HEIGHT_FRACTION, Sheet, Stack, Text, TextField, useTheme } from '@/components';

export interface CreateTaskSheetProps {
  visible: boolean;
  columns: BoardColumnWire[];
  /**
   * The default target column - always the board's first column (To Do, by
   * convention), regardless of which column the pager happens to be showing
   * when the sheet opens. A new task is almost always new work, not
   * whatever the user was just scrolled to.
   */
  defaultColumnName: string | null;
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
  defaultColumnName,
  onClose,
  onCreate,
  createInFlight,
  errorMessage,
}: CreateTaskSheetProps): React.JSX.Element {
  const theme = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The description should use as much of the sheet's own 75% budget as the
  // OTHER fixed rows (the sheet's own title, the title field, the column
  // chips, the Create button, and the sheet's paddings) leave behind, not a
  // small fixed cap - a fixed cap left a large dead gap above a short sheet
  // instead of giving a long description more visible room to read. A small
  // safety buffer absorbs the rest: this is an estimate of Sheet's actual
  // layout, not a measurement of it, and undershooting cuts off the Create
  // button, which is worse than a slightly-shorter description.
  const CHROME_ESTIMATE_SAFETY_BUFFER = theme.spacing.md;
  const reservedChromeHeight =
    theme.spacing.lg + // Sheet's own paddingTop
    theme.typography.title.lineHeight +
    theme.spacing.md + // Sheet's own title + its marginBottom
    theme.minTouchSize +
    theme.spacing.sm + // title field + gap
    theme.spacing.sm + // gap from description to the column chips
    theme.minTouchSize +
    theme.spacing.sm + // column chips row + gap
    theme.minTouchSize + // Create button
    theme.spacing.lg + // Sheet's own paddingBottom
    insets.bottom + // Sheet's paddingBottom also adds the real safe-area inset
    CHROME_ESTIMATE_SAFETY_BUFFER;
  const descriptionMinHeight = theme.typography.body.lineHeight * 3 + theme.spacing.sm * 2;
  const descriptionMaxHeight = Math.max(
    windowHeight * SHEET_MAX_HEIGHT_FRACTION - reservedChromeHeight,
    descriptionMinHeight,
  );
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // null = the user has not picked yet: the selection stays on the default
  // column until an explicit tap, and close() clears the explicit pick, so
  // no effect is needed to re-sync on open.
  const [pickedColumnName, setPickedColumnName] = useState<string | null>(null);
  const columnName = pickedColumnName ?? defaultColumnName ?? columns[0]?.name ?? BACKLOG_COLUMN_NAME;

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
        {/*
          Plain TextField, not DictationTextField: a custom in-field mic
          button left a column of dead space beside a tall multiline box and
          duplicated the keyboard's own built-in voice-typing button. Height
          is bounded on both ends - tall enough by default to read as a real
          description field, capped so a long paste/dictation scrolls
          internally instead of pushing the column picker and Create button
          off-screen.
        */}
        <TextField
          value={description}
          onChangeText={setDescription}
          placeholder="Description (optional)"
          multiline
          testID="create-task-description"
          style={{ minHeight: descriptionMinHeight, maxHeight: descriptionMaxHeight }}
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
