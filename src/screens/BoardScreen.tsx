import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useRouter } from 'expo-router';
import PagerView from 'react-native-pager-view';
import { FlashList } from '@shopify/flash-list';
import type { BoardColumnWire, BoardTaskWire } from '@kangentic/protocol';
import { AppHeader, ConnectionBanner, EmptyState, IconButton, Screen, Sheet, Stack, Text, useTheme, type AgentStatusKind } from '@/components';
import { collapseToSnippetText } from '@/conversation/pendingPromptSummary';
import { ColumnChipBar } from '@/components/board/ColumnChipBar';
import { MoveTaskSheet } from '@/components/board/MoveTaskSheet';
import { CreateTaskSheet } from '@/components/board/CreateTaskSheet';
import { EditTaskSheet } from '@/components/board/EditTaskSheet';
import { TaskActionsSheet } from '@/components/board/TaskActionsSheet';
import { TaskCard } from '@/components/board/TaskCard';
import { selectColumnsOrdered, selectTasksForColumn, useBoardStore, type ProjectBoard } from '@/state/boardStore';
import { useActivityStore, sectionForEntry } from '@/state/activityStore';
import { CapabilityError } from '@/channel';
import { archiveTask, createTask, deleteTaskFromBoard, moveTaskOptimistic, refreshSnapshots, updateTaskFields } from '@/connection/actions';
import { triggerHaptic } from '@/lib/haptics';

function messageForActionError(error: unknown, fallback: string): string {
  return error instanceof CapabilityError ? error.message : error instanceof Error ? error.message : fallback;
}

/** One shared empty array so a task-less column does not hand FlashList a new `data` identity per render. */
const NO_TASKS: BoardTaskWire[] = [];

export function BoardScreen(): React.JSX.Element {
  const theme = useTheme();
  const projects = useBoardStore((state) => state.projects);
  const boardsByProjectId = useBoardStore((state) => state.boardsByProjectId);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [projectPickerVisible, setProjectPickerVisible] = useState(false);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const pagerRef = useRef<PagerView>(null);

  const projectId = selectedProjectId ?? projects[0]?.id ?? null;
  const board: ProjectBoard | null = projectId ? (boardsByProjectId[projectId] ?? null) : null;
  const columns = useMemo(() => (board ? selectColumnsOrdered(board) : []), [board]);
  // Derived once per board/column change, not per render: selectTasksForColumn
  // filters + sorts the whole task map, and calling it inline in the render
  // body handed every column's FlashList a brand-new `data` array on every
  // unrelated BoardScreen state change (opening a sheet, pull-to-refresh).
  // The counts read off the same map rather than repeating the derivation.
  const tasksByColumnId = useMemo(() => {
    const byColumnId = new Map<string, BoardTaskWire[]>();
    for (const column of columns) byColumnId.set(column.id, board ? selectTasksForColumn(board, column.id) : []);
    return byColumnId;
  }, [columns, board]);
  const taskCounts = useMemo(
    () => columns.map((column) => tasksByColumnId.get(column.id)?.length ?? 0),
    [columns, tasksByColumnId],
  );
  const projectName = projects.find((project) => project.id === projectId)?.name ?? null;
  const [refreshing, setRefreshing] = useState(false);
  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refreshSnapshots()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, []);

  const activeColumnIndex = Math.max(
    0,
    columns.findIndex((candidate) => candidate.id === activeColumnId),
  );

  // The column set changed under the active id (add/remove/reorder while
  // viewing): follow the same column when it still exists, otherwise fall
  // back to the first column instead of stranding the pager on a stale index.
  // Adjusted synchronously during render (comparing against the previous
  // render's columns) rather than in an effect - React re-renders immediately
  // on a setState called this way, without committing the stale frame first.
  const [prevColumns, setPrevColumns] = useState(columns);
  if (columns !== prevColumns) {
    setPrevColumns(columns);
    if (columns.length > 0 && !columns.some((column) => column.id === activeColumnId)) {
      setActiveColumnId(columns[0]?.id ?? null);
    }
  }

  // Chip tap only sets intent; the sync effect below is the sole setPage
  // caller, so a tap and a swipe converge on the exact same code path.
  const selectColumn = useCallback(
    (columnIndex: number) => {
      const column = columns[columnIndex];
      if (column) setActiveColumnId(column.id);
    },
    [columns],
  );

  // Swipe -> chip sync. Reads the CURRENT columns (not a stale closure) so a
  // swipe lands on the right column even if the set changed underneath.
  const onPageSelected = useCallback(
    (event: { nativeEvent: { position: number } }) => {
      const column = columns[event.nativeEvent.position];
      if (column) setActiveColumnId(column.id);
    },
    [columns],
  );

  // Chip tap -> pager sync (the only setPage call site). The jest mock
  // forwards the ref to a plain View with no imperative API; on-device it
  // always has one. After a real swipe this is a no-op (the pager already
  // shows activeColumnIndex).
  useEffect(() => {
    const pager = pagerRef.current;
    if (pager && typeof pager.setPage === 'function') pager.setPage(activeColumnIndex);
  }, [activeColumnIndex]);

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

  // Stable identity: an inline arrow here would be a fresh prop on every
  // BoardScreen render, which defeats BoardTaskCard's React.memo for every
  // visible card in every column.
  const onLongPressTask = useCallback((task: BoardTaskWire) => {
    setActionsError(null);
    setActionsTarget(task);
  }, []);

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
          <PagerView
            ref={pagerRef}
            key={projectId}
            testID="board-list"
            style={styles.flex}
            initialPage={activeColumnIndex}
            offscreenPageLimit={1}
            onPageSelected={onPageSelected}
          >
            {columns.map((column) => (
              <View key={column.id} testID={`board-column-${column.id}`} style={styles.flex}>
                <ColumnPage
                  column={column}
                  tasks={tasksByColumnId.get(column.id) ?? NO_TASKS}
                  projectId={projectId ?? ''}
                  refreshing={refreshing}
                  onRefresh={onRefresh}
                  onLongPressTask={onLongPressTask}
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
        defaultColumnName={columns[0]?.name ?? null}
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

/**
 * One board page: a column's tasks, or a styled empty state when it has
 * none. Pull-to-refresh works on both branches - the FlashList and the
 * empty-state ScrollView call the same global refreshSnapshots(), so an
 * empty column is not a dead end for the gesture.
 */
function ColumnPage({
  column,
  tasks,
  projectId,
  refreshing,
  onRefresh,
  onLongPressTask,
}: {
  column: BoardColumnWire;
  tasks: BoardTaskWire[];
  projectId: string;
  refreshing: boolean;
  onRefresh: () => void;
  onLongPressTask: (task: BoardTaskWire) => void;
}): React.JSX.Element {
  const theme = useTheme();
  // Stable across renders so FlashList's row components keep their memo:
  // an inline renderItem rebuilds every row's props on every parent render.
  const renderTask = useCallback(
    ({ item }: { item: BoardTaskWire }) => (
      <View style={{ paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm }}>
        <BoardTaskCard task={item} projectId={projectId} onLongPressTask={onLongPressTask} />
      </View>
    ),
    [theme.spacing.md, theme.spacing.sm, projectId, onLongPressTask],
  );
  const refreshControl = (
    // tintColor styles iOS; colors + progressBackgroundColor style Android
    // (stock is a white circle, jarring on the warm theme).
    <RefreshControl
      refreshing={refreshing}
      onRefresh={onRefresh}
      tintColor={theme.colors.textSecondary}
      colors={[theme.colors.accent]}
      progressBackgroundColor={theme.colors.surfaceOverlay}
    />
  );

  if (tasks.length === 0) {
    return (
      <ScrollView contentContainerStyle={styles.flex} refreshControl={refreshControl}>
        <EmptyState
          testID={`board-column-${column.id}-empty`}
          title="No tasks"
          overseerSize={54}
          overseerAnimate="blink-loop"
        />
      </ScrollView>
    );
  }

  return (
    <FlashList<BoardTaskWire>
      testID={`board-column-${column.id}-list`}
      data={tasks}
      keyExtractor={(task) => task.id}
      getItemType={() => 'task'}
      refreshControl={refreshControl}
      contentContainerStyle={{ paddingTop: theme.spacing.sm, paddingBottom: theme.spacing.xxl }}
      renderItem={renderTask}
    />
  );
}

const CARD_DESCRIPTION_LINES = 2;

/**
 * The board's per-item connector: reads the session's activity/usage and
 * the project's ticket-number setting, then hands off to the shared
 * TaskCard (@/components/board/TaskCard) - the exact same card the Agents
 * feed renders, minus its extra project row (the board already establishes
 * project context by which board you're viewing).
 */
const BoardTaskCard = React.memo(function BoardTaskCard({
  task,
  projectId,
  onLongPressTask,
}: {
  task: BoardTaskWire;
  projectId: string;
  onLongPressTask: (task: BoardTaskWire) => void;
}): React.JSX.Element {
  const router = useRouter();
  // Built here rather than per-row in renderItem: the parent hands down one
  // stable callback, so this card's props stay identical between renders.
  const onLongPress = useCallback(() => onLongPressTask(task), [onLongPressTask, task]);
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
  const descriptionPreview = task.description.length > 0 ? collapseToSnippetText(task.description) : '';

  return (
    <TaskCard
      testID={`board-card-${task.id}`}
      task={task}
      statusKind={statusKind}
      showTicketNumbers={showTicketNumbers}
      usage={activityEntry?.usage ?? null}
      bodyText={descriptionPreview}
      bodyNumberOfLines={CARD_DESCRIPTION_LINES}
      onPress={openTask}
      onLongPress={onLongPress}
    />
  );
});

const styles = StyleSheet.create({
  flex: {
    flex: 1,
  },
  fabContainer: {
    position: 'absolute',
  },
});
