import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Badge, Card, Row, Stack, StatusDot, Text, useTheme } from '@/components';
import { AskUserQuestionCard } from '@/components/conversation/AskUserQuestionCard';
import { PermissionPromptCard } from '@/components/conversation/PermissionPromptCard';
import { peekAwaitedPrompt } from '@/connection/actions';
import { buildPendingPromptSummary } from '@/conversation/pendingPromptSummary';
import type { AwaitedToolUse } from '@/conversation/pendingPromptSummary';
import type { PendingPromptDescriptor } from '@/conversation/transcriptCells';
import type { SessionActivityEntry } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';

export interface NeedsYouCardProps {
  entry: SessionActivityEntry;
}

/**
 * The Home feed's headline card: a session waiting on the user, answerable
 * INLINE. It embeds the same PermissionPromptCard / AskUserQuestionCard the
 * conversation renders (identical lifecycle, stale-prompt handling
 * included). The awaited tool_use details live in the transcript, which
 * background sessions do not retain, so the card renders a generic
 * Approve/Deny immediately and upgrades when a one-shot peek resolves.
 * Tapping the card body opens the task's Session view in CHAT mode (the
 * answerable side).
 */
export function NeedsYouCard({ entry }: NeedsYouCardProps): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const taskTitle = useBoardStore((state) => {
    const board = state.boardsByProjectId[entry.projectId];
    return board?.tasksById[entry.taskId]?.title ?? null;
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
        // Not connected / a just-died session: the generic card still answers.
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

  const prompt: PendingPromptDescriptor | null =
    awaitedPromptId === null
      ? null
      : {
          promptId: awaitedPromptId,
          sessionId: entry.sessionId,
          toolUseId: peekedToolUse?.toolUseId ?? null,
          toolName: peekedToolUse?.name ?? null,
          input: peekedToolUse?.input ?? null,
        };

  return (
    <Card testID={`needs-you-card-${entry.sessionId}`} onPress={openTask}>
      <Stack gap="xs">
        <Row gap="sm" style={styles.spaceBetween}>
          <StatusDot variant="needs-you" testID={`needs-you-card-${entry.sessionId}-status`} />
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
        {/* The one-line summary carries the card only until the peek
            resolves; the specific prompt card then says it all itself. */}
        {peekedToolUse === null ? (
          <Text variant="caption" color="accent">
            {buildPendingPromptSummary(null)}
          </Text>
        ) : null}
        {prompt ? (
          <View style={{ marginTop: theme.spacing.xs }}>
            {prompt.toolName === 'AskUserQuestion' ? (
              <AskUserQuestionCard sessionId={entry.sessionId} prompt={prompt} />
            ) : (
              <PermissionPromptCard sessionId={entry.sessionId} prompt={prompt} />
            )}
          </View>
        ) : null}
      </Stack>
    </Card>
  );
}

const styles = StyleSheet.create({
  spaceBetween: {
    justifyContent: 'space-between',
  },
  flex: {
    flex: 1,
  },
});
