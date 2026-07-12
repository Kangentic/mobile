import React from 'react';
import { View, type ViewProps } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import type { SpacingTokens } from './theme/tokens';

export interface RowProps extends ViewProps {
  gap?: keyof SpacingTokens;
  children: React.ReactNode;
}

export function Row({ gap = 'sm', style, children, ...rest }: RowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing[gap] }, style]} {...rest}>
      {children}
    </View>
  );
}
