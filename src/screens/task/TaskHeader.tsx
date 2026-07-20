import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { GitCompareArrows } from 'lucide-react-native';
import { ConnectionBanner, IconButton, MonoText, Row, StatusDot, Text, useTheme } from '@/components';
import { sectionForEntry, useActivityStore } from '@/state/activityStore';

export interface TaskHeaderProps {
  taskTitle: string;
  sessionId: string | null;
  /** The task's #N, shown top-right when the board's Ticket Numbers setting is on (pass null to hide). */
  displayId?: number | null;
  /** When set, the header shows the Changes chip (the Session screen's second destination). */
  onOpenChanges?: () => void;
}

export function TaskHeader({ taskTitle, sessionId, displayId = null, onOpenChanges }: TaskHeaderProps): React.JSX.Element {
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
        <Text variant="bodyStrong" numberOfLines={1} style={styles.title}>
          {taskTitle}
        </Text>
        {displayId !== null ? (
          <MonoText size="caption" color="muted" testID="task-header-display-id">
            #{displayId}
          </MonoText>
        ) : null}
        {onOpenChanges ? (
          // Icon-only with a full touch target: the title keeps its room and
          // the affordance still reads as a button (raised circle, pressed dim).
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="View changes"
            testID="task-header-changes"
            onPress={onOpenChanges}
            style={({ pressed }) => [
              styles.changesButton,
              {
                width: theme.minTouchSize,
                height: theme.minTouchSize,
                borderRadius: theme.minTouchSize / 2,
                backgroundColor: theme.colors.surfaceRaised,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <GitCompareArrows size={20} color={theme.colors.textSecondary} />
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
  changesButton: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
