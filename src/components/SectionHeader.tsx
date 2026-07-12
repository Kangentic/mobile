import React from 'react';
import { View } from 'react-native';
import { useTheme } from './theme/ThemeProvider';
import { Text } from './Text';

export interface SectionHeaderProps {
  title: string;
  testID?: string;
}

export function SectionHeader({ title, testID }: SectionHeaderProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <View
      testID={testID}
      style={{
        paddingHorizontal: theme.spacing.md,
        paddingTop: theme.spacing.lg,
        paddingBottom: theme.spacing.sm,
      }}
    >
      <Text variant="title" color="secondary">
        {title}
      </Text>
    </View>
  );
}
