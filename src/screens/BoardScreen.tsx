import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import { FlashList, type FlashListRef } from '@shopify/flash-list';
import { GitPullRequest, Paperclip } from 'lucide-react-native';
import type { BoardColumnWire, BoardTaskWire } from '@kangentic/protocol';
import { AgentStatusIcon, AppHeader, Badge, Card, ConnectionBanner, EmptyState, IconButton, MonoText, Row, Screen, Sheet, Stack, Text, useTheme, type AgentStatusKind } from '@/components';
import { collapseToSnippetText } from '@/conversation/pendingPromptSummary';
import { ColumnChipBar } from '@/components/board/ColumnChipBar';
import { MoveTaskSheet } from '@/components/board/MoveTaskSheet';
import { CreateTaskSheet } from '@/components/board/CreateTaskSheet';
import { EditTaskSheet } from '@/components/board/EditTaskSheet';
import { TaskActionsSheet } from '@/components/board/TaskActionsSheet';
import { selectColumnsOrdered, selectTasksForColumn, useBoardStore, type ProjectBoard } from '@/state/boardStore';
import { useActivityStore, sectionForEntry } from '@/state/activityStore';
import { CapabilityError } from '@/channel';
import { archiveTask, createTask, deleteTaskFromBoard, moveTaskOptimistic, refreshSnapshots, updateTaskFields } from '@/connection/actions';
import { triggerHaptic } from '@/lib/haptics';

function messageForActionError(error: unknown, fallback: string): string {
  return error instanceof CapabilityError ? error.message : error instanceof Error ? error.message : fallback;
}

type BoardListRow =
  | { kind: 'column-header'; column: BoardColumnWire; count: number }
  | { kind: 'column-empty'; column: BoardColumnWire }
  | { kind: 'task'; task: BoardTaskWire; columnId: string };

export function BoardScreen(): React.JSX.Element {
  const theme = useTheme();
  const projects = useBoardStore((state) => state.projects);
  const boardsByProjectId = useBoardStore((state) => state.boardsByProjectId);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const listRef = useRef<FlashListRef<BoardListRow>>(null);

  const projectId = selectedProjectId ?? projects[0]?.id ?? null;
  const board: ProjectBoard | null = projectId ? (boardsByProjectId[projectId] ?? null) : null;
  const columns = useMemo(() => (board ? selectColumnsOrdered(board) : []), [board]);
  const taskCounts = useMemo(
    () => columns.map((column) => (board ? selectTasksForColumn(board, column.id).length : 0)),
    [columns, board],
  );
  const projectName = projects.find((project) => project.id === projectId)?.name ?? null;
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refreshSnapshots()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, []);
  // The whole board is ONE vertical list: a section (divider header +
  // cards) per column, scannable at a glance. Chips are quick filters that
  // jump-scroll to their column; scrolling moves the chip highlight back.
  const boardRows = useMemo<BoardListRow[]>(() => {
    if (!board) return [];
    const rows: BoardListRow[] = [];
    for (const column of columns) {
      const columnTasks = selectTasksForColumn(board, column.id);
      rows.push({ kind: 'column-header', column, count: columnTasks.length });
      if (columnTasks.length === 0) rows.push({ kind: 'column-empty', column });
      for (const task of columnTasks) rows.push({ kind: 'task', task, columnId: column.id });
    }
    return rows;
  }, [board, columns]);

  const headerIndexByColumnId = useMemo(() => {
    const indexMap = new Map<string, number>();
    boardRows.forEach((row, rowIndex) => {
      if (row.kind === 'column-header') indexMap.set(row.column.id, rowIndex);
    });
    return indexMap;
  }, [boardRows]);

  const activeColumnIndex = Math.max(
    0,
    columns.findIndex((candidate) => candidate.id === activeColumnId),
  );

  // Stable viewability callback (FlashList requires it not to change): it
  // only records WHICH column tops the viewport; the index is derived at
  // render time so no ref juggling is needed.
  const onViewableItemsChanged = useCallback(({ viewableItems }: { viewableItems: { item: unknown }[] }) => {
    const firstRow = viewableItems[0]?.item as BoardListRow | undefined;
    if (!firstRow) return;
    setActiveColumnId(firstRow.kind === 'task' ? firstRow.columnId : firstRow.column.id);
  }, []);

  const selectColumn = useCallback(
    (columnIndex: number) => {
      const column = columns[columnIndex];
      if (!column) return;
      setActiveColumnId(column.id);
      const headerIndex = headerIndexByColumnId.get(column.id);
      // Jest's FlashList stub has no imperative API; on-device it always does.
      const list = listRef.current;
      if (headerIndex !== undefined && list && typeof list.scrollToIndex === 'function') {
        list.scrollToIndex({ index: headerIndex, animated: true });
      }
    },
    [columns, headerIndexByColumnId],
  );

  const [actionsTarget, setActionsTarget] = useState<BoardTaskWire | null>(null);
  const [actionsInFlight, setActionsInFlight] = useState(false);
  const [actionsError, setActionsError] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<BoardTaskWire | null>(null);
  const [moveInFlight, setMoveInFlight] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [editTarget, setEditTarget] = useState<BoardTaskWire | null>(null);
  const [editInFlight, setEditInFlight] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [createVisible, setCreateVisible] = useState(false);
  const [createInFlight, setCreateInFlight] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const archiveAvailable = columns.some((column) => column.role === 'done');

  const onMove = useCallback(
    (targetSwimlaneId: string, position: 'top' | 'bottom') => {
      if (!moveTarget || !projectId || !board) return;
      const targetCount = selectTasksForColumn(board, targetSwimlaneId).length;
      setMoveInFlight(true);
      setMoveError(null);
      void moveTaskOptimistic({
        projectId,
        taskId: moveTarget.id,
        targetSwimlaneId,
        targetPosition: position === 'top' ? 0 : targetCount,
      })
        .then(() => {
          triggerHaptic('taskMoved');
          setMoveTarget(null);
        })
        .catch((error: unknown) => {
          setMoveError(error instanceof CapabilityError ? error.message : 'Move failed - check the connection');
        })
        .finally(() => setMoveInFlight(false));
    },
    [moveTarget, projectId, board],
  );

  const onCreate = useCallback(
    (input: { title: string; description: string; column: string }) => {
      if (!projectId) return;
      setCreateInFlight(true);
      setCreateError(null);
      void createTask({ projectId, ...input })
        .then(() => {
          triggerHaptic('taskCreated');
          setCreateVisible(false);
        })
        .catch((error: unknown) => {
          setCreateError(error instanceof CapabilityError ? error.message : 'Create failed - check the connection');
        })
        .finally(() => setCreateInFlight(false));
    },
    [projectId],
  );

  const onEditSave = useCallback(
    (fields: { title?: string; description?: string }) => {
      if (!editTarget || !projectId) return;
      setEditInFlight(true);
      setEditError(null);
      void updateTaskFields({ projectId, taskId: editTarget.id, ...fields })
        .then(() => setEditTarget(null))
        .catch((error: unknown) => setEditError(messageForActionError(error, 'Edit failed - check the connection')))
        .finally(() => setEditInFlight(false));
    },
    [editTarget, projectId],
  );

  const onArchive = useCallback(() => {
    if (!actionsTarget || !projectId) return;
    setActionsInFlight(true);
    setActionsError(null);
    void archiveTask({ projectId, taskId: actionsTarget.id })
      .then(() => setActionsTarget(null))
      .catch((error: unknown) => setActionsError(messageForActionError(error, 'Archive failed - check the connection')))
      .finally(() => setActionsInFlight(false));
  }, [actionsTarget, projectId]);

  const onDelete = useCallback(() => {
    if (!actionsTarget || !projectId) return;
    setActionsInFlight(true);
    setActionsError(null);
    void deleteTaskFromBoard({ projectId, taskId: actionsTarget.id })
      .then(() => {
        triggerHaptic('destructiveConfirmed');
        setActionsTarget(null);
      })
      .catch((error: unknown) => setActionsError(messageForActionError(error, 'Delete failed - check the connection')))
      .finally(() => setActionsInFlight(false));
  }, [actionsTarget, projectId]);

  return (
    <Screen testID="board-screen" edges={['left', 'right']}>
      {/* The header title IS the project switcher: the board is always
          "some project's board", so the current project stays visible and
          tappable even before a second project exists. */}
      <AppHeader
        title={projectName ?? 'Board'}
        subtitle={projectName ? 'Board' : undefined}
        onTitlePress={projects.length > 0 ? () => setProjectPickerVisible(true) : undefined}
        divider={columns.length === 0}
        testID="board-header"
      />
      <ConnectionBanner />

      {columns.length === 0 ? (
        <EmptyState
          testID="board-empty-state"
          title={projects.length === 0 ? 'No board yet' : 'No columns yet'}
          caption={projects.length === 0 ? 'Connect to your desktop to see the board.' : 'Add columns from the desktop.'}
          overseerSize={54}
          overseerAnimate="blink-loop"
        />
      ) : (
        <>
          {/* The chip row extends the header block: same surface, and it
              carries the divider so header + chips read as one anchored
              navigation surface (Material app-bar-with-tabs). */}
          <View
            style={{
              paddingTop: theme.spacing.xs,
              paddingBottom: theme.spacing.sm,
              backgroundColor: theme.colors.surface,
              borderBottomWidth: StyleSheet.hairlineWidth,
              borderBottomColor: theme.colors.border,
            }}
          >
            <ColumnChipBar columns={columns} taskCounts={taskCounts} activeIndex={activeColumnIndex} onSelect={selectColumn} />
          </View>
          <FlashList<BoardListRow>
            ref={listRef}
            testID="board-list"
            data={boardRows}
            refreshControl={
              // tintColor styles iOS; colors + progressBackgroundColor style
              // Android (stock is a white circle, jarring on the warm theme).
              <RefreshControl
                refreshing={refreshing}
                onRefresh={onRefresh}
                tintColor={theme.colors.textSecondary}
                colors={[theme.colors.accent]}
                progressBackgroundColor={theme.colors.surfaceOverlay}
              />
            }
            keyExtractor={(row) =>
              row.kind === 'column-header'
                ? `header-${row.column.id}`
                : row.kind === 'column-empty'
                  ? `empty-${row.column.id}`
                  : row.task.id
            }
            getItemType={(row) => row.kind}
            onViewableItemsChanged={onViewableItemsChanged}
            contentContainerStyle={{ paddingBottom: theme.spacing.xxl }}
            renderItem={({ item }) =>
              item.kind === 'column-header' ? (
                <ColumnDividerRow column={item.column} count={item.count} />
              ) : item.kind === 'column-empty' ? (
                <Text
                  variant="caption"
                  color="muted"
                  testID={`board-column-${item.column.id}-empty`}
                  style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}
                >
                  No tasks in {item.column.name}.
                </Text>
              ) : (
                <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
                  <TaskCard
                    task={item.task}
                    projectId={projectId ?? ''}
                    onLongPress={() => {
                      setActionsError(null);
                      setActionsTarget(item.task);
                    }}
                  />
                </View>
              )
            }
          />
        </>
      )}

      <View style={[styles.fabContainer, { right: theme.spacing.lg, bottom: theme.spacing.xl }]}>
        <IconButton
          iconName="add"
          variant="fab"
          onPress={() => {
            setCreateError(null);
            setCreateVisible(true);
          }}
          testID="board-create-task"
          accessibilityLabel="Create a task"
        />
      </View>

      <TaskActionsSheet
        visible={actionsTarget !== null}
        task={actionsTarget}
        archiveAvailable={archiveAvailable}
        onClose={() => setActionsTarget(null)}
        onMove={() => {
          setMoveError(null);
          setMoveTarget(actionsTarget);
          setActionsTarget(null);
        }}
        onEdit={() => {
          setEditError(null);
          setEditTarget(actionsTarget);
          setActionsTarget(null);
        }}
        onArchive={onArchive}
        onDelete={onDelete}
        actionInFlight={actionsInFlight}
        errorMessage={actionsError}
      />
      <MoveTaskSheet
        visible={moveTarget !== null}
        task={moveTarget}
        columns={columns}
        onClose={() => setMoveTarget(null)}
        onMove={onMove}
        moveInFlight={moveInFlight}
        errorMessage={moveError}
      />
      <EditTaskSheet
        visible={editTarget !== null}
        task={editTarget}
        onClose={() => setEditTarget(null)}
        onSave={onEditSave}
        saveInFlight={editInFlight}
        errorMessage={editError}
      />
      <CreateTaskSheet
        visible={createVisible}
        columns={columns}
        initialColumnName={columns[activeColumnIndex]?.name ?? null}
        onClose={() => setCreateVisible(false)}
        onCreate={onCreate}
        createInFlight={createInFlight}
        errorMessage={createError}
      />
      <Sheet visible={projectPickerVisible} onClose={() => setProjectPickerVisible(false)} title="Projects" testID="board-project-sheet">
        <Stack gap="xs">
          {projects.map((project) => (
            <Pressable
              key={project.id}
              testID={`board-project-${project.id}`}
              accessibilityRole="radio"
              accessibilityState={{ selected: project.id === projectId }}
              onPress={() => {
                setSelectedProjectId(project.id);
                setProjectPickerVisible(false);
                setActiveColumnId(null);
              }}
              style={{ minHeight: theme.minTouchSize, justifyContent: 'center', paddingHorizontal: theme.spacing.md }}
            >
              <Text variant="body" color={project.id === projectId ? 'primary' : 'secondary'}>
                {project.name}
              </Text>
            </Pressable>
          ))}
        </Stack>
      </Sheet>
    </Screen>
  );
}

/** A column's section divider: color dot, name, and count - the at-a-glance anchor row. */
function ColumnDividerRow({ column, count }: { column: BoardColumnWire; count: number }): React.JSX.Element {
  const theme = useTheme();
  return (
    <Row
      gap="sm"
      testID={`board-column-${column.id}`}
      style={[
        styles.columnDivider,
        {
          paddingHorizontal: theme.spacing.md,
          paddingTop: theme.spacing.lg,
          paddingBottom: theme.spacing.sm,
        },
      ]}
    >
      {column.color ? <View style={[styles.columnDividerDot, { backgroundColor: column.color }]} /> : null}
      <Text variant="title" style={styles.flex}>
        {column.name}
      </Text>
      <Badge label={String(count)} color="secondary" />
    </Row>
  );
}

/** Desktop-parity PR state colors (GitHub convention, from our tokens). */
function prStateColor(theme: ReturnType<typeof useTheme>, prState: string | null): string {
  if (prState === 'merged') return theme.colors.info;
  if (prState === 'closed') return theme.colors.danger;
  return theme.colors.success;
}

const CARD_LABEL_LIMIT = 3;
const CARD_DESCRIPTION_LINES = 2;

/** Context-usage tint thresholds, mirroring the desktop card's progress color ramp. */
function contextUsageColor(theme: ReturnType<typeof useTheme>, usedPercentage: number): string {
  if (usedPercentage >= 90) return theme.colors.danger;
  if (usedPercentage >= 70) return theme.colors.warning;
  return theme.colors.statusWorking;
}

const TaskCard = React.memo(function TaskCard({
  task,
  projectId,
  onLongPress,
}: {
  task: BoardTaskWire;
  projectId: string;
  onLongPress: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const router = useRouter();
  const activityEntry = useActivityStore((state) => (task.session_id ? (state.bySessionId[task.session_id] ?? null) : null));
  const showTicketNumbers = useBoardStore((state) => state.boardsByProjectId[projectId]?.showTicketNumbers ?? true);

  const openTask = useCallback(() => {
    router.push({
      pathname: '/task/[taskId]',
      params: { taskId: task.id, sessionId: task.session_id ?? '', projectId },
    });
  }, [router, task.id, task.session_id, projectId]);

  // Desktop TaskCard parity: spinner while thinking, mail while the
  // session waits on the user (permission or idle).
  const statusKind: AgentStatusKind | null = activityEntry
    ? sectionForEntry(activityEntry) === 'working'
      ? 'working'
      : sectionForEntry(activityEntry) === 'needs-you' || activityEntry.unreadCount > 0
        ? 'idle-unread'
        : 'idle'
    : null;
  const visibleLabels = task.labels.slice(0, CARD_LABEL_LIMIT);
  const hiddenLabelCount = task.labels.length - visibleLabels.length;
  const hasMetaRow = visibleLabels.length > 0 || task.pr_number !== null || task.attachment_count > 0;
  const descriptionPreview = task.description.length > 0 ? collapseToSnippetText(task.description) : '';

  // Desktop parity: the model + context bar renders only when the session
  // reports a trustworthy window (a sane size the used tokens fit inside).
  const usage = activityEntry?.usage ?? null;
  const contextWindowTrusted =
    usage !== null &&
    usage.contextWindow.contextWindowSize > 0 &&
    usage.contextWindow.usedTokens <= usage.contextWindow.contextWindowSize;
  const usedPercentage = contextWindowTrusted ? Math.round(usage.contextWindow.usedPercentage) : 0;

  return (
    <Card testID={`board-card-${task.id}`} onPress={openTask} onLongPress={onLongPress}>
      <Stack gap="xs">
        <Row gap="sm" style={styles.spaceBetween}>
          {statusKind ? <AgentStatusIcon kind={statusKind} testID={`board-card-${task.id}-status`} /> : null}
          {/* Desktop parity: single-line truncating title, no agent badge
              (the agent shows inside the session, not on the card). */}
          <Text variant="bodyStrong" style={styles.flex} numberOfLines={1}>
            {task.title}
          </Text>
          {showTicketNumbers ? (
            <MonoText size="caption" color="muted" testID={`board-card-${task.id}-display-id`}>
              #{task.display_id}
            </MonoText>
          ) : null}
        </Row>
        {descriptionPreview.length > 0 ? (
          <Text variant="caption" color="muted" numberOfLines={CARD_DESCRIPTION_LINES}>
            {descriptionPreview}
          </Text>
        ) : null}
        {hasMetaRow ? (
          <Row gap="sm" style={styles.metaRow}>
            {visibleLabels.map((label) => (
              <Badge key={label} label={label} color="secondary" />
            ))}
            {hiddenLabelCount > 0 ? <Badge label={`+${hiddenLabelCount}`} color="secondary" /> : null}
            <View style={styles.flex} />
            {task.pr_number !== null ? (
              <Row gap="xs" style={styles.metaItem} testID={`board-card-${task.id}-pr`}>
                <GitPullRequest size={12} color={prStateColor(theme, task.pr_state)} />
                <Text variant="caption" color="secondary">
                  #{task.pr_number}
                </Text>
              </Row>
            ) : null}
            {task.attachment_count > 0 ? (
              <Row gap="xs" style={styles.metaItem}>
                <Paperclip size={12} color={theme.colors.textMuted} />
                <Text variant="caption" color="muted">
                  {task.attachment_count}
                </Text>
              </Row>
            ) : null}
          </Row>
        ) : null}
        {contextWindowTrusted ? (
          // Desktop parity: model + percent on one line, the bar full-width
          // beneath, separated from the card content by a hairline (the
          // same utility-strip treatment as the Agents feed rows).
          <View
            style={[
              styles.usageStrip,
              { borderTopColor: theme.colors.border, marginTop: theme.spacing.xs, paddingTop: theme.spacing.sm },
            ]}
            testID={`board-card-${task.id}-usage`}
          >
            <Row gap="sm" style={styles.spaceBetween}>
              <Text variant="caption" color="muted">
                {usage.model.displayName}
              </Text>
              <Text variant="caption" color="secondary">
                {usedPercentage}%
              </Text>
            </Row>
            <View style={[styles.usageTrack, { backgroundColor: theme.colors.border, marginTop: theme.spacing.xs }]}>
              <View
                style={[
                  styles.usageFill,
                  { backgroundColor: contextUsageColor(theme, usedPercentage), width: `${usedPercentage}%` },
                ]}
              />
            </View>
          </View>
        ) : null}
      </Stack>
    </Card>
  );
});

const COLUMN_DIVIDER_DOT_SIZE = 10;

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  spaceBetween: {
    justifyContent: 'space-between',
  },
  metaRow: {
    alignItems: 'center',
  },
  metaItem: {
    alignItems: 'center',
  },
  usageStrip: {
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  usageTrack: {
    borderRadius: 2,
    height: 4,
    overflow: 'hidden',
  },
  usageFill: {
    borderRadius: 2,
    height: '100%',
  },
  columnDivider: {
    alignItems: 'center',
  },
  columnDividerDot: {
    width: COLUMN_DIVIDER_DOT_SIZE,
    height: COLUMN_DIVIDER_DOT_SIZE,
    borderRadius: COLUMN_DIVIDER_DOT_SIZE / 2,
  },
  fabContainer: {
    position: 'absolute',
  },
});
