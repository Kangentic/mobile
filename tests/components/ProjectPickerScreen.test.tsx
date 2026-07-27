import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { ProjectPickerScreen } from '@/screens/ProjectPickerScreen';
import { useBoardStore } from '@/state/boardStore';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockBack = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: mockBack, push: jest.fn() }),
}));

function renderProjectPicker(): ReturnType<typeof render> {
  return render(
    <ThemeProvider>
      <ProjectPickerScreen />
    </ThemeProvider>,
  );
}

describe('ProjectPickerScreen', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    useBoardStore.getState().reset();
    useBoardStore.setState({
      projects: [
        { id: 'project-1', name: 'Alpha' },
        { id: 'project-2', name: 'Beta' },
      ],
    });
  });

  /** With nothing chosen yet the board shows the first project, so the picker must agree. */
  it('marks the first project selected before an explicit choice', () => {
    renderProjectPicker();
    expect(screen.getByTestId('board-project-project-1').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('board-project-project-2').props.accessibilityState.selected).toBe(false);
  });

  it('writes the choice to the store and dismisses', () => {
    renderProjectPicker();

    fireEvent.press(screen.getByTestId('board-project-project-2'));

    expect(useBoardStore.getState().selectedProjectId).toBe('project-2');
    expect(mockBack).toHaveBeenCalled();
  });

  it('reflects an already-selected project', () => {
    useBoardStore.getState().selectProject('project-2');
    renderProjectPicker();

    expect(screen.getByTestId('board-project-project-2').props.accessibilityState.selected).toBe(true);
    expect(screen.getByTestId('board-project-project-1').props.accessibilityState.selected).toBe(false);
  });

  /**
   * The groups list and the project list are two separate desktop reads, so
   * they can legitimately arrive out of step: a project can carry a groupId
   * the phone has never seen a group for. Dropping it would make a paired
   * project unreachable from the only screen that can switch to it.
   */
  it('still shows a project whose groupId matches no known group, rather than dropping it', () => {
    useBoardStore.setState({
      projects: [
        { id: 'project-1', name: 'Alpha', groupId: 'real-group', position: 0 },
        { id: 'project-2', name: 'Beta', groupId: 'ghost-group', position: 1 },
      ],
      projectGroups: [{ id: 'real-group', name: 'Real Group', position: 0 }],
    });

    renderProjectPicker();

    expect(screen.getByTestId('board-project-project-1')).toBeTruthy();
    expect(screen.getByTestId('board-project-project-2')).toBeTruthy();
  });

  /**
   * The null-groupId bucket and every orphaned-group bucket are concatenated
   * and then re-sorted by position TOGETHER, not left in Map insertion
   * order. The fixture below deliberately lists the higher-position project
   * FIRST (so it is the first key the Map sees) and the lower-position
   * orphaned-group project SECOND, which is the one arrangement Map
   * insertion order and position order actually disagree on.
   */
  it('orders the ungrouped section by position across the null bucket and orphan buckets combined', () => {
    useBoardStore.setState({
      projects: [
        { id: 'project-late', name: 'Late (position 5)', groupId: null, position: 5 },
        { id: 'project-early', name: 'Early (position 1)', groupId: 'ghost-group', position: 1 },
      ],
      projectGroups: [],
    });

    renderProjectPicker();

    const rows = screen.getAllByRole('radio');
    expect(rows.map((row) => row.props.testID)).toEqual(['board-project-project-early', 'board-project-project-late']);
  });
});
