import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { Text, type TextColorRole } from './Text';

export interface BadgeProps {
  label: string;
  color?: TextColorRole;
  testID?: string;
}

export function Badge({ label, color = 'secondary', testID }: BadgeProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={[
        styles.base,
        {
          backgroundColor: theme.colors.surfaceRaised,
          borderRadius: theme.radii.sm,
          paddingHorizontal: theme.spacing.sm,
          paddingVertical: theme.spacing.xs / 2,
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
