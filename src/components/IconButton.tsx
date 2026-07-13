import React from 'react';
import { Pressable, StyleSheet, type GestureResponderEvent } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { Icon, type IconProps } from './Icon';

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

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.base,
        {
          minHeight: theme.minTouchSize,
          minWidth: theme.minTouchSize,
          opacity: disabled ? 0.5 : pressed ? 0.7 : 1,
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
        // The fab glyph sits on the accent fill, so it uses the theme
        // background color directly (same pattern as Button's primary label).
        <Icon name={iconName} size={FAB_ICON_SIZE} style={{ color: theme.colors.background }} />
      ) : (
        <Icon name={iconName} color="primary" />
      )}
    </Pressable>
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
