import React, { useCallback, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { BoardTaskWire } from '@kangentic/protocol';
import { Button, Stack, Text, TextField, useTheme } from '@/components';
import { CapabilityError } from '@/channel';
import { updateTaskFields } from '@/connection/actions';
import { findTaskById, useBoardStore } from '@/state/boardStore';

const TASK_TITLE_MAX_LENGTH = 200;

/**
 * Edit a task's title/description, as a native form sheet route.
 *
 * Save stays disabled until something actually changed and sends only the
 * changed fields, so an untouched open cannot overwrite a field the desktop
 * changed underneath.
 */
export function EditTaskScreen(): React.JSX.Element {
  const { taskId } = useLocalSearchParams<{ taskId?: string; projectId?: string }>();
  const task = useBoardStore((state) => (taskId ? (findTaskById(state, taskId)?.task ?? null) : null));
  // Keyed on the task id so opening a different task always starts from that
  // task's current values rather than the previous one's edits.
  return task ? <EditTaskForm key={task.id} task={task} /> : <View />;
}

function EditTaskForm({ task }: { task: BoardTaskWire }): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const trimmedTitle = title.trim().slice(0, TASK_TITLE_MAX_LENGTH);
  const titleChanged = trimmedTitle !== task.title;
  const descriptionChanged = description !== task.description;
  const saveDisabled = saveInFlight || trimmedTitle.length === 0 || (!titleChanged && !descriptionChanged);

  const confirm = useCallback(() => {
    if (!projectId) return;
    setSaveInFlight(true);
    setErrorMessage(null);
    void updateTaskFields({
      projectId,
      taskId: task.id,
      ...(titleChanged ? { title: trimmedTitle } : {}),
      ...(descriptionChanged ? { description } : {}),
    })
      .then(() => router.back())
      .catch((error: unknown) => {
        setErrorMessage(
          error instanceof CapabilityError || error instanceof Error
            ? error.message
            : 'Edit failed - check the connection',
        );
      })
      .finally(() => setSaveInFlight(false));
  }, [projectId, task.id, titleChanged, descriptionChanged, trimmedTitle, description, router]);

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
      testID="edit-task-sheet"
    >
      <Stack gap="sm">
        <Text variant="title">Edit task</Text>
        <TextField value={title} onChangeText={setTitle} placeholder="Title" testID="edit-task-title" />
        {/* Plain TextField, not DictationTextField - see CreateTaskScreen for why.
            A fixed height rather than flex: 1, which 'fitToContents' cannot measure. */}
        <TextField
          value={description}
          onChangeText={setDescription}
          placeholder="Description"
          multiline
          testID="edit-task-description"
          style={styles.descriptionField}
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
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Deliberately not flex: 1 - 'fitToContents' needs measurable content.
    width: '100%',
  },
  descriptionField: {
    /**
     * Sized by its CONTENT, not pinned: a multiline TextInput with no fixed
     * height grows to fit, and 'fitToContents' grows the sheet with it. So a
     * long description opens a tall sheet and a short one does not reserve
     * dead space - which a fixed height gets wrong in both directions at once.
     *
     * The cap is what keeps the sheet clear of the keyboard. Past it the box
     * scrolls internally, which is the honest trade for a description longer
     * than a phone screen. See CreateTaskScreen for why this is not a flex.
     */
    maxHeight: 420,
    minHeight: 160,
  },
});
