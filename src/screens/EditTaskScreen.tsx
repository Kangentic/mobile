import React, { useCallback, useState } from 'react';
import { StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import type { BoardTaskWire } from '@kangentic/protocol';
import { Button, Stack, Text, TextField, useTheme } from '@/components';
import { CapabilityError } from '@/channel';
import { updateTaskFields } from '@/connection/actions';
import { findTaskById, useBoardStore } from '@/state/boardStore';
import {
  alignHeightToTextLineGrid,
  clampSheetContentHeight,
  SHEET_KEYBOARD_ALLOWANCE,
} from '@/lib/sheetContentHeights';

const TASK_TITLE_MAX_LENGTH = 200;

/**
 * Everything this sheet needs around the description box, so the box's cap
 * (see sheetContentHeights.ts) can leave room for it: container padding
 * 16+24, title 24, title field 44, error line 24, button 44, four Stack gaps
 * 32, and 70 of top clearance (status bar plus sheet margin) the sheet can
 * never occupy. The keyboard allowance is always added: this sheet exists to
 * type into.
 */
const EDIT_SHEET_RESERVED_HEIGHT = 278;
/** Four body lines: the least description box that still invites editing. */
const DESCRIPTION_FLOOR_HEIGHT = 96;
/** The short-description resting height, when the window's cap leaves room. */
const DESCRIPTION_PREFERRED_MIN_HEIGHT = 160;

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
  const { height: windowHeight } = useWindowDimensions();
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  const [title, setTitle] = useState(task.title);
  const [description, setDescription] = useState(task.description);
  const [saveInFlight, setSaveInFlight] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  /**
   * The description box is sized by its CONTENT, not pinned: a multiline
   * TextInput with no fixed height grows to fit, and 'fitToContents' grows
   * the sheet with it. So a long description opens a tall sheet and a short
   * one does not reserve dead space - which a fixed height gets wrong in
   * both directions at once. Past the cap the box scrolls internally, the
   * honest trade for a description longer than a phone screen. See
   * CreateTaskScreen for why this is a cap and not a flex or a fractional
   * detent.
   *
   * The cap derives from the window height so the whole keyboard-up sheet
   * fits above the keyboard on small phones too (a fixed 420 hid the Save
   * button behind the keyboard in the 2026-08-15 iOS tester recording), and
   * it is aligned to the text line grid so an overflowing description clips
   * at a whole line instead of mid-line.
   */
  const descriptionMaxHeight = alignHeightToTextLineGrid({
    height: clampSheetContentHeight({
      windowHeight,
      reservedHeight: EDIT_SHEET_RESERVED_HEIGHT + insets.bottom + SHEET_KEYBOARD_ALLOWANCE,
      floorHeight: DESCRIPTION_FLOOR_HEIGHT,
    }),
    lineHeight: theme.typography.body.lineHeight,
    verticalPadding: 2 * theme.spacing.sm,
  });

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
        {/* Plain TextField, not DictationTextField - see CreateTaskScreen for why. */}
        <TextField
          value={description}
          onChangeText={setDescription}
          placeholder="Description"
          multiline
          testID="edit-task-description"
          style={{
            maxHeight: descriptionMaxHeight,
            // minHeight follows the cap: in layout, minHeight beats maxHeight,
            // so a fixed floor above a tiny window's cap would grow the box
            // right back past it.
            minHeight: Math.min(DESCRIPTION_PREFERRED_MIN_HEIGHT, descriptionMaxHeight),
          }}
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
});
