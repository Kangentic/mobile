import React from 'react';
import { useRouter } from 'expo-router';
import { Screen, Stack, Text, Button, useTheme } from '@/components';

export function SettingsScreen(): React.JSX.Element {
  const router = useRouter();
  const theme = useTheme();
  return (
    <Screen testID="settings-screen">
      <Stack gap="md" style={{ padding: theme.spacing.lg }}>
        <Text variant="heading">Settings</Text>
        <Text variant="body" color="secondary">
          Relay configuration lands in a later phase.
        </Text>
        <Button testID="settings-pair-device" label="Pair a device" onPress={() => router.push('/pair')} />
      </Stack>
    </Screen>
  );
}
