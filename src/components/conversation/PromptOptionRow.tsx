import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Text, useTheme } from '@/components';

export interface PromptOptionRowProps {
  label: string;
  description?: string;
  disabled: boolean;
  onPress: () => void;
  /** Muted treatment for escape hatches that are not one of the dialog's own options. */
  muted?: boolean;
  testID: string;
}

/**
 * One selectable prompt option: an outlined row, identical for every
 * option. Deliberately NO primary emphasis - the agent's dialog options
 * are the user's decision, so none of them gets visually blessed as the
 * default. Shared by the permission and AskUserQuestion cards so the two
 * prompt kinds read the same.
 */
export function PromptOptionRow({ label, description, disabled, onPress, muted = false, testID }: PromptOptionRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      testID={testID}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        {
          minHeight: theme.minTouchSize,
          backgroundColor: theme.colors.surfaceRaised,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.sm,
          padding: theme.spacing.sm,
          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
        },
      ]}
    >
      <Text variant={muted ? 'body' : 'bodyStrong'} color={muted ? 'secondary' : 'primary'}>
        {label}
      </Text>
      {description !== undefined ? (
        <Text variant="caption" color={muted ? 'muted' : 'secondary'}>
          {description}
        </Text>
      ) : null}
    </Pressable>
  );
}

const styles = StyleSheet.create({
  row: {
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
});
