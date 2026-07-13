import React from 'react';
import { StyleSheet } from 'react-native';
import { Stack, Text } from '@/components';

export interface ChangesTabProps {
  taskId: string;
  projectId: string | null;
  /** True while this tab is the visible one - the diff watch is screen-scoped. */
  isActive: boolean;
}

/** Placeholder - the diff viewer lands with the changes surface work. */
export function ChangesTab(_props: ChangesTabProps): React.JSX.Element {
  return (
    <Stack gap="sm" style={styles.placeholder}>
      <Text variant="body" color="secondary">
        Changes loading...
      </Text>
    </Stack>
  );
}

const styles = StyleSheet.create({
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
