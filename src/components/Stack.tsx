import React from 'react';
import { View, type ViewProps } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import type { SpacingTokens } from './theme/tokens';

export interface StackProps extends ViewProps {
  gap?: keyof SpacingTokens;
  children: React.ReactNode;
}

export function Stack({ gap = 'sm', style, children, ...rest }: StackProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[{ flexDirection: 'column', gap: theme.spacing[gap] }, style]} {...rest}>
      {children}
    </View>
  );
}
