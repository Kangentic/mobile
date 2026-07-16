import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Stack, Text, useTheme } from '@/components';

export interface SessionEndedStateProps {
  /** Switches the task screen to the Changes tab (diffs outlive the session). */
  onViewChanges: () => void;
}

/**
 * The honest end-of-life surface for a task whose desktop session died with
 * no successor (yet). Rendered as an overlay above the conversation/terminal
 * pager so a frozen last frame is never mistaken for a live one; the screen
 * auto-recovers the moment the board announces a successor session.
 */
export function SessionEndedState({ onViewChanges }: SessionEndedStateProps): React.JSX.Element {
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
        <View style={{ marginTop: theme.spacing.md }}>
          <Button
            label="View changes"
            variant="ghost"
            onPress={onViewChanges}
            testID="session-ended-view-changes"
          />
        </View>
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
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  caption: {
    textAlign: 'center',
  },
});
