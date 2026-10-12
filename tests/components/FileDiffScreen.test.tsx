import React from 'react';
import { cleanup, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { FileDiffScreen } from '@/screens/FileDiffScreen';
import { useDiffStore } from '@/state/diffStore';

/** Every options object handed to Stack.Screen this render, newest last. */
const mockStackScreenOptions: Record<string, unknown>[] = [];

/** A task's file route, which is what every case uses unless it swaps the params. */
const TASK_ROUTE_PARAMS: Record<string, string | undefined> = {
  taskId: 'task-1',
  projectId: 'project-1',
  path: 'src/alpha.ts',
  scope: 'working',
};
/** The route params the screen reads this render; `beforeEach` puts the task route back. */
let mockSearchParams: Record<string, string | undefined> = TASK_ROUTE_PARAMS;

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => mockSearchParams,
  // The screen sets its native header title (the file name) via Stack.Screen.
  // Recorded rather than discarded: a `() => null` mock throws the options away,
  // so the header was the one part of this screen no test could see.
  Stack: {
    Screen: (props: { options?: Record<string, unknown> }) => {
      if (props.options) mockStackScreenOptions.push(props.options);
      return null;
    },
  },
}));

jest.mock('@/connection/actions', () => ({
  fetchDiffFileContent: jest.fn().mockResolvedValue(undefined),
}));

function seedFileContent(): void {
  useDiffStore.setState({
    byKey: {
      'task-1': {
        scope: 'working',
        fileList: null,
        fileListStatus: 'idle',
        contentByPath: {
          'src/alpha.ts': {
            original: 'const value = 1;\nshared line\n',
            modified: 'const value = 2;\nshared line\n',
            language: 'typescript',
          },
        },
        stale: false,
      },
    },
  });
}

/**
 * The project folder's cached diff for the same path the task route opens,
 * under the key a Command Terminal's Changes stores it at. The text differs
 * from the task's so a render shows which key the screen read.
 */
const PROJECT_FOLDER_DIFF_KEY = 'project:project-1';

function projectFolderDiffState() {
  return {
    scope: 'working' as const,
    fileList: null,
    fileListStatus: 'idle' as const,
    contentByPath: {
      'src/alpha.ts': {
        original: 'const folder = 1;\nshared line\n',
        modified: 'const folder = 2;\nshared line\n',
        language: 'typescript',
      },
    },
    stale: false,
  };
}

describe('FileDiffScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStackScreenOptions.length = 0;
    mockSearchParams = TASK_ROUTE_PARAMS;
    seedFileContent();
  });

  afterEach(async () => {
    // Unmount before resetting the store so the reset does not re-render a
    // still-mounted subscriber outside act().
    await cleanup();
    useDiffStore.getState().reset();
  });

  it('titles the header with the file name and pins no back label', async () => {
    await render(
      <ThemeProvider>
        <FileDiffScreen />
      </ThemeProvider>,
    );

    const options = mockStackScreenOptions.at(-1);
    expect(options?.title).toBe('alpha.ts');
    // Back buttons are chevron-only app-wide (headerBackButtonDisplayMode
    // 'minimal' in app/_layout.tsx). An explicit headerBackTitle is the one
    // combination with a history of defeating that mode upstream, so no
    // screen may reintroduce one - see FileDiffScreen's comment.
    expect(options?.headerBackTitle).toBeUndefined();
  });

  it('renders add and remove lines from the stored file content', async () => {
    await render(
      <ThemeProvider>
        <FileDiffScreen />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('file-diff-lines')).toBeTruthy();
    expect(screen.getByText('const value = 1;')).toBeTruthy();
    expect(screen.getByText('const value = 2;')).toBeTruthy();
    expect(screen.getByText('shared line')).toBeTruthy();
    expect(screen.getByText('@@ -1,2 +1,2 @@')).toBeTruthy();
  });

  it('fetches the file content once on mount with the route params', async () => {
    const { fetchDiffFileContent } = jest.requireMock<{ fetchDiffFileContent: jest.Mock }>('@/connection/actions');

    await render(
      <ThemeProvider>
        <FileDiffScreen />
      </ThemeProvider>,
    );

    expect(fetchDiffFileContent).toHaveBeenCalledTimes(1);
    expect(fetchDiffFileContent).toHaveBeenCalledWith({
      taskId: 'task-1',
      projectId: 'project-1',
      filePath: 'src/alpha.ts',
      scope: 'working',
    });
  });

  it('shows the mono-line skeleton while no content is stored yet', async () => {
    useDiffStore.getState().reset();

    await render(
      <ThemeProvider>
        <FileDiffScreen />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('file-diff-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('file-diff-lines')).toBeNull();
  });

  describe('for a project folder (a Command Terminal\'s Changes)', () => {
    beforeEach(() => {
      mockSearchParams = { target: 'project', projectId: 'project-1', path: 'src/alpha.ts', scope: 'working' };
      useDiffStore.setState({
        byKey: { ...useDiffStore.getState().byKey, [PROJECT_FOLDER_DIFF_KEY]: projectFolderDiffState() },
      });
    });

    it('fetches with a null taskId and renders the diff stored under the project folder key, not the task\'s', async () => {
      const { fetchDiffFileContent } = jest.requireMock<{ fetchDiffFileContent: jest.Mock }>('@/connection/actions');

      await render(
        <ThemeProvider>
          <FileDiffScreen />
        </ThemeProvider>,
      );

      expect(fetchDiffFileContent).toHaveBeenCalledTimes(1);
      expect(fetchDiffFileContent).toHaveBeenCalledWith({
        taskId: null,
        projectId: 'project-1',
        filePath: 'src/alpha.ts',
        scope: 'working',
      });
      expect(screen.getByTestId('file-diff-lines')).toBeTruthy();
      expect(screen.getByText('const folder = 1;')).toBeTruthy();
      expect(screen.getByText('const folder = 2;')).toBeTruthy();
      // The task-1 seed holds the same path with other text: reading that key
      // would show it here.
      expect(screen.queryByText('const value = 2;')).toBeNull();
    });
  });

  /**
   * The guard: a task route that lost its id must FAIL, not read the missing
   * taskId as "the project folder". The project folder's cache is seeded with
   * content for the SAME path, because that cache is exactly what an
   * unguarded read would find and show under a task's name; without the seed
   * this case passes against the bug.
   */
  describe('for a route naming neither a task nor the project target', () => {
    it.each([
      ['no taskId', { projectId: 'project-1', path: 'src/alpha.ts', scope: 'working' }],
      ['an empty taskId', { taskId: '', projectId: 'project-1', path: 'src/alpha.ts', scope: 'working' }],
    ])('fetches nothing and shows the failure note instead of the cached project folder diff (%s)', async (_label, routeParams) => {
      const { fetchDiffFileContent } = jest.requireMock<{ fetchDiffFileContent: jest.Mock }>('@/connection/actions');
      mockSearchParams = routeParams;
      useDiffStore.setState({ byKey: { [PROJECT_FOLDER_DIFF_KEY]: projectFolderDiffState() } });

      await render(
        <ThemeProvider>
          <FileDiffScreen />
        </ThemeProvider>,
      );

      expect(fetchDiffFileContent).not.toHaveBeenCalled();
      expect(screen.getByText('Could not load this diff')).toBeTruthy();
      expect(screen.queryByTestId('file-diff-lines')).toBeNull();
      expect(screen.queryByText('const folder = 2;')).toBeNull();
      expect(screen.queryByTestId('file-diff-skeleton')).toBeNull();
    });
  });
});
