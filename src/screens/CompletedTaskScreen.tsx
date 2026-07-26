import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { ClipboardList, MessagesSquare } from 'lucide-react-native';
import type { SessionSummaryWire } from '@kangentic/protocol';
import { EmptyState, MarkdownBlock, Screen, SegmentedSwitcher, Stack, Text, useTheme, type SegmentOption } from '@/components';
import { loadTranscriptTail } from '@/connection/actions';
import { findArchivedTaskById, useBoardStore } from '@/state/boardStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { ConversationTab } from './task/ConversationTab';
import { TaskHeader } from './task/TaskHeader';

type CompletedMode = 'conversation' | 'summary';

/**
 * A completed task has two surfaces, not the session's three.
 *
 * Terminal is impossible - the PTY is gone, and the desktop suspends it on the
 * move to Done. Changes is deliberately absent rather than empty: archiving
 * DELETES the worktree, and read-diff falls back to the project checkout when
 * a task has none, so a Changes tab here would render the repository's current
 * state and label it as this task's work. The captured files/lines totals live
 * in Summary instead, which is what the desktop shows for an archived task.
 */
const COMPLETED_MODE_OPTIONS: SegmentOption<CompletedMode>[] = [
  { mode: 'conversation', label: 'Conversation', accessibilityLabel: 'Conversation view', Icon: MessagesSquare },
  { mode: 'summary', label: 'Summary', accessibilityLabel: 'Summary view', Icon: ClipboardList },
];

export function CompletedTaskScreen(): React.JSX.Element {
  const { taskId, projectId } = useLocalSearchParams<{ taskId?: string; projectId?: string }>();
  // Select the STORED slice and derive from it. findArchivedTaskById builds a
  // fresh { projectId, task, summary } object per call, so calling it inside
  // the selector hands useSyncExternalStore a new snapshot on every render -
  // "getSnapshot should be cached", then an infinite update loop that takes
  // the screen down on open. The same trap bit CreateTaskScreen's column list.
  const archivedByProjectId = useBoardStore((state) => state.archivedByProjectId);
  const found = useMemo(
    () => (taskId ? findArchivedTaskById({ archivedByProjectId }, taskId) : null),
    [archivedByProjectId, taskId],
  );
  const [mode, setMode] = useState<CompletedMode>('conversation');
  const onModeChange = useCallback((next: CompletedMode) => setMode(next), []);
  const theme = useTheme();

  /**
   * The FIRST transcript fetch, which nothing else will do for a completed
   * task.
   *
   * ConversationTab self-heals only when the store raises `needsTailFetch`,
   * and that flag is set by the SUBSCRIBE path - "openSessionScreen does the
   * first fetch", as its own comment says. A completed task is deliberately
   * never subscribed: its agent is gone, and read-stream still requires a live
   * session for every action except the transcript window. So without this the
   * pane stays blank forever, showing nothing on the screen whose entire
   * purpose is the conversation.
   */
  const anchorSessionId = found?.summary?.sessionId ?? null;
  useEffect(() => {
    if (anchorSessionId === null) return;
    // RETAIN BEFORE FETCHING. applyWindow drops any window for a session that
    // is not retained - a memory guard so background sessions cannot pile up
    // transcripts - and retention is normally declared by openSessionScreen,
    // which this screen must never call (that subscribes a stream, and this
    // session's agent is gone). Without this the desktop returns the whole
    // transcript and the store discards it, which looks exactly like a
    // desktop that returned nothing.
    useTranscriptStore.getState().retainSession(anchorSessionId);
    void loadTranscriptTail(anchorSessionId).catch((error: unknown) => {
      if (__DEV__) console.warn('[completed-task] transcript unavailable:', error);
    });
  }, [anchorSessionId]);

  if (!found) {
    return (
      <Screen testID="completed-task-screen">
        <TaskHeader taskTitle="Completed task" sessionId={null} displayId={null} />
        <EmptyState
          testID="completed-task-missing"
          title="Task unavailable"
          caption="Open the Board's Done column to load it."
          overseerSize={54}
        />
      </Screen>
    );
  }

  const { task, summary } = found;

  return (
    <Screen testID="completed-task-screen">
      <TaskHeader taskTitle={task.title} sessionId={null} displayId={task.display_id} />

      <View style={styles.body}>
        {mode === 'conversation' ? (
          // The anchor is the summary's sessionId, not task.session_id: the
          // move to Done nulls the task's session while preserving the session
          // RECORDS the transcript is stitched from. With no summary there is
          // no anchor, which means the task never ran an agent.
          summary ? (
            <ConversationTab taskId={task.id} sessionId={summary.sessionId} projectId={projectId ?? null} />
          ) : (
            <EmptyState
              testID="completed-task-no-conversation"
              title="No conversation"
              caption="This task was completed without an agent."
              overseerSize={54}
            />
          )
        ) : (
          <SummaryPane task={{ description: task.description, archivedAt: task.archived_at }} summary={summary} />
        )}
      </View>

      <View style={[styles.footer, { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.md }]}>
        <SegmentedSwitcher<CompletedMode>
          testIDPrefix="completed-mode"
          options={COMPLETED_MODE_OPTIONS}
          mode={mode}
          onModeChange={onModeChange}
        />
      </View>
    </Screen>
  );
}

function SummaryPane({
  task,
  summary,
}: {
  task: { description: string; archivedAt: string | null };
  summary: SessionSummaryWire | null;
}): React.JSX.Element {
  const theme = useTheme();
  return (
    <ScrollView
      testID="completed-task-summary"
      contentContainerStyle={{ padding: theme.spacing.md, paddingBottom: theme.spacing.xxl }}
    >
      <Stack gap="lg">
        {task.description.length > 0 ? (
          <Stack gap="xs">
            <Text variant="caption" color="muted">Description</Text>
            {/* Descriptions are authored as markdown (the desktop renders them
                as such), so plain Text showed literal ** and backticks. */}
            <MarkdownBlock markdown={task.description} testID="completed-task-description" />
          </Stack>
        ) : null}

        {summary ? (
          <Stack gap="xs">
            <Text variant="caption" color="muted">Session</Text>
            <SummaryRow label="Completed" value={formatTimestamp(task.archivedAt)} />
            <SummaryRow label="Started" value={formatTimestamp(summary.startedAt)} />
            <SummaryRow label="Agent active" value={formatDuration(summary.durationMs)} />
            <SummaryRow label="Model" value={summary.modelDisplayName.length > 0 ? summary.modelDisplayName : 'Unknown'} />
            <SummaryRow label="Cost" value={formatCost(summary.totalCostUsd)} />
            <SummaryRow
              label="Tokens"
              value={`${formatCount(summary.totalInputTokens)} in / ${formatCount(summary.totalOutputTokens)} out`}
            />
            <SummaryRow label="Files changed" value={String(summary.filesChanged)} />
            <SummaryRow label="Lines changed" value={`+${formatCount(summary.linesAdded)} -${formatCount(summary.linesRemoved)}`} />
            <SummaryRow label="Tool calls" value={formatCount(summary.toolCallCount)} />
          </Stack>
        ) : (
          <Stack gap="xs">
            <Text variant="caption" color="muted">Session</Text>
            <Text color="muted">No agent ran on this task.</Text>
          </Stack>
        )}
      </Stack>
    </ScrollView>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View style={[styles.row, { paddingVertical: theme.spacing.xs, borderBottomColor: theme.colors.border }]}>
      <Text color="muted">{label}</Text>
      <Text>{value}</Text>
    </View>
  );
}

/** Compact date. Absolute rather than relative: a completed task is history, and "3 days ago" ages wrong when read later. */
function formatTimestamp(value: string | null): string {
  if (!value) return 'Unknown';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Unknown';
  return parsed.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return '0m';
  const totalMinutes = Math.round(milliseconds / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** Sub-cent costs round to $0.00, which reads as free; show them as the smallest real figure instead. */
function formatCost(totalCostUsd: number): string {
  if (totalCostUsd <= 0) return '$0.00';
  return totalCostUsd < 0.01 ? '<$0.01' : `$${totalCostUsd.toFixed(2)}`;
}

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

const styles = StyleSheet.create({
  body: {
    flex: 1,
  },
  footer: {
    // Matches the session screen's switcher placement, so the control lands in
    // the same spot whichever kind of task was opened.
    paddingTop: 0,
  },
  row: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
  },
});
