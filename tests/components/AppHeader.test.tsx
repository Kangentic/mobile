import React from 'react';
import { StyleSheet, type StyleProp, type ViewStyle } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { AppHeader, ThemeProvider } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';

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

  /**
   * Regression cover for task #113 change 2: the Settings glyph was a bare
   * Pressable, a naked tap target (ui-conventions.md, visible tap targets). It
   * is the raised IconButton now, on a surfaceRaised fill with a hairline
   * outline, the same on every tab's header.
   */
  it('draws the settings button on a raised surface with a hairline outline', async () => {
    await render(
      <ThemeProvider>
        <AppHeader title="Home" />
      </ThemeProvider>,
    );

    const settingsSurface = StyleSheet.flatten(screen.getByTestId('header-settings-button').props.style as StyleProp<ViewStyle>) as ViewStyle;
    expect(settingsSurface.backgroundColor).toBe(darkTerminalTheme.colors.surfaceRaised);
    expect(settingsSurface.borderColor).toBe(darkTerminalTheme.colors.border);
    expect(settingsSurface.borderWidth).toBe(StyleSheet.hairlineWidth);
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
