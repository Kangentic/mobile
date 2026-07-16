import React from 'react';
import { StyleSheet, type GestureResponderEvent } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { Icon, type IconProps } from './Icon';
import { PressScale } from './motion/PressScale';

export type IconButtonVariant = 'plain' | 'fab';

export interface IconButtonProps {
  iconName: IconProps['name'];
  onPress: (event: GestureResponderEvent) => void;
  testID: string;
  accessibilityLabel: string;
  variant?: IconButtonVariant;
  disabled?: boolean;
}

const FAB_ICON_SIZE = 24;

/**
 * A 44pt-minimum icon-only button. `plain` is a transparent tap target for
 * toolbars and rows; `fab` is an accent circular raised action button meant to
 * be absolutely positioned by its parent.
 */
export function IconButton({
  iconName,
  onPress,
  testID,
  accessibilityLabel,
  variant = 'plain',
  disabled = false,
}: IconButtonProps): React.JSX.Element {
  const theme = useTheme();
  const isFab = variant === 'fab';
  const fabDiameter = theme.minTouchSize + theme.spacing.md;

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
        isFab && [
          styles.fabShadow,
          {
            width: fabDiameter,
            height: fabDiameter,
            borderRadius: fabDiameter / 2,
            backgroundColor: theme.colors.accent,
          },
        ],
      ]}
    >
      {isFab ? (
        // The fab glyph sits on the accent fill, so it uses onAccent (same
        // pattern as Button's primary label).
        <Icon name={iconName} size={FAB_ICON_SIZE} style={{ color: theme.colors.onAccent }} />
      ) : (
        <Icon name={iconName} color="primary" />
      )}
    </PressScale>
  );
}

const styles = StyleSheet.create({
  base: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  fabShadow: {
    elevation: 6,
    shadowOpacity: 0.3,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
  },
});
