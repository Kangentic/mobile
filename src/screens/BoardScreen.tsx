import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import PagerView from 'react-native-pager-view';
import { FlashList } from '@shopify/flash-list';
import type { BoardColumnWire, BoardTaskWire } from '@kangentic/protocol';
import { AppHeader, Badge, Card, ConnectionBanner, EmptyState, IconButton, Row, Screen, Sheet, Stack, Text, useTheme } from '@/components';
import { ColumnChipBar } from '@/components/board/ColumnChipBar';
import { MoveTaskSheet } from '@/components/board/MoveTaskSheet';
import { CreateTaskSheet } from '@/components/board/CreateTaskSheet';
import { EditTaskSheet } from '@/components/board/EditTaskSheet';
import { TaskActionsSheet } from '@/components/board/TaskActionsSheet';
import { selectColumnsOrdered, selectTasksForColumn, useBoardStore, type ProjectBoard } from '@/state/boardStore';
import { useActivityStore, sectionForEntry } from '@/state/activityStore';
import { StatusDot } from '@/components/StatusDot';
import { CapabilityError } from '@/channel';
import { archiveTask, createTask, deleteTaskFromBoard, moveTaskOptimistic, refreshSnapshots, updateTaskFields } from '@/connection/actions';
import { triggerHaptic } from '@/lib/haptics';

function messageForActionError(error: unknown, fallback: string): string {
  return error instanceof CapabilityError ? error.message : error instanceof Error ? error.message : fallback;
}

export function BoardScreen(): React.JSX.Element {
  const theme = useTheme();
  const projects = useBoardStore((state) => state.projects);
  const boardsByProjectId = useBoardStore((state) => state.boardsByProjectId);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [visiblePageIndex, setVisiblePageIndex] = useState(0);
  const pagerRef = useRef<PagerView>(null);

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
  const selectColumn = useCallback((columnIndex: number) => {
    setVisiblePageIndex(columnIndex);
    // Jest's PagerView stub has no imperative API; on-device it always does.
    const pager = pagerRef.current;
    if (pager && typeof pager.setPage === 'function') pager.setPage(columnIndex);
  }, []);

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
        testID="board-header"
      />
      <ConnectionBanner />

      {columns.length === 0 ? (
        <EmptyState
          testID="board-empty-state"
          title={projects.length === 0 ? 'No board yet' : 'No columns yet'}
          caption={
            projects.length === 0
              ? 'Connect to your desktop to see the board.'
              : 'This board has no columns yet. Add them from the desktop.'
          }
          overseerSize={54}
          overseerAnimate="blink-loop"
        />
      ) : (
        <>
          <View style={{ paddingVertical: theme.spacing.xs }}>
            <ColumnChipBar columns={columns} taskCounts={taskCounts} activeIndex={visiblePageIndex} onSelect={selectColumn} />
          </View>
          <PagerView
            ref={pagerRef}
            testID="board-pager"
            style={styles.pager}
            initialPage={0}
            onPageSelected={(event) => setVisiblePageIndex(event.nativeEvent.position)}
          >
            {columns.map((column) => (
              <View key={column.id} testID={`board-column-${column.id}`} style={styles.page}>
                <ColumnPage
                  column={column}
                  board={board}
                  onTaskLongPress={(task) => {
                    setActionsError(null);
                    setActionsTarget(task);
                  }}
                  projectId={projectId ?? ''}
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                />
              </View>
            ))}
          </PagerView>
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
        initialColumnName={columns[visiblePageIndex]?.name ?? null}
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
                setVisiblePageIndex(0);
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

function ColumnPage({
  column,
  board,
  projectId,
  onTaskLongPress,
  refreshing,
  onRefresh,
}: {
  column: BoardColumnWire;
  board: ProjectBoard | null;
  projectId: string;
  onTaskLongPress: (task: BoardTaskWire) => void;
  refreshing: boolean;
  onRefresh: () => void;
}): React.JSX.Element {
  const theme = useTheme();
  const tasks = useMemo(() => (board ? selectTasksForColumn(board, column.id) : []), [board, column.id]);

  // The chip bar already names the column and carries its count; the page
  // itself is all tasks. An empty column states itself plainly instead of
  // rendering silent blank space under the pager.
  if (tasks.length === 0) {
    return (
      <EmptyState
        testID={`board-column-${column.id}-empty`}
        title="Nothing here"
        caption={`No tasks in ${column.name}. Create one with the + button.`}
        overseerSize={54}
        overseerAnimate="none"
      />
    );
  }

  return (
    <FlashList<BoardTaskWire>
      testID={`board-column-${column.id}-list`}
      data={tasks}
      keyExtractor={(task) => task.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.colors.textSecondary} />}
      contentContainerStyle={{ paddingTop: theme.spacing.xs }}
      renderItem={({ item }) => (
        <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
          <TaskCard task={item} projectId={projectId} onLongPress={() => onTaskLongPress(item)} />
        </View>
      )}
    />
  );
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
  const router = useRouter();
  const activityEntry = useActivityStore((state) => (task.session_id ? (state.bySessionId[task.session_id] ?? null) : null));

  const openTask = useCallback(() => {
    router.push({
      pathname: '/task/[taskId]',
      params: { taskId: task.id, sessionId: task.session_id ?? '', projectId },
    });
  }, [router, task.id, task.session_id, projectId]);

  return (
    <Card testID={`board-card-${task.id}`} onPress={openTask} onLongPress={onLongPress}>
      <Stack gap="xs">
        <Row gap="sm" style={styles.spaceBetween}>
          {activityEntry ? <StatusDot variant={sectionForEntry(activityEntry)} testID={`board-card-${task.id}-status`} /> : null}
          <Text variant="bodyStrong" style={styles.flex} numberOfLines={2}>
            {task.title}
          </Text>
          {task.agent ? <Badge label={task.agent} color="secondary" /> : null}
        </Row>
        <Row gap="sm">
          <Text variant="caption" color="muted">
            #{task.display_id}
          </Text>
          {task.branch_name ? (
            <Text variant="caption" color="secondary" numberOfLines={1} style={styles.flex}>
              {task.branch_name}
            </Text>
          ) : null}
        </Row>
      </Stack>
    </Card>
  );
});

const styles = StyleSheet.create({
  pager: {
    flex: 1,
  },
  page: {
    flex: 1,
  },
  flex: {
    flex: 1,
  },
  spaceBetween: {
    justifyContent: 'space-between',
  },
  fabContainer: {
    position: 'absolute',
  },
});
