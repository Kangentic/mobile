import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Row, Stack, Text, useTheme } from '@/components';

export interface SessionEndedStateProps {
  /** Switches the task screen to the Changes tab (diffs outlive the session). */
  onViewChanges: () => void;
  /** Opens the move-task sheet; null while no cached board holds the task (nothing to move within). */
  onMoveTask?: (() => void) | null;
}

/**
 * The honest end-of-life surface for a task whose desktop session died with
 * no successor (yet). Rendered as an overlay above the conversation/terminal
 * pager so a frozen last frame is never mistaken for a live one; the screen
 * auto-recovers the moment the board announces a successor session.
 */
export function SessionEndedState({ onViewChanges, onMoveTask = null }: SessionEndedStateProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID="session-ended-state"
      style={[styles.overlay, { backgroundColor: theme.colors.background }]}
    >
      <Stack gap="sm" style={styles.content}>
        <Text variant="title">Session ended</Text>
        <Text variant="body" color="secondary" style={styles.caption}>
          The desktop is no longer running a session for this task. If it starts a new one, this
          screen reconnects automatically.
        </Text>
        {/* View changes stays first: reviewing the diff is the more common
            next act; moving the card on is the follow-through. */}
        <Row gap="sm" style={{ marginTop: theme.spacing.md }}>
          <Button
            label="View changes"
            variant="ghost"
            onPress={onViewChanges}
            testID="session-ended-view-changes"
          />
          {onMoveTask ? (
            <Button
              label="Move task"
              variant="ghost"
              onPress={onMoveTask}
              testID="session-ended-move-task"
            />
          ) : null}
        </Row>
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    /**
     * Strictly above SessionScreen's panes, which carry `zIndex: 1` when
     * visible. Without this the overlay lost the stacking contest and the
     * chat pane sat ON TOP of it: "Session ended" bled through the gaps
     * between transcript cards while `View changes` and `Move task` were
     * dead, because React Native hands a tap to the topmost view rather
     * than falling through to an occluded sibling.
     *
     * That regression shipped green through every required check - a Jest
     * `fireEvent.press` calls the handler directly and never consults hit
     * testing, so no JS tier can see a stacking-order bug. The paired
     * Maestro flow `session-ended-state.yaml` is what caught it, and
     * `SessionScreen.session-swap.test.tsx` now pins the ordering itself as
     * the closest mechanical guard available.
     *
     * The panes only acquired a zIndex when the pager became absolutely
     * positioned siblings, so this file was correct until that change and
     * the coupling is easy to miss: raising a pane's zIndex without raising
     * this one reintroduces the bug.
     */
    zIndex: 2,
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  caption: {
    textAlign: 'center',
  },
});
