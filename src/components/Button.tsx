import React from 'react';
import { StyleSheet, type GestureResponderEvent, type StyleProp, type ViewStyle } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { Row } from './Row';
import { Text } from './Text';
import { PressScale } from './motion/PressScale';

/**
 * `tinted` is the desktop's in-place action button (the task view's Resume
 * session): an accent wash with an accent outline and accent ink, for an
 * action that belongs in the content area rather than a primary call to action.
 */
export type ButtonVariant = 'primary' | 'ghost' | 'danger' | 'tinted';

export interface ButtonProps {
  label: string;
  onPress: (event: GestureResponderEvent) => void;
  testID: string;
  variant?: ButtonVariant;
  disabled?: boolean;
  /** A glyph drawn before the label (e.g. a play icon or a spinner), in the label's colour by the caller's choice. */
  leading?: React.ReactNode;
  /** Caller layout overrides (width, extra padding, alignSelf), merged last over the base style. */
  style?: StyleProp<ViewStyle>;
}

export function Button({ label, onPress, testID, variant = 'primary', disabled = false, leading, style }: ButtonProps): React.JSX.Element {
  const theme = useTheme();
  const backgroundColor = backgroundForVariant(variant, theme.colors);
  const textColor = textColorForVariant(variant, theme.colors);

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
        variant === 'tinted' ? { borderWidth: 1, borderColor: theme.colors.accentMuted } : null,
        style,
      ]}
    >
      {leading !== undefined ? (
        <Row gap="sm" style={styles.content}>
          {leading}
          <Text variant="bodyStrong" style={{ color: textColor }}>
            {label}
          </Text>
        </Row>
      ) : (
        <Text variant="bodyStrong" style={{ color: textColor }}>
          {label}
        </Text>
      )}
    </PressScale>
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
    case 'tinted':
      return colors.accentSubtle;
  }
}

/**
 * Solid fills (primary/danger) carry onAccent ink, guaranteed readable on
 * accent and semantic fills; the transparent ghost uses textPrimary, and the
 * tinted wash takes the accent itself, as the desktop's accent-fg does.
 */
function textColorForVariant(variant: ButtonVariant, colors: ReturnType<typeof useTheme>['colors']): string {
  switch (variant) {
    case 'primary':
    case 'danger':
      return colors.onAccent;
    case 'ghost':
      return colors.textPrimary;
    case 'tinted':
      return colors.accent;
  }
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  content: {
    alignItems: 'center',
  },
});
