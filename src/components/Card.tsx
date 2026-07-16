import React from 'react';
import { StyleSheet, View, type GestureResponderEvent, type ViewProps } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import type { Theme } from './theme/tokens';
import { PressScale } from './motion/PressScale';

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
    // Pressed depth comes from PressScale's scale transform (the design
    // system's one pressed-state signal), not an opacity dim.
    return (
      <PressScale
        accessibilityRole="button"
        onPress={onPress}
        onLongPress={onLongPress}
        style={[styles.base, surfaceStyle, style]}
        {...rest}
      >
        {children}
      </PressScale>
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
