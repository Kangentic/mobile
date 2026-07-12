import type { AgentSession } from './activityStore';
import type { BoardColumn, BoardTask } from './boardStore';

export const mockAgentSessions: AgentSession[] = [
  {
    id: 'session-1',
    title: 'Fix flaky checkout test',
    repository: 'storefront-web',
    section: 'needs-you',
    statusLabel: 'Waiting on your answer',
    lastUpdatedAt: '2026-07-11T14:32:00.000Z',
    unreadCount: 1,
    pendingPromptSummary: 'Should the retry use exponential backoff?',
  },
  {
    id: 'session-2',
    title: 'Add rate limiting to the auth API',
    repository: 'auth-service',
    section: 'needs-you',
    statusLabel: 'Permission requested',
    lastUpdatedAt: '2026-07-11T13:50:00.000Z',
    unreadCount: 1,
    pendingPromptSummary: 'Run `npm audit fix --force`?',
  },
  {
    id: 'session-3',
    title: 'Migrate billing to Stripe usage records',
    repository: 'billing-service',
    section: 'working',
    statusLabel: 'Writing tests',
    lastUpdatedAt: '2026-07-11T14:10:00.000Z',
    unreadCount: 0,
  },
  {
    id: 'session-4',
    title: 'Refactor the design token pipeline',
    repository: 'design-system',
    section: 'working',
    statusLabel: 'Running the build',
    lastUpdatedAt: '2026-07-11T14:05:00.000Z',
    unreadCount: 0,
  },
  {
    id: 'session-5',
    title: 'Draft the Q3 changelog',
    repository: 'docs-site',
    section: 'idle',
    statusLabel: 'Finished',
    lastUpdatedAt: '2026-07-11T09:20:00.000Z',
    unreadCount: 0,
  },
];

export const mockBoardColumns: BoardColumn[] = [
  { id: 'column-todo', name: 'To Do', order: 0, taskIds: ['task-1', 'task-2'] },
  { id: 'column-doing', name: 'Doing', order: 1, taskIds: ['task-3'] },
  { id: 'column-review', name: 'Review', order: 2, taskIds: ['task-4'] },
  { id: 'column-done', name: 'Done', order: 3, taskIds: ['task-5'] },
];

export const mockBoardTasks: BoardTask[] = [
  {
    id: 'task-1',
    title: 'Add pagination to the activity feed',
    columnId: 'column-todo',
    repository: 'storefront-web',
    updatedAt: '2026-07-10T18:00:00.000Z',
  },
  {
    id: 'task-2',
    title: 'Investigate slow cold starts',
    columnId: 'column-todo',
    repository: 'auth-service',
    updatedAt: '2026-07-10T16:30:00.000Z',
  },
  {
    id: 'task-3',
    title: 'Migrate billing to Stripe usage records',
    columnId: 'column-doing',
    repository: 'billing-service',
    sessionId: 'session-3',
    updatedAt: '2026-07-11T14:10:00.000Z',
  },
  {
    id: 'task-4',
    title: 'Refactor the design token pipeline',
    columnId: 'column-review',
    repository: 'design-system',
    sessionId: 'session-4',
    updatedAt: '2026-07-11T14:05:00.000Z',
  },
  {
    id: 'task-5',
    title: 'Draft the Q3 changelog',
    columnId: 'column-done',
    repository: 'docs-site',
    sessionId: 'session-5',
    updatedAt: '2026-07-11T09:20:00.000Z',
  },
];
