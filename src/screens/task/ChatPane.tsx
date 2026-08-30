import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, Text } from '@/components';
import { ReadingViewFeed } from '@/components/conversation/ReadingViewFeed';
import { getRetentionProbeVariant } from '@/devsupport/retentionProbe';
import { useTranscriptStore } from '@/state/transcriptStore';
import { ConversationTab } from './ConversationTab';

export interface ChatPaneProps {
  taskId: string;
  sessionId: string | null;
  projectId: string | null;
  /** The task's agent name (board data), shown as the reading view's caption. Never gates behavior. */
  agentLabel: string | null;
}

/**
 * The Session screen's chat lens, chosen PER SESSION and agent-agnostic:
 * a session with a structured transcript renders the conversation feed; a
 * session without one (codex, gemini, a plain shell - detected by the
 * transcript being empty once loaded, never by agent name) degrades to the
 * cleaned live reading view derived from the terminal. One universal mental
 * model: Terminal = exact, Chat = readable.
 */
export function ChatPane({ taskId, sessionId, projectId, agentLabel }: ChatPaneProps): React.JSX.Element {
  /**
   * `hasWindow`, not the mere presence of a store entry, is what says a
   * transcript window has actually landed: a delta can arrive before the
   * window request resolves and create the entry with `totalEntries > 0` and
   * no entries at all. Routing on `totalEntries` alone rendered the
   * conversation feed with zero cells and no loading state there - a blank
   * screen, observed live.
   */
  const hasTranscriptWindow = useTranscriptStore((state) =>
    sessionId !== null ? (state.bySessionId[sessionId]?.hasWindow ?? false) : false,
  );
  const totalEntries = useTranscriptStore((state) =>
    sessionId !== null ? (state.bySessionId[sessionId]?.totalEntries ?? 0) : 0,
  );

  // Retention bisect: the floor. Reproduces the "ChatPane not rendered" arm.
  if (getRetentionProbeVariant() === 'no-conversation') {
    return <View style={styles.loading} testID="chat-pane-retention-probe-empty" />;
  }

  if (sessionId === null) {
    // ConversationTab owns the no-session empty state.
    return <ConversationTab taskId={taskId} sessionId={sessionId} projectId={projectId} />;
  }
  if (!hasTranscriptWindow) {
    return (
      <Stack gap="sm" style={styles.loading}>
        <Text variant="body" color="secondary" testID="chat-pane-loading">
          Loading conversation...
        </Text>
      </Stack>
    );
  }
  if (totalEntries === 0) {
    return <ReadingViewFeed sessionId={sessionId} agentLabel={agentLabel} />;
  }
  return <ConversationTab key={sessionId} taskId={taskId} sessionId={sessionId} projectId={projectId} />;
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
