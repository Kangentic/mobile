import React from 'react';
import { StyleSheet } from 'react-native';
import { Screen, Stack, Text } from '@/components';

/** Placeholder - the per-file unified diff renderer lands with the changes surface work. */
export function FileDiffScreen(): React.JSX.Element {
  return (
    <Screen testID="file-diff-screen">
      <Stack gap="sm" style={styles.placeholder}>
        <Text variant="body" color="secondary">
          Diff loading...
        </Text>
      </Stack>
    </Screen>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
