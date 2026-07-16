import React from 'react';
import { StyleSheet } from 'react-native';
import { Stack, Text, useTheme } from '@/components';

/**
 * Paired, connected, and nothing running: the calm state. (The Overseer
 * mascot lands here in the brand pass - keep this the single all-quiet
 * surface so it has one home.)
 */
export function AllQuietEmptyState(): React.JSX.Element {
  const theme = useTheme();
  return (
    <Stack gap="sm" style={[styles.container, { padding: theme.spacing.xl }]} testID="all-quiet-empty-state">
      <Text variant="title">All quiet</Text>
      <Text variant="body" color="secondary" style={styles.centeredText}>
        Nothing needs you right now. Start an agent on your desktop and it shows up here.
      </Text>
    </Stack>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centeredText: {
    textAlign: 'center',
  },
});
