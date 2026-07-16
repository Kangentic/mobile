import React from 'react';
import { StyleSheet, TextInput, type TextInputProps } from 'react-native';
import { useTheme } from './theme/ThemeProvider';

export interface TextFieldProps extends TextInputProps {
  testID: string;
  /** Renders the input in the theme monospace font (paths, tokens, commands). */
  mono?: boolean;
}

/**
 * Themed TextInput primitive: surface background, hairline border, primary
 * text on textMuted placeholders, body-size (14) text. Forwards its ref so
 * composers can manage focus imperatively. The iOS keyboard defaults to the
 * dark appearance to match the dark-only theme (callers can still override).
 */
export const TextField = React.forwardRef<TextInput, TextFieldProps>(function TextField(
  { testID, mono = false, multiline = false, keyboardAppearance = 'dark', style, ...rest },
  ref,
): React.JSX.Element {
  const theme = useTheme();

  return (
    <TextInput
      ref={ref}
      testID={testID}
      multiline={multiline}
      keyboardAppearance={keyboardAppearance}
      placeholderTextColor={theme.colors.textMuted}
      style={[
        styles.base,
        {
          minHeight: theme.minTouchSize,
          backgroundColor: theme.colors.surface,
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          paddingHorizontal: theme.spacing.md,
          paddingVertical: theme.spacing.sm,
          color: theme.colors.textPrimary,
          fontSize: theme.typography.body.fontSize,
          lineHeight: theme.typography.body.lineHeight,
          fontFamily: mono ? theme.fontFamilyMono : undefined,
          textAlignVertical: multiline ? 'top' : 'center',
        },
        style,
      ]}
      {...rest}
    />
  );
});

const styles = StyleSheet.create({
  base: {
    borderWidth: StyleSheet.hairlineWidth,
  },
});
