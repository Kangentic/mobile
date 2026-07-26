import React, { useCallback, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Button, Stack, Text, TextField, useTheme } from '@/components';
import { CapabilityError } from '@/channel';
import { createTask } from '@/connection/actions';
import { selectColumnsOrdered, useBoardStore } from '@/state/boardStore';
import { triggerHaptic } from '@/lib/haptics';

const BACKLOG_COLUMN_NAME = 'Backlog';

/**
 * New-task form, presented as a NATIVE form sheet (see app/_layout.tsx's
 * `presentation: 'formSheet'`), not a hand-rolled Modal.
 *
 * The custom Sheet this replaced put a bottom-anchored card inside a
 * transparent Android Dialog and did its own keyboard avoidance. That is a
 * layout race we do not want to own: on first open the dialog window had not
 * settled edge-to-edge yet, so the card rendered one tab-bar-height above the
 * screen bottom with the Agents/Board tabs showing underneath, and only
 * snapped flush once the keyboard forced a relayout. Reported from the device
 * as "it opens just above the navigation icons, then typing pins it".
 *
 * A form sheet has no such window to miss: the platform owns the presentation
 * (UISheetPresentationController on iOS, the Compose bottom sheet on Android),
 * the backdrop, and keyboard avoidance, identically on both. There is
 * deliberately no KeyboardAvoidingView, backdrop Pressable, or safe-area
 * padding here - adding any of them would be fighting the platform for a job
 * it already does.
 */
export function CreateTaskScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const { projectId } = useLocalSearchParams<{ projectId?: string }>();
  // Select the BOARD (a stable store reference), never the derived array:
  // selectColumnsOrdered builds a new array per call, so returning it straight
  // from the selector changes identity every render and drives
  // useSyncExternalStore into an infinite loop. Same rule as SessionScreen.
  const board = useBoardStore((state) => (projectId ? (state.boardsByProjectId[projectId] ?? null) : null));
  const columns = useMemo(() => (board ? selectColumnsOrdered(board) : []), [board]);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  // null = untouched, so the default column stays selected until an explicit
  // tap. The screen unmounts on dismiss, so there is nothing to reset.
  const [pickedColumnName, setPickedColumnName] = useState<string | null>(null);
  const [createInFlight, setCreateInFlight] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // Always the board's first column (To Do by convention), never whichever
  // column the pager happened to be showing: a new task is new work.
  const defaultColumnName = columns[0]?.name ?? null;
  const columnName = pickedColumnName ?? defaultColumnName ?? BACKLOG_COLUMN_NAME;
  const columnChoices = useMemo(() => [...columns.map((column) => column.name), BACKLOG_COLUMN_NAME], [columns]);

  const confirm = useCallback(() => {
    const trimmedTitle = title.trim();
    if (trimmedTitle.length === 0 || !projectId) return;
    setCreateInFlight(true);
    setErrorMessage(null);
    void createTask({ projectId, title: trimmedTitle, description: description.trim(), column: columnName })
      .then(() => {
        triggerHaptic('taskCreated');
        router.back();
      })
      .catch((error: unknown) => {
        setErrorMessage(error instanceof CapabilityError ? error.message : 'Create failed - check the connection');
      })
      .finally(() => setCreateInFlight(false));
  }, [projectId, title, description, columnName, router]);

  return (
    <View style={[styles.container, { backgroundColor: theme.colors.surfaceOverlay, padding: theme.spacing.lg }]}>
      <Stack gap="sm">
        <Text variant="title">New task</Text>
        <TextField value={title} onChangeText={setTitle} placeholder="Title" testID="create-task-title" autoFocus />
        {/*
          Plain TextField, not DictationTextField: a custom in-field mic button
          left a column of dead space beside a tall multiline box and duplicated
          the keyboard's own voice-typing button. A fixed height rather than
          flex: 1 - 'fitToContents' sizes the sheet from its content, and a
          flexing child gives it nothing to measure.
        */}
        <TextField
          value={description}
          onChangeText={setDescription}
          placeholder="Description (optional)"
          multiline
          testID="create-task-description"
          style={styles.descriptionField}
        />
        {/* keyboardShouldPersistTaps is not inherited from an outer scroll
            view, and defaults to "never": without it the first tap on a chip
            is spent dismissing the keyboard and the column never changes. */}
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled">
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
    </View>
  );
}

const styles = StyleSheet.create({
  columnChip: {
    alignItems: 'center',
    justifyContent: 'center',
    // A full 1px border, not hairlineWidth: a sub-pixel border on a rounded
    // corner anti-aliases into visible jagged pixelation at the selected
    // chip's full-saturation accent color.
    borderWidth: 1,
  },
  columnChips: {
    flexDirection: 'row',
  },
  container: {
    // Deliberately NOT flex: 1 - see the sheetAllowedDetents note above.
    width: '100%',
  },
  descriptionField: {
    height: 96,
  },
});
