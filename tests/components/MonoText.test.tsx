import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import { ThemeProvider, MonoText, darkTerminalTheme } from '@/components';

describe('MonoText', () => {
  it('renders its children in the theme monospace font', () => {
    render(
      <ThemeProvider>
        <MonoText testID="commit-hash">ea1651b</MonoText>
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('commit-hash').props.style);
    expect(screen.getByText('ea1651b')).toBeTruthy();
    expect(flattenedStyle.fontFamily).toBe(darkTerminalTheme.fontFamilyMono);
    expect(flattenedStyle.fontSize).toBe(darkTerminalTheme.typography.body.fontSize);
  });

  it('uses the caption token for size="caption"', () => {
    render(
      <ThemeProvider>
        <MonoText testID="dense-label" size="caption">
          src/components/MonoText.tsx
        </MonoText>
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('dense-label').props.style);
    expect(flattenedStyle.fontSize).toBe(darkTerminalTheme.typography.caption.fontSize);
  });

  it('applies the requested color role', () => {
    render(
      <ThemeProvider>
        <MonoText testID="accent-path" color="accent">
          kangentic://
        </MonoText>
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('accent-path').props.style);
    expect(flattenedStyle.color).toBe(darkTerminalTheme.colors.accent);
  });
});
