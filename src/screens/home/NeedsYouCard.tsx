import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Badge, Card, Icon, MonoText, Row, Stack, StatusDot, Text, useTheme } from '@/components';
import { peekAwaitedPrompt } from '@/connection/actions';
import { buildPendingPromptSummary } from '@/conversation/pendingPromptSummary';
import type { AwaitedToolUse } from '@/conversation/pendingPromptSummary';
import type { SessionActivityEntry } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';

export interface NeedsYouCardProps {
  entry: SessionActivityEntry;
}

/**
 * The Home feed's headline card: a session waiting on the user. It TEASES
 * the decision (the exact command or question, via a one-shot transcript
 * peek) inside an amber attention block, and the tap opens the Session
 * view's chat lens where the REAL prompt card - the full context and the
 * approve/deny controls - lives. Answering deliberately does not happen
 * from Home: the prompt experience stays one thing, in one place.
 */
export function NeedsYouCard({ entry }: NeedsYouCardProps): React.JSX.Element {
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

  // The peek result records WHICH promptId it belongs to, so a prompt swap
  // needs no synchronous state reset: the derived read below simply stops
  // matching until the new peek resolves.
  const awaitedPromptId = entry.awaitedPromptId;
  const [peekedPrompt, setPeekedPrompt] = useState<{ promptId: string; toolUse: AwaitedToolUse | null } | null>(null);
  const peekedToolUse =
    peekedPrompt !== null && peekedPrompt.promptId === awaitedPromptId ? peekedPrompt.toolUse : null;
  useEffect(() => {
    if (awaitedPromptId === null) return;
    let cancelled = false;
    void peekAwaitedPrompt(entry.sessionId, awaitedPromptId)
      .then((awaitedToolUse) => {
        if (!cancelled) setPeekedPrompt({ promptId: awaitedPromptId, toolUse: awaitedToolUse });
      })
      .catch(() => {
        // Not connected / a just-died session: the generic summary still teases.
      });
    return () => {
      cancelled = true;
    };
  }, [entry.sessionId, awaitedPromptId]);

  const openTask = (): void => {
    router.push({
      pathname: '/task/[taskId]',
      params: { taskId: entry.taskId, sessionId: entry.sessionId, projectId: entry.projectId, mode: 'chat' },
    });
  };

  const isQuestion = peekedToolUse?.name === 'AskUserQuestion';
  const summary = buildPendingPromptSummary(peekedToolUse);

  return (
    <Card testID={`needs-you-card-${entry.sessionId}`} onPress={openTask}>
      <Row gap="sm" style={styles.cardBody}>
        {/* The amber attention rail: the brand hue IS the needs-you signal. */}
        <View style={[styles.attentionRail, { backgroundColor: theme.colors.accent, borderRadius: theme.radii.sm }]} />
        <Stack gap="xs" style={styles.flex}>
          <Row gap="sm" style={styles.spaceBetween}>
            <StatusDot variant="needs-you" testID={`needs-you-card-${entry.sessionId}-status`} />
            <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
              {taskTitle ?? 'Untitled task'}
            </Text>
            {entry.unreadCount > 0 ? <Badge label={String(entry.unreadCount)} color="accent" /> : null}
          </Row>
          {projectName || agentName ? (
            <Text variant="caption" color="secondary" numberOfLines={1}>
              {[projectName, agentName].filter((part) => part !== null).join(' · ')}
            </Text>
          ) : null}
          <View
            testID={`needs-you-card-${entry.sessionId}-summary`}
            style={{
              backgroundColor: theme.colors.accentSubtle,
              borderRadius: theme.radii.md,
              paddingHorizontal: theme.spacing.md,
              paddingVertical: theme.spacing.sm,
            }}
          >
            <Row gap="sm" style={styles.summaryRow}>
              <Icon name={isQuestion ? 'help-circle' : 'shield-half'} color="accent" size={18} />
              <MonoText size="caption" style={styles.flex} numberOfLines={2}>
                {summary}
              </MonoText>
            </Row>
          </View>
          <Row gap="xs" style={styles.reviewRow}>
            <Text variant="caption" color="accent">
              {isQuestion ? 'Answer in session' : 'Review and approve'}
            </Text>
            <Icon name="chevron-forward" color="accent" size={14} />
          </Row>
        </Stack>
      </Row>
    </Card>
  );
}

const styles = StyleSheet.create({
  cardBody: {
    alignItems: 'stretch',
  },
  attentionRail: {
    width: 4,
    alignSelf: 'stretch',
  },
  spaceBetween: {
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  summaryRow: {
    alignItems: 'center',
  },
  reviewRow: {
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  flex: {
    flex: 1,
  },
});
