import React from 'react';
import { Pressable, StyleSheet, View, type GestureResponderEvent, type ViewProps } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import type { Theme } from './theme/tokens';

interface CardBaseProps extends ViewProps {
  children: React.ReactNode;
}

interface DisplayCardProps extends CardBaseProps {
  onPress?: never;
  onLongPress?: never;
  testID?: string;
}

interface PressableCardProps extends CardBaseProps {
  onPress?: (event: GestureResponderEvent) => void;
  onLongPress?: (event: GestureResponderEvent) => void;
  testID: string;
}

/**
 * A display-only Card keeps `testID` optional; providing `onPress` or
 * `onLongPress` switches the union to the pressable shape, where `testID` is
 * required (every interactive element needs a stable Maestro selector - see
 * .claude/rules/ui-conventions.md).
 */
export type CardProps = DisplayCardProps | PressableCardProps;

export function Card({ children, style, onPress, onLongPress, ...rest }: CardProps): React.JSX.Element {
  const theme = useTheme();
  const surfaceStyle = surfaceStyleForTheme(theme);

  if (onPress !== undefined || onLongPress !== undefined) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={onPress}
        onLongPress={onLongPress}
        style={({ pressed }) => [styles.base, surfaceStyle, { opacity: pressed ? 0.7 : 1 }, style]}
        {...rest}
      >
        {children}
      </Pressable>
    );
  }

  return (
    <View style={[styles.base, surfaceStyle, style]} {...rest}>
      {children}
    </View>
  );
}

function surfaceStyleForTheme(theme: Theme): { backgroundColor: string; borderColor: string; borderRadius: number; padding: number } {
  return {
    backgroundColor: theme.colors.surface,
    borderColor: theme.colors.border,
    borderRadius: theme.radii.md,
    padding: theme.spacing.md,
  };
}

const styles = StyleSheet.create({
  base: {
    borderWidth: StyleSheet.hairlineWidth,
  },
});
