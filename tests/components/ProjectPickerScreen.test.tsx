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
});
