import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { FlashList } from '@shopify/flash-list';
import { CirclePause } from 'lucide-react-native';
import type { BoardColumnWire, BoardTaskWire } from '@kangentic/protocol';
import {
  Badge,
  Button,
  Card,
  ConnectionBanner,
  IconButton,
  MonoText,
  PressScale,
  Row,
  Screen,
  SkeletonCard,
  Stack,
  Text,
  useTheme,
} from '@/components';
import { getColumnIcon } from '@/components/board/columnIcons';
import { WorkflowGlyph } from '@/components/board/WorkflowGlyph';
import { openProjectBoard } from '@/connection/actions';
import { controlWorkflow, fetchWorkflowDetail } from '@/connection/workflowActions';
import { selectColumnsOrdered, useBoardStore, type ProjectBoard } from '@/state/boardStore';
import { selectWorkflowDetailRead, useWorkflowStore } from '@/state/workflowStore';
import { normalizeWorkflowState, type WorkflowStateName } from '@/workflow/workflowState';
import { WORKFLOW_DONE_SECTION_KEY, groupWorkflowMembers, type WorkflowMember, type WorkflowSection } from '@/workflow/workflowView';
import { BoardTaskCard } from '../board/BoardTaskCard';

const HEADER_GLYPH_SIZE = 18;
const SECTION_GLYPH_SIZE = 18;
const BUTTON_GLYPH_SIZE = 16;
const SKELETON_KEYS = ['workflow-skeleton-1', 'workflow-skeleton-2', 'workflow-skeleton-3'];
/** How long the view waits after a board change before re-reading the workflow, so a burst of task events costs one read. */
const REREAD_DEBOUNCE_MS = 400;

export const WORKFLOW_READ_FAILED_MESSAGE = 'Could not load this workflow';

type WorkflowListItem =
  | { kind: 'section'; key: string; section: WorkflowSection }
  | { kind: 'card'; key: string; member: WorkflowMember; row: BoardTaskWire }
  | { kind: 'compact'; key: string; member: WorkflowMember };

/** A task's board row, when its board is loaded. */
function rowOf(boardsByProjectId: Record<string, ProjectBoard>, member: WorkflowMember): BoardTaskWire | null {
  if (member.taskId === null) return null;
  return boardsByProjectId[member.projectId]?.tasksById[member.taskId] ?? null;
}

/**
 * One workflow, as a full screen (design screen 7, V6, signed off 2026-10-17):
 * the desktop's workflow canvas turned into a list that reads like the board.
 *
 * - The header is one row (task #124, signed off 2026-10-21): the workflow's
 *   glyph, its name on one truncating line, and its one Pause or Resume, which
 *   acts at once with no confirmation, as the desktop's header does. The
 *   button is what names the state, as the desktop's buttons do; a workflow
 *   not started or finished has no button and no state word, because the list
 *   shows it (every task planned in To Do, or every task in Done). There is no
 *   state chip, count or tally: each section below carries its own count.
 *   That departs from the desktop's header on purpose: it also shows "N of M
 *   done", a segmented progress bar and in progress, queued and blocked
 *   counts, which the phone leaves to the sections. Planning, Start and
 *   Delete stay on the desktop.
 * - Under it, the board's columns in board order, holding only this workflow's
 *   tasks, each card the desktop canvas's own (BoardTaskCard's `canvas`
 *   variant). A done task is the Done column's compact card.
 *
 * Live: the board rows and activity drive every card, and the workflow is read
 * again whenever one of its tasks moves or its state changes.
 */
export function WorkflowScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ workflowId?: string; projectId?: string }>();
  const workflowId = params.workflowId !== undefined && params.workflowId.length > 0 ? params.workflowId : null;
  const homeProjectId = params.projectId !== undefined && params.projectId.length > 0 ? params.projectId : null;

  const detailRead = useWorkflowStore((state) => selectWorkflowDetailRead(state, workflowId));
  const control = useWorkflowStore((state) => (workflowId !== null ? (state.controlsById[workflowId] ?? null) : null));
  const controlFailure = useWorkflowStore((state) => (workflowId !== null ? (state.controlFailuresById[workflowId] ?? null) : null));
  const boardsByProjectId = useBoardStore((state) => state.boardsByProjectId);
  const detail = detailRead?.detail ?? null;

  const reread = useCallback(() => {
    if (workflowId !== null && homeProjectId !== null) void fetchWorkflowDetail(homeProjectId, workflowId);
  }, [workflowId, homeProjectId]);
  useFocusEffect(reread);

  // Every board one of its tasks sits on, in full, so their cards draw.
  const involvedProjectsKey = useMemo(
    () => (detail ? [...new Set(detail.members.map((member) => member.projectId))].sort().join(',') : ''),
    [detail],
  );
  useEffect(() => {
    if (involvedProjectsKey.length === 0) return;
    for (const projectId of involvedProjectsKey.split(',')) openProjectBoard(projectId);
  }, [involvedProjectsKey]);

  // A task moving, finishing or pausing reaches the phone as a board row
  // first; the workflow's own read (its order, its counts) follows it. The
  // first digest is skipped: it is the read that just landed, or the one held
  // when the screen opened, which the focus read already covers.
  const rowsDigestSeen = useRef(false);
  const rowsDigest = useMemo(() => {
    if (!detail) return '';
    return detail.members
      .map((member) => {
        const row = rowOf(boardsByProjectId, member);
        return `${member.key}:${row?.swimlane_id ?? ''}:${row?.archived_at ?? ''}:${row?.workflow?.state ?? ''}`;
      })
      .join('|');
  }, [detail, boardsByProjectId]);
  useEffect(() => {
    if (rowsDigest.length === 0) return;
    if (!rowsDigestSeen.current) {
      rowsDigestSeen.current = true;
      return;
    }
    const rereadTimer = setTimeout(reread, REREAD_DEBOUNCE_MS);
    return () => clearTimeout(rereadTimer);
  }, [rowsDigest, reread]);

  // The board rows are newer than the last read, so the header follows them.
  const liveWorkflow = useMemo(() => {
    if (!detail) return null;
    for (const member of detail.members) {
      const workflow = rowOf(boardsByProjectId, member)?.workflow;
      if (workflow && workflow.id === detail.id) return workflow;
    }
    return null;
  }, [detail, boardsByProjectId]);
  const state: WorkflowStateName | null = liveWorkflow ? normalizeWorkflowState(liveWorkflow.state) : (detail?.state ?? null);

  const columnsByProjectId = useMemo(() => {
    const byProject: Record<string, readonly BoardColumnWire[]> = {};
    for (const [projectId, board] of Object.entries(boardsByProjectId)) byProject[projectId] = selectColumnsOrdered(board);
    return byProject;
  }, [boardsByProjectId]);
  const sections = useMemo(
    () => (detail ? groupWorkflowMembers({ detail, columnsByProjectId, rowFor: (member) => rowOf(boardsByProjectId, member) }) : []),
    [detail, columnsByProjectId, boardsByProjectId],
  );

  const items = useMemo(() => {
    const listItems: WorkflowListItem[] = [];
    for (const section of sections) {
      listItems.push({ kind: 'section', key: `section-${section.key}`, section });
      for (const member of section.members) {
        const row = rowOf(boardsByProjectId, member);
        const key = `${member.projectId}:${member.taskId ?? member.key}`;
        if (row !== null && row.archived_at === null && section.key !== WORKFLOW_DONE_SECTION_KEY) listItems.push({ kind: 'card', key, member, row });
        else listItems.push({ kind: 'compact', key, member });
      }
    }
    return listItems;
  }, [sections, boardsByProjectId]);

  const onLongPressTask = useCallback(
    (task: BoardTaskWire, projectId: string) => {
      router.push({ pathname: '/task-actions', params: { taskId: task.id, projectId } });
    },
    [router],
  );

  const renderItem = useCallback(
    ({ item }: { item: WorkflowListItem }) => {
      if (item.kind === 'section') return <ColumnSectionHeader section={item.section} />;
      if (item.kind === 'card') {
        return (
          <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
            <BoardTaskCard
              task={item.row}
              projectId={item.member.projectId}
              onLongPressTask={onLongPressTask}
              variant="canvas"
              testID={`workflow-card-${item.row.id}`}
            />
          </View>
        );
      }
      return <CompactTaskCard member={item.member} />;
    },
    [theme.spacing.md, theme.spacing.sm, onLongPressTask],
  );

  const title = liveWorkflow?.title ?? detail?.title ?? '';
  const colorSlot = liveWorkflow?.color_slot ?? detail?.colorSlot ?? null;
  // A route that names no workflow or no project has nothing to ask, so it
  // says the read failed rather than holding the placeholders forever.
  const routable = workflowId !== null && homeProjectId !== null;
  const loading = routable && detail === null && detailRead?.status !== 'failed';
  const failed = detail === null && (!routable || detailRead?.status === 'failed');

  return (
    <Screen testID="workflow-screen">
      <Row
        gap="sm"
        style={[
          styles.header,
          {
            paddingTop: insets.top,
            paddingHorizontal: theme.spacing.xs,
            paddingRight: theme.spacing.sm,
            minHeight: insets.top + theme.minTouchSize + theme.spacing.md,
            backgroundColor: theme.colors.surface,
            borderBottomColor: theme.colors.border,
          },
        ]}
        testID="workflow-header"
      >
        <IconButton iconName="chevron-back" onPress={() => router.back()} testID="workflow-back" accessibilityLabel="Back" />
        <WorkflowGlyph colorSlot={colorSlot} size={HEADER_GLYPH_SIZE} testID="workflow-glyph" />
        <Text variant="bodyStrong" numberOfLines={1} style={styles.flex} testID="workflow-title">
          {title}
        </Text>
        {state !== null && workflowId !== null && homeProjectId !== null ? (
          <WorkflowControlButton
            state={state}
            control={control}
            onPress={() => void controlWorkflow(state === 'paused' ? 'resume' : 'pause', homeProjectId, workflowId)}
          />
        ) : null}
      </Row>
      <ConnectionBanner />
      {controlFailure !== null ? (
        <Text
          variant="caption"
          color="danger"
          style={{ paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm }}
          testID="workflow-control-failed"
        >
          {controlFailure}
        </Text>
      ) : null}

      {loading ? (
        <Stack gap="sm" style={{ padding: theme.spacing.md }} testID="workflow-loading">
          {SKELETON_KEYS.map((skeletonKey) => (
            <SkeletonCard key={skeletonKey} />
          ))}
        </Stack>
      ) : failed ? (
        <Stack gap="sm" style={{ padding: theme.spacing.lg }} testID="workflow-read-failed">
          <Text variant="body" color="secondary">
            {WORKFLOW_READ_FAILED_MESSAGE}
          </Text>
          {routable ? <Button label="Try again" variant="tinted" onPress={reread} testID="workflow-retry" /> : null}
        </Stack>
      ) : (
        <FlashList<WorkflowListItem>
          testID="workflow-list"
          data={items}
          keyExtractor={(item) => item.key}
          getItemType={(item) => item.kind}
          renderItem={renderItem}
          contentContainerStyle={{ paddingBottom: theme.spacing.xl + insets.bottom }}
        />
      )}
    </Screen>
  );
}

/**
 * The header's one control: Pause while running, an amber Resume when paused
 * (the desktop's primary button), and nothing for a workflow that has not
 * started or has finished. Reads "Pausing..." or "Resuming..." until the
 * desktop answers.
 */
function WorkflowControlButton({
  state,
  control,
  onPress,
}: {
  state: WorkflowStateName;
  control: 'pausing' | 'resuming' | null;
  onPress: () => void;
}): React.JSX.Element | null {
  const theme = useTheme();
  if (state !== 'running' && state !== 'paused') return null;
  const resume = state === 'paused';
  const label = control === 'pausing' ? 'Pausing...' : control === 'resuming' ? 'Resuming...' : resume ? 'Resume' : 'Pause';
  return (
    <PressScale
      accessibilityRole="button"
      accessibilityLabel={resume ? 'Resume workflow' : 'Pause workflow'}
      accessibilityState={{ disabled: control !== null }}
      disabled={control !== null}
      onPress={onPress}
      testID={resume ? 'workflow-resume' : 'workflow-pause'}
      style={[
        styles.controlPill,
        {
          minHeight: theme.minTouchSize,
          minWidth: theme.minTouchSize,
          paddingHorizontal: theme.spacing.md,
          borderRadius: theme.minTouchSize / 2,
          backgroundColor: resume ? theme.colors.accent : theme.colors.surfaceRaised,
          borderColor: resume ? theme.colors.accent : theme.colors.border,
          opacity: control !== null ? 0.6 : 1,
        },
      ]}
    >
      <Row gap="xs" style={styles.centered}>
        {resume ? null : <CirclePause size={BUTTON_GLYPH_SIZE} color={theme.colors.textSecondary} />}
        <Text variant="bodyStrong" style={resume ? { color: theme.colors.onAccent } : undefined}>
          {label}
        </Text>
      </Row>
    </PressScale>
  );
}

/**
 * The column's own glyph. A plain function, not a component, for the reason
 * ColumnStrip's `columnMarker` is one: the React Compiler's static-components
 * rule cannot see that the registry's entries are stable.
 */
function columnGlyph(column: BoardColumnWire, color: string): React.JSX.Element | null {
  const ColumnIcon = getColumnIcon(column);
  return ColumnIcon !== null ? <ColumnIcon size={SECTION_GLYPH_SIZE} color={color} /> : null;
}

/** A column's heading in the view: its glyph in its color, its name, and how many of the workflow's tasks it holds. */
function ColumnSectionHeader({ section }: { section: WorkflowSection }): React.JSX.Element {
  const theme = useTheme();
  const glyphColor = section.column && section.column.color.length > 0 ? section.column.color : theme.colors.textMuted;
  return (
    <View
      accessibilityRole="header"
      accessibilityLabel={`${section.name}, ${section.members.length}`}
      style={{ paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.lg, paddingBottom: theme.spacing.sm }}
      testID={`workflow-section-${section.key}`}
    >
      <Row gap="xs" style={styles.centered}>
        {section.column !== null ? columnGlyph(section.column, glyphColor) : null}
        <Text variant="title" color="secondary">
          {section.name}
        </Text>
        <Badge label={String(section.members.length)} shape="pill" compact align="center" />
      </Row>
    </View>
  );
}

/**
 * A task with no live card: one in Done (the Done column's compact card, its
 * title and number), one whose board the phone has not loaded, or a planned
 * task of a workflow not started, which has no number yet.
 */
function CompactTaskCard({ member }: { member: WorkflowMember }): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  // The task's own board decides, as every other card's number does.
  const showTicketNumbers = useBoardStore((state) => state.boardsByProjectId[member.projectId]?.showTicketNumbers ?? true);
  // A finished task opens its run, as a card in the Board's Done column does.
  // A planned task and one on an unloaded board have nothing to open yet.
  const taskId = member.taskId;
  const openCompleted =
    member.place === 'done' && taskId !== null
      ? () => router.push({ pathname: '/completed-task', params: { taskId, projectId: member.projectId } })
      : undefined;
  return (
    <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
      <Card testID={`workflow-compact-${member.taskId ?? member.key}`} onPress={openCompleted}>
        <Row gap="sm" style={styles.centered}>
          <Text variant="body" color={member.place === 'done' ? 'secondary' : 'primary'} numberOfLines={1} style={styles.flex}>
            {member.title}
          </Text>
          {showTicketNumbers && member.displayId !== null ? (
            <MonoText size="caption" color="muted">
              {`#${member.displayId}`}
            </MonoText>
          ) : null}
        </Row>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignItems: 'center',
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  flex: {
    flex: 1,
  },
  centered: {
    alignItems: 'center',
  },
  controlPill: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
