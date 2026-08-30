import React from 'react';
import { StyleSheet, View } from 'react-native';
import { MarkdownBlock, Stack, Text } from '@/components';
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
  const probeVariant = getRetentionProbeVariant();
  if (probeVariant === 'no-conversation') {
    return <View style={styles.loading} testID="chat-pane-retention-probe-empty" />;
  }
  // Retention bisect: the minimal repro. One native markdown view, no list, no
  // cells, no recycling - so a leak here is the component's own lifecycle.
  // The empty arm creates the view but never renders (setMarkdownContent("")
  // returns before scheduleRender), which splits "exists" from "rendered".
  if (probeVariant === 'single-markdown' || probeVariant === 'markdown-empty') {
    return (
      <View style={styles.loading} testID="chat-pane-retention-probe-single">
        <MarkdownBlock
          markdown={probeVariant === 'markdown-empty' ? '' : PROBE_MARKDOWN}
          testID="chat-pane-retention-probe-markdown"
        />
      </View>
    );
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

/** Retention bisect content: one paragraph, no links, no images, no code. */
const PROBE_MARKDOWN = 'A **retention** probe paragraph.';

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
