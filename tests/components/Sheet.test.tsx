import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ThemeProvider, Sheet, Text } from '@/components';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

describe('Sheet', () => {
  it('renders its title and children when visible', () => {
    render(
      <ThemeProvider>
        <Sheet visible onClose={jest.fn()} title="Move task" testID="move-task-sheet">
          <Text>Sheet body</Text>
        </Sheet>
      </ThemeProvider>,
    );

    expect(screen.getByText('Move task')).toBeTruthy();
    expect(screen.getByText('Sheet body')).toBeTruthy();
    expect(screen.getByTestId('move-task-sheet')).toBeTruthy();
  });

  it('renders nothing when not visible', () => {
    render(
      <ThemeProvider>
        <Sheet visible={false} onClose={jest.fn()} testID="move-task-sheet">
          <Text>Sheet body</Text>
        </Sheet>
      </ThemeProvider>,
    );

    expect(screen.queryByText('Sheet body')).toBeNull();
  });

  it('calls onClose when the backdrop is pressed', () => {
    const onClose = jest.fn();
    render(
      <ThemeProvider>
        <Sheet visible onClose={onClose} testID="move-task-sheet">
          <Text>Sheet body</Text>
        </Sheet>
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('move-task-sheet-backdrop'));

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
