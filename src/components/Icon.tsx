import React from 'react';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from './theme/ThemeProvider';
import { colorForTextRole, type TextColorRole } from './Text';

export interface IconProps {
  name: React.ComponentProps<typeof Ionicons>['name'];
  color?: TextColorRole;
  size?: number;
  testID?: string;
}

export function Icon({ name, color = 'primary', size = 20, testID }: IconProps): React.JSX.Element {
  const theme = useTheme();
  const colorValue = colorForTextRole(color, theme.colors);
  return <Ionicons name={name} size={size} color={colorValue} testID={testID} />;
}
