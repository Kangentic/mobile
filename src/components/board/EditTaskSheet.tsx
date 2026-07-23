import React, { useCallback, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardTaskWire } from '@kangentic/protocol';
import { Button, SHEET_MAX_HEIGHT_FRACTION, Sheet, Stack, Text, TextField, useTheme } from '@/components';

export interface EditTaskSheetProps {
  visible: boolean;
  task: BoardTaskWire | null;
  onClose: () => void;
  /** Only the changed fields are present. */
  onSave: (fields: { title?: string; description?: string }) => void;
  saveInFlight: boolean;
  errorMessage: string | null;
}

const TASK_TITLE_MAX_LENGTH = 200;

/**
 * Edit a task's title/description from the phone. Save stays disabled until
 * something actually changed (dirty gating) and sends only the changed
 * fields; the description takes dictation. State keys off the task id so
 * opening a different task always starts from its current values.
 */
export function EditTaskSheet({ visible, task, onClose, onSave, saveInFlight, errorMessage }: EditTaskSheetProps): React.JSX.Element {
  return (
    <Sheet visible={visible} onClose={onClose} title="Edit task" testID="edit-task-sheet">
      {task ? (
        <EditTaskForm
          key={task.id}
          task={task}
          onSave={onSave}
          saveInFlight={saveInFlight}
          errorMessage={errorMessage}
        />
      ) : null}
    </Sheet>
  );
}

function EditTaskForm({
  task,
  onSave,
  saveInFlight,
  errorMessage,
}: {
  task: BoardTaskWire;
  onSave: (fields: { title?: string; description?: string }) => void;
  saveInFlight: boolean;
  errorMessage: string | null;
}): React.JSX.Element {
  const theme = useTheme();
  const { height: windowHeight } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  // The description fills whatever the sheet's 75% budget leaves after its
  // own fixed rows (no column chips here, unlike CreateTaskSheet) - see
  // CreateTaskSheet for why this isn't a small fixed cap, and for why the
  // safety buffer + insets.bottom term matter (undershooting cuts off Save).
  const CHROME_ESTIMATE_SAFETY_BUFFER = theme.spacing.md;
  const reservedChromeHeight =
    theme.spacing.lg + // Sheet's own paddingTop
    theme.typography.title.lineHeight +
    theme.spacing.md + // Sheet's own title + its marginBottom
    theme.minTouchSize +
    theme.spacing.sm + // title field + gap
    theme.spacing.sm + // gap from description to the Save button
    theme.minTouchSize + // Save button
    theme.spacing.lg + // Sheet's own paddingBottom
    insets.bottom +
    CHROME_ESTIMATE_SAFETY_BUFFER;
  const descriptionMinHeight = theme.typography.body.lineHeight * 3 + theme.spacing.sm * 2;
  const descriptionMaxHeight = Math.max(
    windowHeight * SHEET_MAX_HEIGHT_FRACTION - reservedChromeHeight,
    descriptionMinHeight,
  );
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);

  const trimmedTitle = title.trim().slice(0, TASK_TITLE_MAX_LENGTH);
  const titleChanged = trimmedTitle !== task.title;
  const descriptionChanged = description !== task.description;
  const saveDisabled = saveInFlight || trimmedTitle.length === 0 || (!titleChanged && !descriptionChanged);

  const confirm = useCallback(() => {
    onSave({
      ...(titleChanged ? { title: trimmedTitle } : {}),
      ...(descriptionChanged ? { description } : {}),
    });
  }, [onSave, titleChanged, descriptionChanged, trimmedTitle, description]);

  return (
    <Stack gap="sm">
      <TextField value={title} onChangeText={setTitle} placeholder="Title" testID="edit-task-title" />
      {/* Plain TextField, not DictationTextField - see CreateTaskSheet for why. */}
      <TextField
        value={description}
        onChangeText={setDescription}
        placeholder="Description"
        multiline
        testID="edit-task-description"
        style={{ minHeight: descriptionMinHeight, maxHeight: descriptionMaxHeight }}
      />
      {errorMessage ? (
        <Text variant="caption" color="danger">
          {errorMessage}
        </Text>
      ) : null}
      <Button
        label={saveInFlight ? 'Saving...' : 'Save changes'}
        onPress={confirm}
        disabled={saveDisabled}
        testID="edit-task-save"
      />
    </Stack>
  );
}
