import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from './theme/ThemeProvider';

export type StatusDotVariant = 'needs-you' | 'working' | 'idle';

export interface StatusDotProps {
  variant: StatusDotVariant;
  testID?: string;
}

export function StatusDot({ variant, testID }: StatusDotProps): React.JSX.Element {
  const theme = useTheme();
  const color = colorForVariant(variant, theme.colors);
  return <View testID={testID} style={[styles.dot, { backgroundColor: color }]} />;
}

function colorForVariant(variant: StatusDotVariant, colors: ReturnType<typeof useTheme>['colors']): string {
  switch (variant) {
    case 'needs-you':
      return colors.statusNeedsYou;
    case 'working':
      return colors.statusWorking;
    case 'idle':
      return colors.statusIdle;
  }
}

const styles = StyleSheet.create({
  dot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
});
