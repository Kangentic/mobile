import React from 'react';
import { Screen, Stack, Text, useTheme } from '@/components';

export function DevicesScreen(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Screen testID="devices-screen">
      <Stack gap="md" style={{ padding: theme.spacing.lg }}>
        <Text variant="heading">Paired devices</Text>
        <Text variant="body" color="secondary">
          Device revocation and capability management land in a later phase.
        </Text>
      </Stack>
    </Screen>
  );
}
