import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AppHeader, ThemeProvider } from '@/components';

jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

describe('AppHeader', () => {
  beforeEach(() => {
    mockPush.mockClear();
  });

  it('renders the brandmark and the title', async () => {
    await render(
      <ThemeProvider>
        <AppHeader title="Home" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('app-header-brandmark')).toBeTruthy();
    expect(screen.getByText('Home')).toBeTruthy();
  });

  it('routes to /settings when the settings button is pressed', async () => {
    await render(
      <ThemeProvider>
        <AppHeader title="Home" />
      </ThemeProvider>,
    );

    await fireEvent.press(screen.getByTestId('header-settings-button'));

    expect(mockPush).toHaveBeenCalledWith('/settings');
  });

  it('renders a pressable title with a chevron and fires onTitlePress when supplied', async () => {
    const onTitlePress = jest.fn();
    await render(
      <ThemeProvider>
        <AppHeader title="Alpha" onTitlePress={onTitlePress} />
      </ThemeProvider>,
    );

    const titleButton = screen.getByTestId('app-header-title');
    expect(titleButton.props.accessibilityRole).toBe('button');
    expect(titleButton.props.accessibilityLabel).toBe('Switch project (current: Alpha)');

    await fireEvent.press(titleButton);

    expect(onTitlePress).toHaveBeenCalledTimes(1);
  });

  it('renders a plain, non-pressable title when onTitlePress is omitted', async () => {
    await render(
      <ThemeProvider>
        <AppHeader title="Home" />
      </ThemeProvider>,
    );

    const titleBlock = screen.getByTestId('app-header-title');
    expect(titleBlock.props.accessibilityRole).toBeUndefined();
    expect(titleBlock.props.onPress).toBeUndefined();
  });
});
