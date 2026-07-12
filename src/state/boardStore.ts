import { create } from 'zustand';
import { mockBoardColumns, mockBoardTasks } from './mockData';

export interface BoardColumn {
  id: string;
  name: string;
  order: number;
  taskIds: string[];
}

export interface BoardTask {
  id: string;
  title: string;
  columnId: string;
  repository: string;
  sessionId?: string;
  /** ISO 8601. */
  updatedAt: string;
}

interface BoardState {
  columns: BoardColumn[];
  tasksById: Record<string, BoardTask>;
}

export const useBoardStore = create<BoardState>(() => ({
  columns: mockBoardColumns,
  tasksById: Object.fromEntries(mockBoardTasks.map((task) => [task.id, task])),
}));

export function selectColumnsOrdered(): BoardColumn[] {
  return [...useBoardStore.getState().columns].sort((a, b) => a.order - b.order);
}

export function selectTasksForColumn(columnId: string): BoardTask[] {
  const state = useBoardStore.getState();
  const column = state.columns.find((candidate) => candidate.id === columnId);
  if (!column) return [];
  return column.taskIds.map((taskId) => state.tasksById[taskId]).filter((task): task is BoardTask => task !== undefined);
}
