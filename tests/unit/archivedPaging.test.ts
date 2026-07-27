/**
 * boardStore's applyArchivedPage: appending a page de-duplicates by task id
 * (a task archived between two page requests shifts every later row down by
 * one, so the next page legitimately re-sends a row already held), and
 * nextOffset always advances by the full page size the desktop returned,
 * never by the smaller post-dedup appended count - advancing by the deduped
 * count would freeze the cursor on a page that happened to be entirely
 * duplicates, looping paging forever. See the ArchivedTasks.nextOffset and
 * applyArchivedPage comments in src/state/boardStore.ts.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ReadBoardArchivedResponsePayload, SessionSummaryWire } from '@kangentic/protocol';
import { selectArchived, useBoardStore } from '@/state/boardStore';
import { boardTaskFixture } from '@/devsupport/desktopFixtures';

function archivedPage(overrides: Partial<ReadBoardArchivedResponsePayload> = {}): ReadBoardArchivedResponsePayload {
  return {
    projectId: 'project-1',
    archivedTasks: [],
    archivedTotalCount: 0,
    summariesByTaskId: {},
    ...overrides,
  };
}

function summaryFixture(overrides: Partial<SessionSummaryWire> = {}): SessionSummaryWire {
  return {
    sessionId: 'session-1',
    totalCostUsd: 1,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    modelDisplayName: 'Opus 4.8',
    durationMs: 1000,
    toolCallCount: 1,
    compactionCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    filesChanged: 0,
    taskCreatedAt: '2026-07-01T00:00:00.000Z',
    startedAt: '2026-07-01T00:00:00.000Z',
    exitedAt: '2026-07-01T00:05:00.000Z',
    exitCode: 0,
    ...overrides,
  };
}

describe('applyArchivedPage', () => {
  beforeEach(() => {
    useBoardStore.getState().reset();
  });

  it('de-duplicates by task id when a later page re-sends a row already held', () => {
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        archivedTasks: [
          boardTaskFixture({ id: 'task-1', archived_at: '2026-07-20T00:00:00.000Z' }),
          boardTaskFixture({ id: 'task-2', archived_at: '2026-07-19T00:00:00.000Z' }),
        ],
        archivedTotalCount: 3,
      }),
      { append: false },
    );

    // task-2 is re-sent (a task archived between requests shifted it back
    // onto this page); task-3 is genuinely new.
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        archivedTasks: [
          boardTaskFixture({ id: 'task-2', archived_at: '2026-07-19T00:00:00.000Z' }),
          boardTaskFixture({ id: 'task-3', archived_at: '2026-07-18T00:00:00.000Z' }),
        ],
        archivedTotalCount: 3,
      }),
      { append: true },
    );

    const archived = selectArchived(useBoardStore.getState(), 'project-1');
    expect(archived.tasks.map((task) => task.id)).toEqual(['task-1', 'task-2', 'task-3']);
  });

  it('advances nextOffset by the full page size the desktop returned, not the smaller de-duplicated count', () => {
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        archivedTasks: [
          boardTaskFixture({ id: 'task-1', archived_at: '2026-07-20T00:00:00.000Z' }),
          boardTaskFixture({ id: 'task-2', archived_at: '2026-07-19T00:00:00.000Z' }),
        ],
        archivedTotalCount: 4,
      }),
      { append: false },
    );
    expect(selectArchived(useBoardStore.getState(), 'project-1').nextOffset).toBe(2);

    // Only one of the two rows on this page is genuinely new.
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        archivedTasks: [
          boardTaskFixture({ id: 'task-2', archived_at: '2026-07-19T00:00:00.000Z' }),
          boardTaskFixture({ id: 'task-3', archived_at: '2026-07-18T00:00:00.000Z' }),
        ],
        archivedTotalCount: 4,
      }),
      { append: true },
    );
    expect(selectArchived(useBoardStore.getState(), 'project-1').nextOffset).toBe(4);
  });

  it('advances nextOffset by the full page size even when every row on the page is a duplicate (paging must not stall)', () => {
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        archivedTasks: [
          boardTaskFixture({ id: 'task-1', archived_at: '2026-07-20T00:00:00.000Z' }),
          boardTaskFixture({ id: 'task-2', archived_at: '2026-07-19T00:00:00.000Z' }),
        ],
        archivedTotalCount: 5,
      }),
      { append: false },
    );

    // Entirely duplicates: the desktop returned a full page, but every row
    // on it is already held (e.g. a refetch after a transient error).
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        archivedTasks: [
          boardTaskFixture({ id: 'task-1', archived_at: '2026-07-20T00:00:00.000Z' }),
          boardTaskFixture({ id: 'task-2', archived_at: '2026-07-19T00:00:00.000Z' }),
        ],
        archivedTotalCount: 5,
      }),
      { append: true },
    );

    const archived = selectArchived(useBoardStore.getState(), 'project-1');
    // No new rows were appended...
    expect(archived.tasks.map((task) => task.id)).toEqual(['task-1', 'task-2']);
    // ...but the cursor still moved a full page forward, so the next
    // request asks for rows 4-9 rather than re-requesting 0-4 forever.
    expect(archived.nextOffset).toBe(4);
  });

  it('a non-appending refresh (append: false) replaces accumulated pages wholesale rather than merging into them', () => {
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        archivedTasks: [boardTaskFixture({ id: 'task-1', archived_at: '2026-07-20T00:00:00.000Z' })],
        archivedTotalCount: 10,
        summariesByTaskId: { 'task-1': summaryFixture({ sessionId: 'session-1' }) },
      }),
      { append: false },
    );
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        archivedTasks: [boardTaskFixture({ id: 'task-2', archived_at: '2026-07-19T00:00:00.000Z' })],
        archivedTotalCount: 10,
        summariesByTaskId: { 'task-2': summaryFixture({ sessionId: 'session-2' }) },
      }),
      { append: true },
    );
    expect(selectArchived(useBoardStore.getState(), 'project-1').tasks.map((task) => task.id)).toEqual(['task-1', 'task-2']);
    expect(selectArchived(useBoardStore.getState(), 'project-1').nextOffset).toBe(2);

    // A pull-to-refresh: append: false must replace the two pages
    // accumulated above wholesale, not merge into or de-duplicate against
    // them.
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        archivedTasks: [boardTaskFixture({ id: 'task-3', archived_at: '2026-07-21T00:00:00.000Z' })],
        archivedTotalCount: 10,
        summariesByTaskId: { 'task-3': summaryFixture({ sessionId: 'session-3' }) },
      }),
      { append: false },
    );

    const archived = selectArchived(useBoardStore.getState(), 'project-1');
    expect(archived.tasks.map((task) => task.id)).toEqual(['task-3']);
    expect(archived.nextOffset).toBe(1);
    expect(Object.keys(archived.summariesByTaskId)).toEqual(['task-3']);
  });
});
