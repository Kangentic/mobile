import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import type { StyleProp, TextStyle } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { colorForTextRole, type TextColorRole } from './Text';

export interface IconProps {
  name: React.ComponentProps<typeof Ionicons>['name'];
  color?: TextColorRole;
  size?: number;
  testID?: string;
  /** Style passthrough; a `color` here overrides the role color (same pattern as Text). */
  style?: StyleProp<TextStyle>;
}

export function Icon({ name, color = 'primary', size = 20, testID, style }: IconProps): React.JSX.Element {
  const theme = useTheme();
  const colorValue = colorForTextRole(color, theme.colors);
  return <Ionicons name={name} size={size} style={[{ color: colorValue }, style]} testID={testID} />;
}
