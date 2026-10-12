/**
 * The diff watch and the per-file content fetch (protocol 0.20.0), against the
 * REAL `setDiffWatch` and `fetchDiffFileContent` in `@/connection/actions`.
 * Every other test mocks these two, so none of them can see what they hand the
 * subscription manager, the verb client or the diff store.
 *
 * A diff target is a task's worktree (`taskId` set) or a project folder
 * (`taskId: null`, a Command Terminal's Changes). The store key is the task id
 * for a task and `project:<projectId>` for a folder; the desired watch and the
 * verb input keep the explicit `{ taskId, projectId }` pair and never the key,
 * because a made-up task id would be refused by the desktop as unknown.
 *
 * connectionManager is mocked the way commandTerminalActions.test.ts does it,
 * including the `NotConnectedError` the actions module imports.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DiffFileContentWire } from '@kangentic/protocol';
import { fetchDiffFileContent, setDiffWatch } from '@/connection/actions';
import { diffKeyFor, useDiffStore } from '@/state/diffStore';

const mocks = vi.hoisted(() => {
  class NotConnectedError extends Error {
    constructor() {
      super('Not connected to the desktop');
      this.name = 'NotConnectedError';
    }
  }
  return {
    NotConnectedError,
    setDesiredDiff: vi.fn(),
    readDiffFileContent: vi.fn(),
    requireVerbClient: vi.fn(),
    getActiveConnection: vi.fn(),
    requireSubscriptions: vi.fn(),
    reconcileSessionsFromBoards: vi.fn(),
  };
});

vi.mock('@/connection/connectionManager', () => ({
  NotConnectedError: mocks.NotConnectedError,
  getActiveConnection: mocks.getActiveConnection,
  reconnectNow: vi.fn(),
  requireSubscriptions: mocks.requireSubscriptions,
  requireVerbClient: mocks.requireVerbClient,
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
vi.mock('@/connection/storeFeed', () => ({ reconcileSessionsFromBoards: mocks.reconcileSessionsFromBoards }));
// @/connection/actions also imports settingsStore, which persists via
// expo-secure-store - fake it so the vitest (node) run has no native module.
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

const PROJECT_ID = 'p';
const TASK_ID = 't';
const PROJECT_FOLDER_KEY = 'project:p';
const FILE_PATH = 'src/alpha.ts';

const CONTENT: DiffFileContentWire = {
  original: 'const value = 1;\n',
  modified: 'const value = 2;\n',
  language: 'typescript',
};

function diffByKey(diffKey: string) {
  return useDiffStore.getState().byKey[diffKey];
}

beforeEach(() => {
  mocks.setDesiredDiff.mockReset();
  mocks.readDiffFileContent.mockReset();
  mocks.readDiffFileContent.mockResolvedValue(CONTENT);
  mocks.requireVerbClient.mockReset();
  mocks.requireVerbClient.mockReturnValue({ readDiffFileContent: mocks.readDiffFileContent });
  mocks.getActiveConnection.mockReset();
  mocks.getActiveConnection.mockReturnValue({ subscriptions: { setDesiredDiff: mocks.setDesiredDiff } });
  useDiffStore.getState().reset();
});

describe('diffKeyFor', () => {
  it('keys a task as its bare id and a project folder under a prefixed key', () => {
    expect(diffKeyFor({ taskId: TASK_ID, projectId: PROJECT_ID })).toBe(TASK_ID);
    expect(diffKeyFor({ taskId: null, projectId: PROJECT_ID })).toBe(PROJECT_FOLDER_KEY);
  });
});

describe('setDiffWatch', () => {
  it('watches a project folder under its prefixed key, with the explicit pair and no made-up task id, and marks it loading', () => {
    setDiffWatch({ taskId: null, projectId: PROJECT_ID }, 'branch');

    expect(mocks.setDesiredDiff).toHaveBeenCalledTimes(1);
    expect(mocks.setDesiredDiff).toHaveBeenCalledWith(PROJECT_FOLDER_KEY, { taskId: null, projectId: PROJECT_ID, scope: 'branch' });
    expect(diffByKey(PROJECT_FOLDER_KEY)).toMatchObject({ scope: 'branch', fileList: null, fileListStatus: 'loading' });
    // Nothing is stored under a task-shaped key for a folder.
    expect(Object.keys(useDiffStore.getState().byKey)).toEqual([PROJECT_FOLDER_KEY]);
  });

  it('watches a task under its bare task id, carrying its own taskId, and touches no project folder key', () => {
    setDiffWatch({ taskId: TASK_ID, projectId: PROJECT_ID }, 'working');

    expect(mocks.setDesiredDiff).toHaveBeenCalledTimes(1);
    expect(mocks.setDesiredDiff).toHaveBeenCalledWith(TASK_ID, { taskId: TASK_ID, projectId: PROJECT_ID, scope: 'working' });
    expect(diffByKey(TASK_ID)).toMatchObject({ scope: 'working', fileListStatus: 'loading' });
    expect(diffByKey(PROJECT_FOLDER_KEY)).toBeUndefined();
  });

  it('drops the project folder watch and clears only that key when passed a null scope', () => {
    setDiffWatch({ taskId: null, projectId: PROJECT_ID }, 'branch');
    setDiffWatch({ taskId: TASK_ID, projectId: PROJECT_ID }, 'working');
    // The clear below is only meaningful against a key that exists.
    expect(diffByKey(PROJECT_FOLDER_KEY)).toBeDefined();
    mocks.setDesiredDiff.mockClear();

    setDiffWatch({ taskId: null, projectId: PROJECT_ID }, null);

    expect(mocks.setDesiredDiff).toHaveBeenCalledTimes(1);
    expect(mocks.setDesiredDiff).toHaveBeenCalledWith(PROJECT_FOLDER_KEY, null);
    expect(diffByKey(PROJECT_FOLDER_KEY)).toBeUndefined();
    expect(diffByKey(TASK_ID)).toBeDefined();
  });

  it('drops a task watch under the bare task id when passed a null scope', () => {
    setDiffWatch({ taskId: TASK_ID, projectId: PROJECT_ID }, 'staged');
    expect(diffByKey(TASK_ID)).toBeDefined();
    mocks.setDesiredDiff.mockClear();

    setDiffWatch({ taskId: TASK_ID, projectId: PROJECT_ID }, null);

    expect(mocks.setDesiredDiff).toHaveBeenCalledWith(TASK_ID, null);
    expect(diffByKey(TASK_ID)).toBeUndefined();
  });

  it('does nothing when no connection is active', () => {
    mocks.getActiveConnection.mockReturnValue(null);

    setDiffWatch({ taskId: null, projectId: PROJECT_ID }, 'working');

    expect(mocks.setDesiredDiff).not.toHaveBeenCalled();
    expect(useDiffStore.getState().byKey).toEqual({});
  });
});

describe('fetchDiffFileContent', () => {
  it('asks the verb for a project folder with a null taskId and stores the content under the prefixed key', async () => {
    // applyFileContent only lands on a key that already exists, which is the
    // state the watch leaves behind; the requested path is deliberately absent.
    setDiffWatch({ taskId: null, projectId: PROJECT_ID }, 'staged');
    expect(diffByKey(PROJECT_FOLDER_KEY)?.contentByPath).toEqual({});

    await fetchDiffFileContent({ taskId: null, projectId: PROJECT_ID, filePath: FILE_PATH, scope: 'staged' });

    expect(mocks.readDiffFileContent).toHaveBeenCalledTimes(1);
    expect(mocks.readDiffFileContent).toHaveBeenCalledWith({ taskId: null, projectId: PROJECT_ID, filePath: FILE_PATH, scope: 'staged' });
    expect(diffByKey(PROJECT_FOLDER_KEY)?.contentByPath[FILE_PATH]).toEqual(CONTENT);
    expect(diffByKey(TASK_ID)).toBeUndefined();
  });

  it('stores a task\'s content under its bare task id and leaves a project folder key alone', async () => {
    setDiffWatch({ taskId: TASK_ID, projectId: PROJECT_ID }, 'working');
    setDiffWatch({ taskId: null, projectId: PROJECT_ID }, 'working');

    await fetchDiffFileContent({ taskId: TASK_ID, projectId: PROJECT_ID, filePath: FILE_PATH, scope: 'working' });

    expect(mocks.readDiffFileContent).toHaveBeenCalledWith({ taskId: TASK_ID, projectId: PROJECT_ID, filePath: FILE_PATH, scope: 'working' });
    expect(diffByKey(TASK_ID)?.contentByPath[FILE_PATH]).toEqual(CONTENT);
    expect(diffByKey(PROJECT_FOLDER_KEY)?.contentByPath).toEqual({});
  });

  it('serves a repeat fetch from the cache, and does not take another key\'s cached copy of the same path as its own', async () => {
    setDiffWatch({ taskId: TASK_ID, projectId: PROJECT_ID }, 'working');
    setDiffWatch({ taskId: null, projectId: PROJECT_ID }, 'working');
    await fetchDiffFileContent({ taskId: TASK_ID, projectId: PROJECT_ID, filePath: FILE_PATH, scope: 'working' });
    expect(mocks.readDiffFileContent).toHaveBeenCalledTimes(1);

    await fetchDiffFileContent({ taskId: TASK_ID, projectId: PROJECT_ID, filePath: FILE_PATH, scope: 'working' });
    expect(mocks.readDiffFileContent).toHaveBeenCalledTimes(1);

    // The task's cache must not satisfy the project folder's fetch of that path.
    await fetchDiffFileContent({ taskId: null, projectId: PROJECT_ID, filePath: FILE_PATH, scope: 'working' });
    expect(mocks.readDiffFileContent).toHaveBeenCalledTimes(2);
    expect(diffByKey(PROJECT_FOLDER_KEY)?.contentByPath[FILE_PATH]).toEqual(CONTENT);
  });
});
