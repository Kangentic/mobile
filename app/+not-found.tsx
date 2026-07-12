import React from 'react';
import { Link } from 'expo-router';
import { Screen, Stack, Text, useTheme } from '@/components';

export default function NotFoundScreen(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Screen testID="not-found-screen">
      <Stack gap="md" style={{ padding: theme.spacing.lg }}>
        <Text variant="heading">This screen does not exist</Text>
        <Link href="/" testID="not-found-go-home" style={{ paddingVertical: theme.spacing.md }}>
          <Text variant="body" color="accent">
            Go back home
          </Text>
        </Link>
      </Stack>
    </Screen>
  );
}
