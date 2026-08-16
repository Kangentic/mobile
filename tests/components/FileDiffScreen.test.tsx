import React from 'react';
import { cleanup, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { FileDiffScreen } from '@/screens/FileDiffScreen';
import { useDiffStore } from '@/state/diffStore';

/** Every options object handed to Stack.Screen this render, newest last. */
const mockStackScreenOptions: Record<string, unknown>[] = [];

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({
    taskId: 'task-1',
    projectId: 'project-1',
    path: 'src/alpha.ts',
    scope: 'working',
  }),
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
    byTaskId: {
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

describe('FileDiffScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockStackScreenOptions.length = 0;
    seedFileContent();
  });

  afterEach(() => {
    // Unmount before resetting the store so the reset does not re-render a
    // still-mounted subscriber outside act().
    cleanup();
    useDiffStore.getState().reset();
  });

  it('titles the header with the file name and pins no back label', () => {
    render(
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

  it('renders add and remove lines from the stored file content', () => {
    render(
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

  it('fetches the file content once on mount with the route params', () => {
    const { fetchDiffFileContent } = jest.requireMock<{ fetchDiffFileContent: jest.Mock }>('@/connection/actions');

    render(
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

  it('shows the mono-line skeleton while no content is stored yet', () => {
    useDiffStore.getState().reset();

    render(
      <ThemeProvider>
        <FileDiffScreen />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('file-diff-skeleton')).toBeTruthy();
    expect(screen.queryByTestId('file-diff-lines')).toBeNull();
  });
});
