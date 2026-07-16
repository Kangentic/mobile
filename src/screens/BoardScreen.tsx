import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import PagerView from 'react-native-pager-view';
import { FlashList } from '@shopify/flash-list';
import type { BoardColumnWire, BoardTaskWire } from '@kangentic/protocol';
import { Badge, Card, ConnectionBanner, IconButton, Row, Screen, Sheet, Stack, Text, useTheme } from '@/components';
import { MoveTaskSheet } from '@/components/board/MoveTaskSheet';
import { CreateTaskSheet } from '@/components/board/CreateTaskSheet';
import { EditTaskSheet } from '@/components/board/EditTaskSheet';
import { TaskActionsSheet } from '@/components/board/TaskActionsSheet';
import { selectColumnsOrdered, selectTasksForColumn, useBoardStore, type ProjectBoard } from '@/state/boardStore';
import { useActivityStore, sectionForEntry } from '@/state/activityStore';
import { StatusDot } from '@/components/StatusDot';
import { CapabilityError } from '@/channel';
import { archiveTask, createTask, deleteTaskFromBoard, moveTaskOptimistic, updateTaskFields } from '@/connection/actions';
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
  const projectName = projects.find((project) => project.id === projectId)?.name ?? null;

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
    <Screen testID="board-screen">
      <ConnectionBanner />
      {projects.length > 1 ? (
        <Pressable
          testID="board-project-picker"
          accessibilityRole="button"
          onPress={() => setProjectPickerVisible(true)}
          style={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.xs, minHeight: theme.minTouchSize, justifyContent: 'center' }}
        >
          <Text variant="caption" color="accent">
            {projectName ?? 'Select project'} ▾
          </Text>
        </Pressable>
      ) : null}

      {columns.length === 0 ? (
        <Stack gap="sm" style={[styles.emptyState, { padding: theme.spacing.xl }]}>
          <Text variant="body" color="secondary" style={styles.centeredText}>
            {projects.length === 0 ? 'Connect to your desktop to see the board.' : 'This board has no columns yet.'}
          </Text>
        </Stack>
      ) : (
        <>
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
                />
              </View>
            ))}
          </PagerView>
          <Row gap="xs" style={[styles.pageDots, { paddingBottom: theme.spacing.sm }]}>
            {columns.map((column, columnIndex) => (
              <View
                key={column.id}
                testID={`board-page-dot-${columnIndex}`}
                style={[
                  styles.pageDot,
                  { backgroundColor: columnIndex === visiblePageIndex ? theme.colors.accent : theme.colors.border },
                ]}
              />
            ))}
          </Row>
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
}: {
  column: BoardColumnWire;
  board: ProjectBoard | null;
  projectId: string;
  onTaskLongPress: (task: BoardTaskWire) => void;
}): React.JSX.Element {
  const theme = useTheme();
  const tasks = useMemo(() => (board ? selectTasksForColumn(board, column.id) : []), [board, column.id]);

  return (
    <>
      <Row gap="sm" style={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm, alignItems: 'center' }}>
        <Text variant="title" style={styles.flex}>
          {column.name}
        </Text>
        <Badge label={String(tasks.length)} color="secondary" />
      </Row>
      <FlashList<BoardTaskWire>
        testID={`board-column-${column.id}-list`}
        data={tasks}
        keyExtractor={(task) => task.id}
        renderItem={({ item }) => (
          <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
            <TaskCard task={item} projectId={projectId} onLongPress={() => onTaskLongPress(item)} />
          </View>
        )}
      />
    </>
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
  pageDots: {
    justifyContent: 'center',
  },
  pageDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  fabContainer: {
    position: 'absolute',
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  centeredText: {
    textAlign: 'center',
  },
});
