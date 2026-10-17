import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { Workflow } from 'lucide-react-native';
import { PressScale, Row, Text, useTheme } from '@/components';
import { fetchProjectWorkflows } from '@/connection/workflowActions';
import { sectionForEntry, useActivityStore, type SessionActivityEntry } from '@/state/activityStore';
import { useBoardStore, type ProjectBoard } from '@/state/boardStore';
import { selectProjectWorkflows, useWorkflowStore } from '@/state/workflowStore';

const GLYPH_SIZE = 18;

/**
 * How the button reads at a glance, as the Terminals button beside it does:
 * NEEDS YOU (amber) when an agent on one of the project's workflows is idle or
 * asking, WORKING (green) while any works and none waits, and REST when no
 * workflow task has an agent at all (a workflow can be all To Do, or paused).
 */
export type WorkflowsButtonTone = 'needs-you' | 'working' | 'rest';

function sessionTone(entry: SessionActivityEntry | undefined): WorkflowsButtonTone {
  if (entry === undefined || entry.feedStatus === 'ended' || entry.sessionStatus === 'suspended') return 'rest';
  if (entry.sessionStatus === 'queued' || !entry.activityObserved) return 'working';
  return sectionForEntry(entry) === 'working' ? 'working' : 'needs-you';
}

export function workflowsButtonTone(tones: readonly WorkflowsButtonTone[]): WorkflowsButtonTone {
  if (tones.includes('needs-you')) return 'needs-you';
  if (tones.includes('working')) return 'working';
  return 'rest';
}

/**
 * The session ids of every task on any loaded board that belongs to one of
 * these workflows, joined into one string so the selector's answer is a
 * primitive and the header re-renders only when the set changes. A workflow
 * can span boards, so every project's board is searched, not only this one.
 */
function workflowSessionKey(boardsByProjectId: Record<string, ProjectBoard>, workflowIds: ReadonlySet<string>): string {
  if (workflowIds.size === 0) return '';
  const sessionIds: string[] = [];
  for (const board of Object.values(boardsByProjectId)) {
    for (const task of Object.values(board.tasksById)) {
      if (task.session_id !== null && task.workflow && workflowIds.has(task.workflow.id)) sessionIds.push(task.session_id);
    }
  }
  return sessionIds.sort().join(',');
}

/**
 * Which of this board's workflows have changed state, as one string: when a
 * workflow starts, pauses, resumes or finishes, its tasks' rows say so first,
 * and the list is read again so the button and the sheet follow.
 */
function boardWorkflowDigest(board: ProjectBoard | undefined): string {
  if (!board) return '';
  const states = new Set<string>();
  for (const task of Object.values(board.tasksById)) {
    if (task.workflow) states.add(`${task.workflow.id}:${task.workflow.state}`);
  }
  return [...states].sort().join(',');
}

/**
 * The Board header's Workflows button (design screen 6, decision H1): the
 * project's unfinished workflows at a glance, beside Terminals. The workflow
 * glyph and how many there are, toned like the Terminals button. A tap opens
 * the Workflows sheet.
 *
 * Hidden while the project has none, and when the first read fails: a desktop
 * that predates workflows refuses the tool, and has none to show. A re-read
 * that fails after a good one keeps the last list (the store's rule), so the
 * button stays as it was rather than vanishing on a dropped read.
 */
export function WorkflowsButton({ projectId }: { projectId: string }): React.JSX.Element | null {
  const theme = useTheme();
  const router = useRouter();
  const workflows = useWorkflowStore((state) => selectProjectWorkflows(state, projectId));
  const digest = useBoardStore((state) => boardWorkflowDigest(state.boardsByProjectId[projectId]));

  // The focus read below covers the mount and a project switch, so this one
  // reads only when the board's workflow states change after that. Both
  // reading on mount cost a second, guaranteed-redundant round trip.
  const digestProjectId = useRef<string | null>(null);
  useEffect(() => {
    if (digestProjectId.current !== projectId) {
      digestProjectId.current = projectId;
      return;
    }
    void fetchProjectWorkflows(projectId);
  }, [projectId, digest]);
  useFocusEffect(
    useCallback(() => {
      void fetchProjectWorkflows(projectId);
    }, [projectId]),
  );

  const workflowIds = useMemo(() => new Set(workflows.map((workflow) => workflow.id)), [workflows]);
  const sessionKey = useBoardStore((state) => workflowSessionKey(state.boardsByProjectId, workflowIds));
  const toneKey = useActivityStore((state) =>
    sessionKey.length === 0 ? '' : sessionKey.split(',').map((sessionId) => sessionTone(state.bySessionId[sessionId])).join(','),
  );
  const tone = workflowsButtonTone(toneKey.length === 0 ? [] : (toneKey.split(',') as WorkflowsButtonTone[]));

  const onPress = useCallback(() => {
    router.push({ pathname: '/workflows', params: { projectId } });
  }, [projectId, router]);

  if (workflows.length === 0) return null;

  const glyphColor =
    tone === 'needs-you' ? theme.colors.statusNeedsYou : tone === 'working' ? theme.colors.statusWorking : theme.colors.textSecondary;
  const accessibilityLabel = `Workflows, ${workflows.length} open${tone === 'needs-you' ? ', one or more need you' : ''}`;

  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      testID="header-workflows-button"
      onPress={onPress}
      style={[
        styles.pill,
        {
          minHeight: theme.minTouchSize,
          minWidth: theme.minTouchSize,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.minTouchSize / 2,
          backgroundColor: theme.colors.surfaceRaised,
          borderColor: theme.colors.border,
        },
      ]}
    >
      <Row gap="xs" style={styles.content}>
        {/* The testID rides a wrapping View: lucide forwards `testID` as the
            web-only `data-testid`, which neither RNTL nor Maestro can select. */}
        <View testID={`header-workflows-${tone}`}>
          <Workflow size={GLYPH_SIZE} color={glyphColor} />
        </View>
        <Text variant="bodyStrong" testID="header-workflows-count">
          {workflows.length}
        </Text>
      </Row>
    </PressScale>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  content: {
    alignItems: 'center',
  },
});
