import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ThemeProvider, Card, Text } from '@/components';

describe('Card', () => {
  it('renders children as a display-only card without a press handler', () => {
    render(
      <ThemeProvider>
        <Card>
          <Text>Static content</Text>
        </Card>
      </ThemeProvider>,
    );

    expect(screen.getByText('Static content')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('fires onPress when pressable', () => {
    const onPress = jest.fn();
    render(
      <ThemeProvider>
        <Card onPress={onPress} testID="task-card">
          <Text>Tap me</Text>
        </Card>
      </ThemeProvider>,
    );

    fireEvent.press(screen.getByTestId('task-card'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('fires onLongPress when pressable', () => {
    const onLongPress = jest.fn();
    render(
      <ThemeProvider>
        <Card onLongPress={onLongPress} testID="task-card">
          <Text>Hold me</Text>
        </Card>
      </ThemeProvider>,
    );

    fireEvent(screen.getByTestId('task-card'), 'longPress');

    expect(onLongPress).toHaveBeenCalledTimes(1);
  });
});
