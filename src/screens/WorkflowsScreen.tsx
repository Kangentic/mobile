import React, { useCallback, useEffect } from 'react';
import { Pressable, ScrollView, StyleSheet, useWindowDimensions, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { ChevronRight } from 'lucide-react-native';
import { Row, SheetScrollerSlot, Stack, Text, sheetRowSurface, useTheme } from '@/components';
import { WorkflowGlyph } from '@/components/board/WorkflowGlyph';
import { WorkflowSummary } from '@/components/board/WorkflowStateChip';
import { fetchProjectWorkflows, fetchWorkflowDetail } from '@/connection/workflowActions';
import { clampSheetContentHeight, LIST_FLOOR_HEIGHT, WORKFLOWS_SHEET_RESERVED_HEIGHT } from '@/lib/sheetContentHeights';
import { useBoardStore, type ProjectBoard } from '@/state/boardStore';
import { selectProjectWorkflows, selectWorkflowDetailRead, useWorkflowStore } from '@/state/workflowStore';
import { workflowDoneCount, type WorkflowListEntry } from '@/workflow/workflowView';

const ROW_GLYPH_SIZE = 20;
const CHEVRON_SIZE = 16;
const ROW_MIN_HEIGHT = 60;

/** Shown when the list read failed and there is nothing held to show instead. */
export const WORKFLOWS_READ_FAILED_MESSAGE = 'Could not load the workflows';

/**
 * A workflow's color from any loaded board row of it: the list read carries no
 * color, and a row usually arrives first, so the glyph takes its color at once
 * rather than when the workflow's own read lands. Null when no board holds one.
 */
function colorSlotFromBoards(boardsByProjectId: Record<string, ProjectBoard>, workflowId: string): number | null {
  for (const board of Object.values(boardsByProjectId)) {
    for (const task of Object.values(board.tasksById)) {
      if (task.workflow?.id === workflowId) return task.workflow.color_slot;
    }
  }
  return null;
}

/**
 * A project's unfinished workflows, as a native form sheet route from the Board
 * header's Workflows button (design screen 6). One raised row per workflow,
 * reading the same on every row: its glyph in its color, its name, then the
 * desktop's state chip and its count ("1 of 6", "5 tasks" before it starts).
 * A finished workflow leaves the list, as it leaves the desktop's picker.
 *
 * Each row's count needs the workflow's own read (`get_workflow`), asked for
 * every row at once when the sheet opens; the row draws its chip at once and
 * its count when that lands. A row opens the workflow view by REPLACING this
 * sheet, as the Terminals sheet opens a terminal, so Back returns to the Board.
 *
 * A capped ScrollView rather than a FlashList, as the Move, project and
 * Terminals sheets are: a project's UNFINISHED workflows are a handful the
 * desktop's user starts by hand, and the cap is about the sheet's height, not
 * about virtualizing a list that grows without bound.
 */
export function WorkflowsScreen(): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: windowHeight } = useWindowDimensions();
  const { projectId: projectIdParam } = useLocalSearchParams<{ projectId?: string }>();
  const projectId = projectIdParam !== undefined && projectIdParam.length > 0 ? projectIdParam : null;
  const workflows = useWorkflowStore((state) => selectProjectWorkflows(state, projectId));
  const listStatus = useWorkflowStore((state) => (projectId !== null ? (state.listsByProjectId[projectId]?.status ?? null) : null));
  const listMaxHeight = clampSheetContentHeight({
    windowHeight,
    reservedHeight: WORKFLOWS_SHEET_RESERVED_HEIGHT + insets.bottom,
    floorHeight: LIST_FLOOR_HEIGHT,
  });

  useEffect(() => {
    if (projectId !== null) void fetchProjectWorkflows(projectId);
  }, [projectId]);
  // One read per listed workflow, for its color and its count.
  const workflowIdsKey = workflows.map((workflow) => workflow.id).join(',');
  useEffect(() => {
    if (projectId === null || workflowIdsKey.length === 0) return;
    for (const workflowId of workflowIdsKey.split(',')) void fetchWorkflowDetail(projectId, workflowId);
  }, [projectId, workflowIdsKey]);

  // Closes once there is nothing left to list: the last workflow finished
  // while the sheet was open, so the Board's button is gone too.
  const empty = listStatus === 'ready' && workflows.length === 0;
  useEffect(() => {
    if (empty && router.canGoBack()) router.back();
  }, [empty, router]);

  const openWorkflow = useCallback(
    (workflowId: string) => {
      if (projectId === null) return;
      router.replace({ pathname: '/workflow', params: { workflowId, projectId } });
    },
    [projectId, router],
  );

  return (
    <View
      style={[styles.container, { backgroundColor: theme.colors.surfaceOverlay, padding: theme.spacing.lg, paddingBottom: theme.spacing.xl + insets.bottom }]}
      testID="workflows-sheet"
    >
      <Stack gap="sm">
        <Text variant="title">Workflows</Text>
        <SheetScrollerSlot>
          <ScrollView style={{ maxHeight: listMaxHeight }} keyboardShouldPersistTaps="handled" testID="workflows-list">
            <Stack gap="xs">
              {workflows.map((workflow) => (
                <WorkflowRow key={workflow.id} workflow={workflow} onOpen={openWorkflow} />
              ))}
            </Stack>
          </ScrollView>
        </SheetScrollerSlot>
        {listStatus === 'failed' && workflows.length === 0 ? (
          <Text variant="caption" color="danger" testID="workflows-read-failed">
            {WORKFLOWS_READ_FAILED_MESSAGE}
          </Text>
        ) : null}
      </Stack>
    </View>
  );
}

function WorkflowRow({ workflow, onOpen }: { workflow: WorkflowListEntry; onOpen: (workflowId: string) => void }): React.JSX.Element {
  const theme = useTheme();
  const detailRead = useWorkflowStore((state) => selectWorkflowDetailRead(state, workflow.id));
  const boardColorSlot = useBoardStore((state) => colorSlotFromBoards(state.boardsByProjectId, workflow.id));
  const detail = detailRead?.detail ?? null;
  const colorSlot = detail?.colorSlot ?? boardColorSlot;
  const testIdKey = `workflows-row-${workflow.id}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`Open ${workflow.title}`}
      onPress={() => onOpen(workflow.id)}
      testID={testIdKey}
      style={[
        styles.row,
        sheetRowSurface(theme),
        { minHeight: ROW_MIN_HEIGHT, paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm },
      ]}
    >
      <Row gap="sm" style={styles.rowContent}>
        <WorkflowGlyph colorSlot={colorSlot} size={ROW_GLYPH_SIZE} testID={`${testIdKey}-glyph`} />
        <Stack gap="xs" style={styles.flex}>
          <Text variant="body" numberOfLines={1}>
            {workflow.title}
          </Text>
          <WorkflowSummary
            state={workflow.state}
            doneCount={detail !== null ? workflowDoneCount(detail) : null}
            taskCount={detail !== null ? detail.members.length : null}
            testID={`${testIdKey}-summary`}
          />
        </Stack>
        <ChevronRight size={CHEVRON_SIZE} color={theme.colors.textMuted} />
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  container: {
    // Deliberately not flex: 1 - 'fitToContents' needs measurable content.
    width: '100%',
  },
  row: {
    justifyContent: 'center',
  },
  rowContent: {
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
});
