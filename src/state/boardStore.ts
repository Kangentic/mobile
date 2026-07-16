import { create } from 'zustand';
import type {
  BacklogItemWire,
  BoardColumnWire,
  BoardTaskWire,
  ReadBoardProjectSummary,
  ReadBoardSnapshotResponsePayload,
} from '@kangentic/protocol';

export interface ProjectBoard {
  columns: BoardColumnWire[];
  tasksById: Record<string, BoardTaskWire>;
  backlog: BacklogItemWire[];
  /** Epoch ms when this snapshot was applied. */
  snapshotAt: number;
}

export interface PendingMove {
  moveId: string;
  projectId: string;
  taskId: string;
  fromSwimlaneId: string;
  fromPosition: number;
  toSwimlaneId: string;
  toPosition: number;
}

interface BoardStoreState {
  projects: ReadBoardProjectSummary[];
  boardsByProjectId: Record<string, ProjectBoard>;
  pendingMoves: PendingMove[];
  applyProjectList: (projects: ReadBoardProjectSummary[]) => void;
  applyBoardSnapshot: (snapshot: ReadBoardSnapshotResponsePayload) => void;
  applyOptimisticMove: (move: { projectId: string; taskId: string; toSwimlaneId: string; toPosition: number }) => string | null;
  commitMove: (moveId: string) => void;
  rollbackMove: (moveId: string) => void;
  reset: () => void;
}

let nextMoveSequence = 0;

function moveTaskInBoard(board: ProjectBoard, taskId: string, toSwimlaneId: string, toPosition: number): ProjectBoard {
  const task = board.tasksById[taskId];
  if (!task) return board;
  const movedTask: BoardTaskWire = { ...task, swimlane_id: toSwimlaneId, position: toPosition };
  const tasksById: Record<string, BoardTaskWire> = { ...board.tasksById, [taskId]: movedTask };
  // Shift positions in the target column so the moved task slots in without
  // duplicate positions; the authoritative ordering arrives with the next
  // snapshot refresh, this only has to look right until then.
  for (const otherTask of Object.values(board.tasksById)) {
    if (otherTask.id === taskId) continue;
    if (otherTask.swimlane_id === toSwimlaneId && otherTask.position >= toPosition) {
      tasksById[otherTask.id] = { ...otherTask, position: otherTask.position + 1 };
    }
  }
  return { ...board, tasksById };
}

export const useBoardStore = create<BoardStoreState>((set, get) => ({
  projects: [],
  boardsByProjectId: {},
  pendingMoves: [],

  applyProjectList: (projects) => set({ projects }),

  applyBoardSnapshot: (snapshot) =>
    set((state) => {
      let board: ProjectBoard = {
        columns: snapshot.columns,
        tasksById: Object.fromEntries(snapshot.tasks.map((task) => [task.id, task])),
        backlog: snapshot.backlog,
        snapshotAt: Date.now(),
      };
      // Re-apply in-flight optimistic moves on top, so a snapshot racing a
      // move does not visibly bounce the card back before the move commits.
      for (const pendingMove of state.pendingMoves) {
        if (pendingMove.projectId === snapshot.projectId) {
          board = moveTaskInBoard(board, pendingMove.taskId, pendingMove.toSwimlaneId, pendingMove.toPosition);
        }
      }
      return { boardsByProjectId: { ...state.boardsByProjectId, [snapshot.projectId]: board } };
    }),

  applyOptimisticMove: (move) => {
    const state = get();
    const board = state.boardsByProjectId[move.projectId];
    const task = board?.tasksById[move.taskId];
    if (!board || !task) return null;
    nextMoveSequence += 1;
    const pendingMove: PendingMove = {
      moveId: `move-${nextMoveSequence}`,
      projectId: move.projectId,
      taskId: move.taskId,
      fromSwimlaneId: task.swimlane_id,
      fromPosition: task.position,
      toSwimlaneId: move.toSwimlaneId,
      toPosition: move.toPosition,
    };
    set({
      pendingMoves: [...state.pendingMoves, pendingMove],
      boardsByProjectId: {
        ...state.boardsByProjectId,
        [move.projectId]: moveTaskInBoard(board, move.taskId, move.toSwimlaneId, move.toPosition),
      },
    });
    return pendingMove.moveId;
  },

  commitMove: (moveId) =>
    set((state) => ({ pendingMoves: state.pendingMoves.filter((pendingMove) => pendingMove.moveId !== moveId) })),

  rollbackMove: (moveId) =>
    set((state) => {
      const pendingMove = state.pendingMoves.find((candidate) => candidate.moveId === moveId);
      if (!pendingMove) return state;
      const board = state.boardsByProjectId[pendingMove.projectId];
      const restoredBoard = board
        ? moveTaskInBoard(board, pendingMove.taskId, pendingMove.fromSwimlaneId, pendingMove.fromPosition)
        : board;
      return {
        pendingMoves: state.pendingMoves.filter((candidate) => candidate.moveId !== moveId),
        ...(restoredBoard ? { boardsByProjectId: { ...state.boardsByProjectId, [pendingMove.projectId]: restoredBoard } } : {}),
      };
    }),

  reset: () => set({ projects: [], boardsByProjectId: {}, pendingMoves: [] }),
}));

/** Visible columns in board order (archived and ghost columns are desktop-internal). */
export function selectColumnsOrdered(board: ProjectBoard): BoardColumnWire[] {
  return board.columns
    .filter((column) => !column.is_archived && !column.is_ghost)
    .sort((first, second) => first.position - second.position);
}

/** Non-archived tasks of one column, by position. */
export function selectTasksForColumn(board: ProjectBoard, swimlaneId: string): BoardTaskWire[] {
  return Object.values(board.tasksById)
    .filter((task) => task.swimlane_id === swimlaneId && task.archived_at === null)
    .sort((first, second) => first.position - second.position);
}

/** The union of live session ids across every cached board - the bootstrap's stream desired-set source. */
export function selectLiveSessionIds(state: { boardsByProjectId: Record<string, ProjectBoard> }): Set<string> {
  const liveSessionIds = new Set<string>();
  for (const board of Object.values(state.boardsByProjectId)) {
    for (const task of Object.values(board.tasksById)) {
      if (task.session_id !== null && task.archived_at === null) liveSessionIds.add(task.session_id);
    }
  }
  return liveSessionIds;
}

/**
 * The project's desktop-provided accent color, or null when absent or not a
 * string. The protocol's ReadBoardProjectSummary does not carry a color field
 * yet (it ships as an additive `color`/`projectColor` field in a later
 * protocol release), so this narrows defensively with `in` + typeof checks:
 * it compiles and passes through cleanly against desktops that never send it.
 * Hex validation is NOT done here; the theme layer's projectAccent guardrails
 * own rejecting unusable values.
 */
export function selectProjectAccentColor(
  state: { projects: ReadBoardProjectSummary[] },
  projectId: string,
): string | null {
  const project = state.projects.find((candidate) => candidate.id === projectId);
  if (!project) return null;
  if ('color' in project && typeof project.color === 'string' && project.color.length > 0) {
    return project.color;
  }
  if ('projectColor' in project && typeof project.projectColor === 'string' && project.projectColor.length > 0) {
    return project.projectColor;
  }
  return null;
}

/** Locates a task (and its project) by id across cached boards - the task screen's param fallback. */
export function findTaskById(
  state: { boardsByProjectId: Record<string, ProjectBoard> },
  taskId: string,
): { task: BoardTaskWire; projectId: string } | null {
  for (const [projectId, board] of Object.entries(state.boardsByProjectId)) {
    const task = board.tasksById[taskId];
    if (task) return { task, projectId };
  }
  return null;
}
