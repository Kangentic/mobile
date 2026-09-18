import React from 'react';
import { StyleSheet, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { Text } from './Text';
import { PressScale } from './motion/PressScale';

/**
 * `outline` is the secondary action beside a raised primary: transparent
 * like `ghost`, but with a visible bound (ui-conventions.md's visible
 * tap-target rule), so a two-action card reads as one call to action and
 * one alternative rather than two floating labels.
 */
export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'outline';

export interface ButtonProps {
  label: string;
  onPress: (event: GestureResponderEvent) => void;
  testID: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** Caller layout overrides (width, extra padding, alignSelf), merged last over the base style. */
  style?: StyleProp<ViewStyle>;
}

export function Button({ label, onPress, testID, variant = 'primary', disabled = false, style }: ButtonProps): React.JSX.Element {
  const theme = useTheme();
  const backgroundColor = backgroundForVariant(variant, theme.colors);
  // Tinted fills (primary/danger) carry onAccent ink, guaranteed readable on
  // accent and semantic fills; the two transparent variants use textPrimary.
  const transparentFill = variant === 'ghost' || variant === 'outline';
  const textColor = transparentFill ? theme.colors.textPrimary : theme.colors.onAccent;

  // Pressed depth comes from PressScale's scale transform; opacity only
  // signals the disabled state.
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.base,
        {
          minHeight: theme.minTouchSize,
          minWidth: theme.minTouchSize,
          paddingHorizontal: theme.spacing.lg,
          borderRadius: theme.radii.md,
          backgroundColor,
          opacity: disabled ? 0.5 : 1,
        },
        // A full dp rather than the hairline Card and the raised IconButton
        // use: this variant sits over a scrimmed frame of arbitrary colour,
        // where a hairline in the border tone disappears.
        variant === 'outline' && { borderWidth: 1, borderColor: theme.colors.border },
        style,
      ]}
    >
      <Text variant="bodyStrong" style={{ color: textColor }}>
        {label}
      </Text>
    </PressScale>
  );
}

function backgroundForVariant(variant: ButtonVariant, colors: ReturnType<typeof useTheme>['colors']): string {
  switch (variant) {
    case 'primary':
      return colors.accent;
    case 'ghost':
    case 'outline':
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
