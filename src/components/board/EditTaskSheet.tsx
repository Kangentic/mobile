import React, { useCallback, useState } from 'react';
import { useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { BoardTaskWire } from '@kangentic/protocol';
import { Button, Sheet, Stack, Text, TextField, computeSheetDescriptionBounds, useTheme } from '@/components';

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
  const { descriptionMinHeight, descriptionMaxHeight } = computeSheetDescriptionBounds({
    theme,
    windowHeight,
    bottomInset: insets.bottom,
    hasColumnChipsRow: false,
  });
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
