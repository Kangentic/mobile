import React from 'react';
import { cleanup, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { FileDiffScreen } from '@/screens/FileDiffScreen';
import { useDiffStore } from '@/state/diffStore';

jest.mock('expo-router', () => ({
  useLocalSearchParams: () => ({
    taskId: 'task-1',
    projectId: 'project-1',
    path: 'src/alpha.ts',
    scope: 'working',
  }),
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
    seedFileContent();
  });

  afterEach(() => {
    // Unmount before resetting the store so the reset does not re-render a
    // still-mounted subscriber outside act().
    cleanup();
    useDiffStore.getState().reset();
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

  it('shows the loading state when no content is stored yet', () => {
    useDiffStore.getState().reset();

    render(
      <ThemeProvider>
        <FileDiffScreen />
      </ThemeProvider>,
    );

    expect(screen.getByText('Diff loading...')).toBeTruthy();
  });
});
