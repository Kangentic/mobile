import React, { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useRouter } from 'expo-router';
import { AgentStatusIcon, Badge, Card, Icon, MonoText, Row, Stack, Text } from '@/components';
import { peekAwaitedPrompt } from '@/connection/actions';
import { buildPendingPromptSummary } from '@/conversation/pendingPromptSummary';
import type { AwaitedToolUse } from '@/conversation/pendingPromptSummary';
import type { SessionActivityEntry } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';

export interface NeedsYouCardProps {
  entry: SessionActivityEntry;
}

/**
 * The Agents feed's prompt-pending card: a session waiting on the user.
 * Styled EXACTLY like every other idle card (pulsing mail icon, standard
 * chrome) - a permission prompt is idle in desktop semantics. It TEASES
 * the decision (the exact command or question, via a one-shot transcript
 * peek) in the summary block, and the tap opens the Session view's chat
 * lens where the REAL prompt card - full context and controls - lives.
 * Answering deliberately does not happen from Home.
 */
export function NeedsYouCard({ entry }: NeedsYouCardProps): React.JSX.Element {
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
    // Same anatomy as every other idle card (a permission prompt IS idle
    // in desktop semantics: the user's move): pulsing mail icon, standard
    // card chrome, no rails or special borders. The prompt-summary block
    // is the only differentiator.
    <Card testID={`needs-you-card-${entry.sessionId}`} onPress={openTask}>
      <Stack gap="xs">
        <Row gap="sm" style={styles.spaceBetween}>
          <AgentStatusIcon kind="idle-unread" testID={`needs-you-card-${entry.sessionId}-status`} />
          <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
            {taskTitle ?? 'Untitled task'}
          </Text>
          {agentName ? <Badge label={agentName} color="secondary" /> : null}
          {entry.unreadCount > 0 ? <Badge label={String(entry.unreadCount)} color="accent" /> : null}
        </Row>
        {projectName ? (
          <Text variant="caption" color="secondary" numberOfLines={1}>
            {projectName}
          </Text>
        ) : null}
        {/* The snippet slot, same spacing as every idle row's message
            preview; here it is the pending decision instead. */}
        <Row gap="xs" style={styles.summaryRow} testID={`needs-you-card-${entry.sessionId}-summary`}>
          <Icon name={isQuestion ? 'help-circle' : 'shield-half'} color="accent" size={14} />
          <MonoText size="caption" style={styles.flex} numberOfLines={2}>
            {summary}
          </MonoText>
        </Row>
        <Row gap="xs" style={styles.reviewRow}>
          <Text variant="caption" color="accent">
            {isQuestion ? 'Answer in session' : 'Review and approve'}
          </Text>
          <Icon name="chevron-forward" color="accent" size={14} />
        </Row>
      </Stack>
    </Card>
  );
}

const styles = StyleSheet.create({
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
