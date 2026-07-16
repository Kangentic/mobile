import React, { useCallback, useMemo, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import PagerView from 'react-native-pager-view';
import { FlashList } from '@shopify/flash-list';
import type { BoardColumnWire, BoardTaskWire } from '@kangentic/protocol';
import { Badge, Card, ConnectionBanner, IconButton, Row, Screen, Sheet, Stack, Text, useTheme } from '@/components';
import { MoveTaskSheet } from '@/components/board/MoveTaskSheet';
import { CreateTaskSheet } from '@/components/board/CreateTaskSheet';
import { selectColumnsOrdered, selectTasksForColumn, useBoardStore, type ProjectBoard } from '@/state/boardStore';
import { useActivityStore, sectionForEntry } from '@/state/activityStore';
import { StatusDot } from '@/components/StatusDot';
import { CapabilityError } from '@/channel';
import { createTask, moveTaskOptimistic } from '@/connection/actions';

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

  const [moveTarget, setMoveTarget] = useState<BoardTaskWire | null>(null);
  const [moveInFlight, setMoveInFlight] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [createVisible, setCreateVisible] = useState(false);
  const [createInFlight, setCreateInFlight] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

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
        .then(() => setMoveTarget(null))
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
        .then(() => setCreateVisible(false))
        .catch((error: unknown) => {
          setCreateError(error instanceof CapabilityError ? error.message : 'Create failed - check the connection');
        })
        .finally(() => setCreateInFlight(false));
    },
    [projectId],
  );

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
                    setMoveError(null);
                    setMoveTarget(task);
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

      <MoveTaskSheet
        visible={moveTarget !== null}
        task={moveTarget}
        columns={columns}
        onClose={() => setMoveTarget(null)}
        onMove={onMove}
        moveInFlight={moveInFlight}
        errorMessage={moveError}
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
