import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ThemeProvider, IconButton } from '@/components';

describe('IconButton', () => {
  it('fires onPress when tapped', async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <IconButton iconName="send" onPress={onPress} testID="composer-send" accessibilityLabel="Send message" />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('composer-send'));

    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('does not fire onPress when disabled', async () => {
    const onPress = jest.fn();
    await render(
      <ThemeProvider>
        <IconButton iconName="send" onPress={onPress} testID="composer-send" accessibilityLabel="Send message" disabled />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('composer-send'));

    expect(onPress).not.toHaveBeenCalled();
  });

  it('renders the fab variant with the same testID and label', async () => {
    await render(
      <ThemeProvider>
        <IconButton iconName="add" onPress={jest.fn()} testID="board-add-task" accessibilityLabel="Add task" variant="fab" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('board-add-task')).toBeTruthy();
    expect(screen.getByLabelText('Add task')).toBeTruthy();
  });
});
