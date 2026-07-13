import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { ChangesTab } from '@/screens/task/ChangesTab';
import { useDiffStore } from '@/state/diffStore';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

jest.mock('@/connection/actions', () => ({
  setDiffWatch: jest.fn(),
}));

function seedFileList(): void {
  useDiffStore.setState({
    byTaskId: {
      'task-1': {
        scope: 'working',
        fileList: {
          files: [
            { path: 'src/screens/Alpha.tsx', status: 'M', insertions: 12, deletions: 4, binary: false },
            { path: 'assets/logo.png', status: 'A', insertions: 0, deletions: 0, binary: true },
          ],
          totalInsertions: 12,
          totalDeletions: 4,
        },
        fileListStatus: 'idle',
        contentByPath: {},
        stale: false,
      },
    },
  });
}

function renderChangesTab(isActive: boolean): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ChangesTab taskId="task-1" projectId="project-1" isActive={isActive} />
    </ThemeProvider>,
  );
}

describe('ChangesTab', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seedFileList();
  });

  afterEach(() => {
    // Unmount before resetting the store so the reset does not re-render a
    // still-mounted subscriber outside act().
    cleanup();
    useDiffStore.getState().reset();
  });

  it('renders file rows with status badges and insertion/deletion counts', () => {
    renderChangesTab(true);

    expect(screen.getByTestId('changes-file-list')).toBeTruthy();
    expect(screen.getByTestId('changes-file-0')).toBeTruthy();
    // The path renders as a dim directory span nested inside the basename
    // text, so the composed node text is the full path.
    expect(screen.getByText('src/screens/Alpha.tsx')).toBeTruthy();
    expect(screen.getByText('src/screens/')).toBeTruthy();
    expect(screen.getByText('+12')).toBeTruthy();
    expect(screen.getByText('-4')).toBeTruthy();
    expect(screen.getByText('M')).toBeTruthy();
    // The binary file shows a 'binary' badge instead of counts.
    expect(screen.getByTestId('changes-file-1-binary')).toBeTruthy();
  });

  it('pushes the file-diff route when a text file row is tapped', () => {
    renderChangesTab(true);

    fireEvent.press(screen.getByTestId('changes-file-0'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/file-diff',
      params: { taskId: 'task-1', projectId: 'project-1', path: 'src/screens/Alpha.tsx', scope: 'working' },
    });
  });

  it('does not navigate when a binary file row is tapped', () => {
    renderChangesTab(true);

    fireEvent.press(screen.getByTestId('changes-file-1'));
    expect(mockPush).not.toHaveBeenCalled();
  });

  it('sets the diff watch while active and clears it when inactive', () => {
    const { setDiffWatch } = jest.requireMock<{ setDiffWatch: jest.Mock }>('@/connection/actions');

    const view = renderChangesTab(true);
    expect(setDiffWatch).toHaveBeenCalledWith('task-1', { projectId: 'project-1', scope: 'working' });

    view.rerender(
      <ThemeProvider>
        <ChangesTab taskId="task-1" projectId="project-1" isActive={false} />
      </ThemeProvider>,
    );
    expect(setDiffWatch).toHaveBeenLastCalledWith('task-1', null);
  });

  it('re-subscribes the watch when the scope changes', () => {
    const { setDiffWatch } = jest.requireMock<{ setDiffWatch: jest.Mock }>('@/connection/actions');

    renderChangesTab(true);
    setDiffWatch.mockClear();

    fireEvent.press(screen.getByTestId('changes-scope-staged'));
    expect(setDiffWatch).toHaveBeenNthCalledWith(1, 'task-1', null);
    expect(setDiffWatch).toHaveBeenNthCalledWith(2, 'task-1', { projectId: 'project-1', scope: 'staged' });
  });

  it('shows the refreshing caption when the list is stale', () => {
    useDiffStore.getState().markStale('task-1');
    renderChangesTab(true);
    expect(screen.getByTestId('changes-refreshing')).toBeTruthy();
  });
});
