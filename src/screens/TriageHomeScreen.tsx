import React, { useCallback, useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { Screen, Card, ConnectionBanner, Row, Stack, Text, Badge, Button, StatusDot, SectionHeader, useTheme } from '@/components';
import {
  selectTriageRows,
  sectionForEntry,
  type SessionActivityEntry,
  type TriageSection,
  useActivityStore,
} from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { useChannelStore } from '@/state/channelStore';
import { refreshSnapshots } from '@/connection/actions';
import { AllQuietEmptyState } from './home/AllQuietEmptyState';
import { NeedsYouCard } from './home/NeedsYouCard';

type TriageListRow =
  | { kind: 'section-header'; section: TriageSection; title: string }
  | { kind: 'activity'; entry: SessionActivityEntry };

const SECTION_TITLES: Record<TriageSection, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
};

function statusLabelForEntry(entry: SessionActivityEntry): string {
  if (entry.state === 'permission') return 'Waiting for your approval';
  const reason = entry.reason;
  if (!reason) return entry.state === 'thinking' ? 'Working' : 'Idle';
  switch (reason.kind) {
    case 'tool':
      return reason.currentTool ? `Running ${reason.currentTool}` : 'Running tools';
    case 'subagent':
      return `Subagent working (depth ${reason.depth})`;
    case 'background-shell':
      return reason.count === 1 ? 'Background shell running' : `${reason.count} background shells running`;
    case 'turn-active':
      return 'Thinking';
    case 'permission':
      return 'Waiting for your approval';
    case 'idle':
      return 'Idle';
  }
}

export function TriageHomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const bySessionId = useActivityStore((state) => state.bySessionId);
  const pairedState = useChannelStore((state) => state.pairedState);
  const [refreshing, setRefreshing] = useState(false);

  const rows = useMemo<TriageListRow[]>(() => {
    const sections = selectTriageRows({ bySessionId });
    return sections.flatMap((section) => {
      // Empty sections render nothing: the feed leads with what matters
      // instead of three headers over blank space.
      if (section.entries.length === 0) return [];
      const header: TriageListRow = { kind: 'section-header', section: section.section, title: SECTION_TITLES[section.section] };
      const activityRows: TriageListRow[] = section.entries.map((entry) => ({ kind: 'activity', entry }));
      return [header, ...activityRows];
    });
  }, [bySessionId]);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refreshSnapshots()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, []);

  const established = useChannelStore((state) => state.established);

  if (pairedState === 'unpaired') {
    return (
      <Screen>
        <UnpairedEmptyState />
      </Screen>
    );
  }

  if (rows.length === 0 && established) {
    return (
      <Screen>
        <ConnectionBanner />
        <AllQuietEmptyState />
      </Screen>
    );
  }

  return (
    <Screen>
      <ConnectionBanner />
      <FlashList<TriageListRow>
        testID="triage-home-list"
        data={rows}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.textSecondary} />}
        keyExtractor={(row) => (row.kind === 'section-header' ? `section-${row.section}` : row.entry.sessionId)}
        getItemType={(row) => (row.kind === 'section-header' ? 'section-header' : sectionForEntry(row.entry) === 'needs-you' ? 'needs-you' : 'activity')}
        renderItem={({ item }) =>
          item.kind === 'section-header' ? (
            <SectionHeader title={item.title} testID={`section-header-${item.section}`} />
          ) : (
            <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
              {sectionForEntry(item.entry) === 'needs-you' ? (
                <NeedsYouCard entry={item.entry} />
              ) : (
                <ActivityRow entry={item.entry} />
              )}
            </View>
          )
        }
      />
    </Screen>
  );
}

function UnpairedEmptyState(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  return (
    <Stack gap="md" style={[styles.emptyState, { padding: theme.spacing.xl }]}>
      <Text variant="title">No desktop paired</Text>
      <Text variant="body" color="secondary" style={styles.centeredText}>
        Pair this phone with your desktop Kangentic app to triage and steer your agents from anywhere.
      </Text>
      <Button label="Pair with your desktop" onPress={() => router.push('/pair')} testID="triage-pair-cta" />
    </Stack>
  );
}

const ActivityRow = React.memo(function ActivityRow({ entry }: { entry: SessionActivityEntry }): React.JSX.Element {
  const router = useRouter();
  const taskTitle = useBoardStore((state) => {
    const board = state.boardsByProjectId[entry.projectId];
    return board?.tasksById[entry.taskId]?.title ?? null;
  });
  const projectName = useBoardStore(
    (state) => state.projects.find((project) => project.id === entry.projectId)?.name ?? null,
  );

  const openTask = useCallback(() => {
    router.push({
      pathname: '/task/[taskId]',
      params: { taskId: entry.taskId, sessionId: entry.sessionId, projectId: entry.projectId },
    });
  }, [router, entry.taskId, entry.sessionId, entry.projectId]);

  const section = sectionForEntry(entry);
  return (
    <Card testID={`activity-row-${entry.sessionId}`} onPress={openTask}>
      <Stack gap="xs">
        <Row gap="sm" style={styles.spaceBetween}>
          <StatusDot variant={section} testID={`activity-row-${entry.sessionId}-status`} />
          <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
            {taskTitle ?? 'Untitled task'}
          </Text>
          {entry.unreadCount > 0 ? <Badge label={String(entry.unreadCount)} color="accent" /> : null}
        </Row>
        {projectName ? (
          <Text variant="caption" color="secondary">
            {projectName}
          </Text>
        ) : null}
        {/* Needs-you is the attention state, and attention is the brand amber
            (accent), not the caution yellow - see the two-hue rule in tokens.ts. */}
        <Text variant="caption" color={section === 'needs-you' ? 'accent' : 'muted'}>
          {statusLabelForEntry(entry)}
        </Text>
      </Stack>
    </Card>
  );
});

const styles = StyleSheet.create({
  spaceBetween: {
    justifyContent: 'space-between',
  },
  flex: {
    flex: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centeredText: {
    textAlign: 'center',
  },
});
