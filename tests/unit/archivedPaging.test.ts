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
import { ARCHIVED_PROJECT_CAP, selectArchived, useBoardStore } from '@/state/boardStore';
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

/**
 * Archived rows carry each task's FULL description, which is the largest thing
 * on this wire: measured against the real boards this app is built on they
 * average ~7 KB with a 45 KB maximum, and one project holds 580 archived tasks
 * totalling 2.3 MB of description text, roughly doubled once Hermes holds it as
 * UTF-16. Every archive opened used to stay for the life of the process, so
 * browsing a few Done columns could hold more than the entire cold-start saving
 * the MOBILE-8 bound buys, and never give it back.
 */
describe('archived pages are bounded by project', () => {
  beforeEach(() => {
    useBoardStore.getState().reset();
  });

  function loadArchiveFor(projectId: string): void {
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        projectId,
        archivedTasks: [boardTaskFixture({ id: `${projectId}-task`, archived_at: '2026-07-20T00:00:00.000Z' })],
        archivedTotalCount: 1,
      }),
      { append: false },
    );
  }

  it('holds at most ARCHIVED_PROJECT_CAP projects, evicting least recently loaded', () => {
    loadArchiveFor('project-a');
    loadArchiveFor('project-b');
    loadArchiveFor('project-c');

    const held = Object.keys(useBoardStore.getState().archivedByProjectId).sort();
    expect(held).toEqual(['project-b', 'project-c']);
    expect(held.length).toBe(ARCHIVED_PROJECT_CAP);
  });

  it('re-loading a held project refreshes its recency rather than evicting it', () => {
    loadArchiveFor('project-a');
    loadArchiveFor('project-b');
    // Back to A, which must now outrank B.
    loadArchiveFor('project-a');
    loadArchiveFor('project-c');

    expect(Object.keys(useBoardStore.getState().archivedByProjectId).sort()).toEqual(['project-a', 'project-c']);
  });

  /**
   * The eviction direction is the trap. Pages arrive newest-archived first and
   * the user scrolls DOWNWARD, so dropping the oldest-loaded PAGE would remove
   * the top of the list they are still looking at. Only a whole project they
   * have navigated away from is safe to drop, which is why paging deeper inside
   * one project must never evict anything.
   */
  it('paging deeper within one project evicts nothing', () => {
    loadArchiveFor('project-a');
    for (let page = 0; page < 5; page += 1) {
      useBoardStore.getState().applyArchivedPage(
        archivedPage({
          projectId: 'project-a',
          archivedTasks: [boardTaskFixture({ id: `page-${page}`, archived_at: '2026-07-19T00:00:00.000Z' })],
          archivedTotalCount: 10,
        }),
        { append: true },
      );
    }

    expect(selectArchived({ archivedByProjectId: useBoardStore.getState().archivedByProjectId }, 'project-a').tasks)
      .toHaveLength(6);
  });

  /**
   * With no `selectedProjectId` set (the shape `reset()` leaves), the
   * on-screen project is null, so `shedArchivedPages` falls back to the
   * `archivedProjectOrder` tail - the most recently loaded project. This
   * case exercises that FALLBACK branch; the on-screen branch itself is
   * covered separately below.
   */
  it('sheds every archive but the most recent under memory pressure, falling back to the most recently loaded project when none is on screen', () => {
    loadArchiveFor('project-a');
    loadArchiveFor('project-b');

    useBoardStore.getState().shedArchivedPages();

    expect(Object.keys(useBoardStore.getState().archivedByProjectId)).toEqual(['project-b']);
  });

  /**
   * The primary branch: the project the user is LOOKING AT survives even
   * when a different one was loaded more recently. The two diverge whenever
   * a board is returned to without a refetch - BoardScreen's focus effect
   * deliberately skips reloading page one once the user has paged deeper -
   * and dropping the on-screen archive would blank an open Done column
   * until the next focus.
   */
  it('keeps the on-screen project even when a different project was loaded more recently', () => {
    useBoardStore.getState().selectProject('project-a');
    loadArchiveFor('project-a');
    loadArchiveFor('project-b');

    useBoardStore.getState().shedArchivedPages();

    expect(Object.keys(useBoardStore.getState().archivedByProjectId)).toEqual(['project-a']);
  });

  /**
   * A project whose page fetch is still IN FLIGHT survives too, even when it
   * is neither on screen nor the most recently loaded. Such a record costs
   * nothing (no tasks yet), and wiping it would reset `loading` to false
   * underneath two separate in-flight guards, making a live fetch read as
   * finished-and-empty and firing a duplicate request.
   */
  it('keeps a project whose archive fetch is still in flight, even when it is neither on screen nor the most recent', () => {
    useBoardStore.getState().selectProject('project-c');
    loadArchiveFor('project-c');
    loadArchiveFor('project-a');
    useBoardStore.getState().setArchivedLoading('project-b', true);

    useBoardStore.getState().shedArchivedPages();

    const survivors = Object.keys(useBoardStore.getState().archivedByProjectId).sort();
    expect(survivors).toEqual(['project-b', 'project-c']);
    expect(useBoardStore.getState().archivedByProjectId['project-b'].loading).toBe(true);
  });

  it('is idempotent: shedding again after the first pass changes nothing further', () => {
    loadArchiveFor('project-a');
    loadArchiveFor('project-b');
    useBoardStore.getState().shedArchivedPages();
    const afterFirstShed = useBoardStore.getState();

    useBoardStore.getState().shedArchivedPages();
    const afterSecondShed = useBoardStore.getState();

    // Reference-stable, not merely equal in content: the no-drop path
    // returns the SAME state object rather than a freshly constructed one.
    expect(afterSecondShed.archivedByProjectId).toBe(afterFirstShed.archivedByProjectId);
    expect(afterSecondShed.archivedProjectOrder).toBe(afterFirstShed.archivedProjectOrder);
  });
});

describe('setArchivedLoading keeps archivedProjectOrder in step with archivedByProjectId', () => {
  beforeEach(() => {
    useBoardStore.getState().reset();
  });

  /**
   * Before this, setArchivedLoading wrote archivedByProjectId alone, so the
   * two structures disagreed for the whole duration of a first-time fetch:
   * the project was held but unordered, invisible to applyArchivedPage's
   * eviction and impossible for shedArchivedPages to elect as the kept one.
   */
  it('adds the project to archivedProjectOrder', () => {
    useBoardStore.getState().setArchivedLoading('project-a', true);

    expect(useBoardStore.getState().archivedProjectOrder).toEqual(['project-a']);
    expect(useBoardStore.getState().archivedByProjectId['project-a'].loading).toBe(true);
  });

  it('moves an already-held project to most-recent in archivedProjectOrder', () => {
    useBoardStore.getState().setArchivedLoading('project-a', true);
    useBoardStore.getState().setArchivedLoading('project-b', true);
    useBoardStore.getState().setArchivedLoading('project-a', false);

    expect(useBoardStore.getState().archivedProjectOrder).toEqual(['project-b', 'project-a']);
  });
});

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

describe('reset', () => {
  beforeEach(() => {
    useBoardStore.getState().reset();
  });

  it('clears archivedProjectOrder along with the archives themselves', () => {
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        projectId: 'project-a',
        archivedTasks: [boardTaskFixture({ id: 'project-a-task', archived_at: '2026-07-20T00:00:00.000Z' })],
        archivedTotalCount: 1,
      }),
      { append: false },
    );
    useBoardStore.getState().applyArchivedPage(
      archivedPage({
        projectId: 'project-b',
        archivedTasks: [boardTaskFixture({ id: 'project-b-task', archived_at: '2026-07-20T00:00:00.000Z' })],
        archivedTotalCount: 1,
      }),
      { append: false },
    );
    expect(useBoardStore.getState().archivedProjectOrder).toEqual(['project-a', 'project-b']);

    useBoardStore.getState().reset();

    expect(useBoardStore.getState().archivedProjectOrder).toEqual([]);
    expect(useBoardStore.getState().archivedByProjectId).toEqual({});
  });
});
