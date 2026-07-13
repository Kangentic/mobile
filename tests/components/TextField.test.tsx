import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react-native';
import { ThemeProvider, TextField } from '@/components';

describe('TextField', () => {
  it('renders with its placeholder', () => {
    render(
      <ThemeProvider>
        <TextField testID="composer-input" placeholder="Message the agent" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('composer-input')).toBeTruthy();
    expect(screen.getByPlaceholderText('Message the agent')).toBeTruthy();
  });

  it('fires onChangeText with the typed value', () => {
    const onChangeText = jest.fn();
    render(
      <ThemeProvider>
        <TextField testID="composer-input" onChangeText={onChangeText} />
      </ThemeProvider>,
    );

    fireEvent.changeText(screen.getByTestId('composer-input'), 'run the tests');

    expect(onChangeText).toHaveBeenCalledTimes(1);
    expect(onChangeText).toHaveBeenCalledWith('run the tests');
  });
});
