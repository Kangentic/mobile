import React from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConnectionBanner, IconButton, Row, StatusDot, Text, useTheme } from '@/components';
import { sectionForEntry, useActivityStore } from '@/state/activityStore';

export interface TaskHeaderProps {
  taskTitle: string;
  sessionId: string | null;
}

export function TaskHeader({ taskTitle, sessionId }: TaskHeaderProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const activityEntry = useActivityStore((state) => (sessionId ? (state.bySessionId[sessionId] ?? null) : null));

  return (
    <>
      <Row
        gap="sm"
        style={[
          styles.header,
          {
            paddingTop: insets.top,
            paddingHorizontal: theme.spacing.xs,
            backgroundColor: theme.colors.surface,
            borderBottomColor: theme.colors.border,
          },
        ]}
      >
        <IconButton iconName="chevron-back" onPress={() => router.back()} testID="task-back-button" accessibilityLabel="Back" />
        {activityEntry ? <StatusDot variant={sectionForEntry(activityEntry)} testID="task-header-status" /> : null}
        <Text variant="title" numberOfLines={1} style={styles.title}>
          {taskTitle}
        </Text>
      </Row>
      <ConnectionBanner />
    </>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  title: {
    flex: 1,
  },
});
