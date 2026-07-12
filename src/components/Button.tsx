import React from 'react';
import { Pressable, StyleSheet, type GestureResponderEvent } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { Text } from './Text';

export type ButtonVariant = 'primary' | 'ghost' | 'danger';

export interface ButtonProps {
  label: string;
  onPress: (event: GestureResponderEvent) => void;
  testID: string;
  variant?: ButtonVariant;
  disabled?: boolean;
}

export function Button({ label, onPress, testID, variant = 'primary', disabled = false }: ButtonProps): React.JSX.Element {
  const theme = useTheme();
  const backgroundColor = backgroundForVariant(variant, theme.colors);
  const textColor = variant === 'ghost' ? theme.colors.textPrimary : theme.colors.background;

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: theme.minTouchSize,
          minWidth: theme.minTouchSize,
          paddingHorizontal: theme.spacing.lg,
          borderRadius: theme.radii.md,
          backgroundColor,
          opacity: disabled ? 0.5 : pressed ? 0.8 : 1,
        },
      ]}
    >
      <Text variant="bodyStrong" style={{ color: textColor }}>
        {label}
      </Text>
    </Pressable>
  );
}

function backgroundForVariant(variant: ButtonVariant, colors: ReturnType<typeof useTheme>['colors']): string {
  switch (variant) {
    case 'primary':
      return colors.accent;
    case 'ghost':
      return 'transparent';
    case 'danger':
      return colors.danger;
  }
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
