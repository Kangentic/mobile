import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Text, useTheme } from '@/components';

export interface ModeToggleHintProps {
  onDismiss: () => void;
}

/**
 * The one-time first-run tooltip anchored above the mode pill. Dismissed by
 * tapping it (or by the first mode toggle); persisted via
 * settings.hasSeenSessionModeHint so it never returns.
 */
export function ModeToggleHint({ onDismiss }: ModeToggleHintProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Dismiss the mode hint"
      testID="session-mode-hint"
      onPress={onDismiss}
      style={[
        styles.card,
        {
          backgroundColor: theme.colors.surfaceRaised,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          padding: theme.spacing.md,
          marginHorizontal: theme.spacing.sm,
          marginBottom: theme.spacing.xs,
        },
      ]}
    >
      <Text variant="bodyStrong">One session, two views</Text>
      <Text variant="caption" color="secondary">
        Terminal is the raw desktop mirror; Chat is the readable feed. The input below follows the
        view. Tap to dismiss.
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: {
    borderWidth: StyleSheet.hairlineWidth,
  },
});
