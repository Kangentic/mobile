/**
 * diffStore: file-list application clears path-scoped content, DiffEvents
 * mark staleness, and clearTask releases screen-scoped state.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { useDiffStore } from '@/state/diffStore';
import { diffFileListFixture } from '@/devsupport/desktopFixtures';

describe('diffStore', () => {
  beforeEach(() => {
    useDiffStore.getState().reset();
  });

  it('applyFileList stores the list, clears content, and resets staleness', () => {
    const { applyFileList, applyFileContent, markStale } = useDiffStore.getState();
    applyFileList('task-1', 'working', diffFileListFixture());
    applyFileContent('task-1', 'src/auth/login.ts', { original: 'a', modified: 'b', language: 'typescript' });
    markStale('task-1');

    applyFileList('task-1', 'working', diffFileListFixture());

    const taskDiff = useDiffStore.getState().byTaskId['task-1'];
    expect(taskDiff.stale).toBe(false);
    expect(taskDiff.contentByPath).toEqual({});
    expect(taskDiff.fileList?.files).toHaveLength(2);
  });

  it('applyFileContent is a no-op for an unknown task, and caches by path otherwise', () => {
    const { applyFileList, applyFileContent } = useDiffStore.getState();
    applyFileContent('task-ghost', 'x.ts', { original: '', modified: '', language: 'typescript' });
    expect(useDiffStore.getState().byTaskId['task-ghost']).toBeUndefined();

    applyFileList('task-1', 'branch', diffFileListFixture());
    applyFileContent('task-1', 'src/auth/login.ts', { original: 'old', modified: 'new', language: 'typescript' });
    expect(useDiffStore.getState().byTaskId['task-1'].contentByPath['src/auth/login.ts']).toEqual({
      original: 'old',
      modified: 'new',
      language: 'typescript',
    });
  });

  it('setStatus creates a placeholder entry so a first fetch can show loading', () => {
    useDiffStore.getState().setStatus('task-1', 'working', 'loading');
    const taskDiff = useDiffStore.getState().byTaskId['task-1'];
    expect(taskDiff.fileListStatus).toBe('loading');
    expect(taskDiff.fileList).toBeNull();
    expect(taskDiff.scope).toBe('working');
  });

  it('markStale flags an existing task only', () => {
    useDiffStore.getState().markStale('task-ghost');
    expect(useDiffStore.getState().byTaskId['task-ghost']).toBeUndefined();

    useDiffStore.getState().applyFileList('task-1', 'working', diffFileListFixture());
    useDiffStore.getState().markStale('task-1');
    expect(useDiffStore.getState().byTaskId['task-1'].stale).toBe(true);
  });

  it('clearTask releases the task state', () => {
    useDiffStore.getState().applyFileList('task-1', 'working', diffFileListFixture());
    useDiffStore.getState().clearTask('task-1');
    expect(useDiffStore.getState().byTaskId['task-1']).toBeUndefined();
  });
});
