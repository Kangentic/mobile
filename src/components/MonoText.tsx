import React from 'react';
import { Platform, Text as RNText, type TextProps as RNTextProps } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { colorForTextRole, type TextColorRole } from './Text';

export type MonoTextSize = 'body' | 'caption';

export interface MonoTextProps extends RNTextProps {
  size?: MonoTextSize;
  color?: TextColorRole;
  children: React.ReactNode;
}

/**
 * Text locked to the theme's monospace font, for terminal output, code, paths,
 * and identifiers. `size` is restricted to the body (14) and caption (12)
 * typography tokens, so the 12px caption floor is unrepresentable here - see
 * .claude/rules/ui-conventions.md.
 */
export function MonoText({ size = 'body', color = 'primary', style, children, ...rest }: MonoTextProps): React.JSX.Element {
  const theme = useTheme();
  const typographyToken = theme.typography[size];
  const colorValue = colorForTextRole(color, theme.colors);
  // iOS has no 'monospace' alias; Menlo is its system monospace. The theme
  // token stays pure data (tokens.ts cannot import react-native), so the
  // platform pick lives here at the render edge.
  const monoFontFamily = Platform.select({ ios: 'Menlo', default: theme.fontFamilyMono });

  return (
    <RNText
      style={[
        {
          fontFamily: monoFontFamily,
          fontSize: typographyToken.fontSize,
          lineHeight: typographyToken.lineHeight,
          fontWeight: typographyToken.fontWeight,
          color: colorValue,
        },
        style,
      ]}
      {...rest}
    >
      {children}
    </RNText>
  );
}
