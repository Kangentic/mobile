import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { Text, type TextColorRole } from './Text';

export interface BadgeProps {
  label: string;
  color?: TextColorRole;
  /** Pills read against the card surface via the overlay background plus a hairline border (on by default; pass false for a flat pill on non-card surfaces). */
  outlined?: boolean;
  testID?: string;
}

export function Badge({ label, color = 'secondary', outlined = true, testID }: BadgeProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.base,
        {
          backgroundColor: theme.colors.surfaceOverlay,
          borderRadius: theme.radii.sm,
          paddingHorizontal: theme.spacing.sm,
          paddingVertical: theme.spacing.xs / 2,
          borderWidth: outlined ? StyleSheet.hairlineWidth : 0,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Text variant="caption" color={color}>
        {label}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  base: {
    alignSelf: 'flex-start',
  },
});
