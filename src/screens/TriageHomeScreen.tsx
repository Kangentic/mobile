import React, { useCallback, useMemo, useState } from 'react';
import { RefreshControl, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { AppHeader, Screen, Card, ConnectionBanner, EmptyState, Icon, MonoText, Row, Stack, Text, Badge, Button, StatusDot, SectionHeader, useTheme } from '@/components';
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

// House vocabulary: sessions are Active or Idle (matching the desktop).
// Prompt-pending sessions render as attention cards pinned at the top of
// Active rather than under a separate header.
const SECTION_TITLES: Record<TriageSection, string> = {
  'needs-you': 'Active',
  working: 'Active',
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
    const listRows: TriageListRow[] = [];
    const emittedTitles = new Set<string>();
    for (const section of sections) {
      // Empty sections render nothing: the feed leads with what matters
      // instead of headers over blank space. Sections sharing a title
      // (needs-you + working = Active) share one header; needs-you entries
      // arrive first from the selector, so attention cards pin to the top.
      if (section.entries.length === 0) continue;
      const title = SECTION_TITLES[section.section];
      if (!emittedTitles.has(title)) {
        emittedTitles.add(title);
        listRows.push({ kind: 'section-header', section: section.section, title });
      }
      for (const entry of section.entries) listRows.push({ kind: 'activity', entry });
    }
    return listRows;
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
      <Screen edges={['left', 'right']}>
        <AppHeader title="Home" />
        <UnpairedEmptyState />
      </Screen>
    );
  }

  if (rows.length === 0 && established) {
    return (
      <Screen edges={['left', 'right']}>
        <AppHeader title="Home" />
        <ConnectionBanner />
        <AllQuietEmptyState />
      </Screen>
    );
  }

  return (
    <Screen edges={['left', 'right']}>
      <AppHeader title="Home" />
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
  const router = useRouter();
  return (
    <EmptyState
      testID="unpaired-empty-state"
      title="No desktop paired"
      caption="Pair this phone with your desktop Kangentic app to triage and steer your agents from anywhere."
      overseerSize={90}
      overseerAnimate="blink-loop"
    >
      <Button label="Pair with your desktop" onPress={() => router.push('/pair')} testID="triage-pair-cta" />
    </EmptyState>
  );
}

const ActivityRow = React.memo(function ActivityRow({ entry }: { entry: SessionActivityEntry }): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const taskTitle = useBoardStore((state) => {
    const board = state.boardsByProjectId[entry.projectId];
    return board?.tasksById[entry.taskId]?.title ?? null;
  });
  const agentName = useBoardStore((state) => {
    const board = state.boardsByProjectId[entry.projectId];
    return board?.tasksById[entry.taskId]?.agent ?? null;
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
  const working = section === 'working';
  return (
    <Card testID={`activity-row-${entry.sessionId}`} onPress={openTask}>
      <Stack gap="xs">
        <Row gap="sm" style={styles.spaceBetween}>
          <StatusDot variant={section} testID={`activity-row-${entry.sessionId}-status`} />
          <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
            {taskTitle ?? 'Untitled task'}
          </Text>
          {agentName ? <Badge label={agentName} color="secondary" /> : null}
          {entry.unreadCount > 0 ? <Badge label={String(entry.unreadCount)} color="accent" /> : null}
        </Row>
        {projectName ? (
          <Text variant="caption" color="secondary">
            {projectName}
          </Text>
        ) : null}
        <Row gap="xs" style={styles.statusRow}>
          {/* A live terminal glyph gives Working rows their pulse; idle rows stay quiet. */}
          {working ? (
            <MonoText size="caption" color="success">
              {'>_'}
            </MonoText>
          ) : null}
          <Text variant="caption" color={working ? 'secondary' : 'muted'} style={styles.flex} numberOfLines={1}>
            {statusLabelForEntry(entry)}
          </Text>
          <Icon name="chevron-forward" color="muted" size={14} style={{ marginRight: -theme.spacing.xs }} />
        </Row>
      </Stack>
    </Card>
  );
});

const styles = StyleSheet.create({
  spaceBetween: {
    justifyContent: 'space-between',
  },
  statusRow: {
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
});
