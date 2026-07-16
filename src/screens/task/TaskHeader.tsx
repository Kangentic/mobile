import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { ConnectionBanner, Icon, IconButton, Row, StatusDot, Text, useTheme } from '@/components';
import { sectionForEntry, useActivityStore } from '@/state/activityStore';

export interface TaskHeaderProps {
  taskTitle: string;
  sessionId: string | null;
  /** When set, the header shows the Changes chip (the Session screen's second destination). */
  onOpenChanges?: () => void;
}

export function TaskHeader({ taskTitle, sessionId, onOpenChanges }: TaskHeaderProps): React.JSX.Element {
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
        {onOpenChanges ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="View changes"
            testID="task-header-changes"
            onPress={onOpenChanges}
            style={[
              styles.changesChip,
              {
                minHeight: theme.minTouchSize,
                borderColor: theme.colors.border,
                borderRadius: theme.radii.md,
                paddingHorizontal: theme.spacing.md,
              },
            ]}
          >
            <Row gap="xs" style={styles.changesChipContent}>
              <Icon name="git-compare-outline" size={14} color="secondary" />
              <Text variant="caption" color="secondary">
                Changes
              </Text>
            </Row>
          </Pressable>
        ) : null}
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
  changesChip: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  changesChipContent: {
    alignItems: 'center',
  },
});
