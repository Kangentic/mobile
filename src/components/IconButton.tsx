import React from 'react';
import { StyleSheet, View, type GestureResponderEvent } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import type { Theme } from './theme/tokens';
import { Icon, type IconProps } from './Icon';
import { PressScale } from './motion/PressScale';

export type IconButtonVariant = 'plain' | 'raised' | 'fab';

export interface IconButtonProps {
  iconName: IconProps['name'];
  onPress: (event: GestureResponderEvent) => void;
  testID: string;
  accessibilityLabel: string;
  variant?: IconButtonVariant;
  disabled?: boolean;
  /** The glyph's colour role on a plain or raised button (the fab always uses onAccent). */
  iconColor?: IconProps['color'];
  /**
   * A small status mark drawn over the button's top-right edge (the section
   * filter's "sections hidden" dot). The caller owns its look and testID; the
   * button only positions it.
   */
  badge?: React.ReactNode;
}

const FAB_ICON_SIZE = 24;
const BADGE_INSET = 4;

/** The `fab` variant's diameter, for screens that must keep content clear of it. */
export function fabDiameter(theme: Theme): number {
  return theme.minTouchSize + theme.spacing.md;
}

/**
 * A 44pt-minimum icon-only button. `raised` is the default, per
 * ui-conventions.md (visible tap targets): a circular raised surface with a
 * hairline outline. `plain` is a transparent target for dense toolbars where
 * the container already frames the control; `fab` is the accent circular
 * action button meant to be absolutely positioned.
 */
export function IconButton({
  iconName,
  onPress,
  testID,
  accessibilityLabel,
  variant = 'raised',
  disabled = false,
  iconColor = 'primary',
  badge,
}: IconButtonProps): React.JSX.Element {
  const theme = useTheme();
  const isFab = variant === 'fab';
  const isRaised = variant === 'raised';
  const diameter = fabDiameter(theme);

  // Pressed depth comes from PressScale's scale transform; opacity only
  // signals the disabled state.
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={[
        styles.base,
        {
          minHeight: theme.minTouchSize,
          minWidth: theme.minTouchSize,
          opacity: disabled ? 0.5 : 1,
        },
        isRaised && {
          backgroundColor: theme.colors.surfaceRaised,
          borderColor: theme.colors.border,
          borderRadius: theme.minTouchSize / 2,
          borderWidth: StyleSheet.hairlineWidth,
        },
        isFab && [
          styles.fabShadow,
          {
            width: diameter,
            height: diameter,
            borderRadius: diameter / 2,
            backgroundColor: theme.colors.accent,
          },
        ],
      ]}
    >
      {isFab ? (
        // The fab glyph sits on the accent fill, so it uses onAccent (same
        // pattern as Button's primary label).
        <Icon name={iconName} size={FAB_ICON_SIZE} colorOverride={theme.colors.onAccent} />
      ) : (
        <Icon name={iconName} color={iconColor} />
      )}
      {badge !== undefined ? <View pointerEvents="none" style={styles.badge}>{badge}</View> : null}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: BADGE_INSET,
    right: BADGE_INSET,
  },
  fabShadow: {
    elevation: 6,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
});
