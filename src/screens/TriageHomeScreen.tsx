import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { Screen, Card, Row, Stack, Text, Badge, StatusDot, SectionHeader, useTheme } from '@/components';
import { selectSessionsBySection, type ActivitySection, type AgentSession } from '@/state/activityStore';

type TriageListRow =
  | { kind: 'section-header'; section: ActivitySection; title: string }
  | { kind: 'activity'; session: AgentSession };

const SECTION_TITLES: Record<ActivitySection, string> = {
  'needs-you': 'Needs you',
  working: 'Working',
  idle: 'Idle',
};

function buildRows(): TriageListRow[] {
  const sections: ActivitySection[] = ['needs-you', 'working', 'idle'];
  return sections.flatMap((section) => {
    const sessions = selectSessionsBySection(section);
    const header: TriageListRow = { kind: 'section-header', section, title: SECTION_TITLES[section] };
    const rows: TriageListRow[] = sessions.map((session) => ({ kind: 'activity', session }));
    return [header, ...rows];
  });
}

export function TriageHomeScreen(): React.JSX.Element {
  const theme = useTheme();
  const rows = useMemo(() => buildRows(), []);

  return (
    <Screen>
      <FlashList<TriageListRow>
        testID="triage-home-list"
        data={rows}
        keyExtractor={(row) => (row.kind === 'section-header' ? `section-${row.section}` : row.session.id)}
        getItemType={(row) => row.kind}
        renderItem={({ item }) =>
          item.kind === 'section-header' ? (
            <SectionHeader title={item.title} testID={`section-header-${item.section}`} />
          ) : (
            <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
              <ActivityRow session={item.session} />
            </View>
          )
        }
      />
    </Screen>
  );
}

const ActivityRow = React.memo(function ActivityRow({ session }: { session: AgentSession }): React.JSX.Element {
  return (
    <Card testID={`activity-row-${session.id}`}>
      <Stack gap="xs">
        <Row gap="sm" style={styles.spaceBetween}>
          <StatusDot variant={session.section} testID={`activity-row-${session.id}-status`} />
          <Text variant="bodyStrong" style={styles.flex}>
            {session.title}
          </Text>
          {session.unreadCount > 0 ? <Badge label={String(session.unreadCount)} color="accent" /> : null}
        </Row>
        <Text variant="caption" color="secondary">
          {session.repository}
        </Text>
        {session.pendingPromptSummary ? (
          <Text variant="caption" color="warning">
            {session.pendingPromptSummary}
          </Text>
        ) : (
          <Text variant="caption" color="muted">
            {session.statusLabel}
          </Text>
        )}
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
});
