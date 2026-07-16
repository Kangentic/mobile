import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';
import { ThemeProvider, Skeleton, SkeletonCard, SkeletonRow, darkTerminalTheme } from '@/components';

const { opacityMin, opacityMax } = darkTerminalTheme.motion.skeletonPulse;

describe('Skeleton', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('renders a placeholder block with the requested dimensions', () => {
    render(
      <ThemeProvider>
        <Skeleton width="58%" height={12} testID="loading-line" />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('loading-line').props.style);
    expect(flattenedStyle.width).toBe('58%');
    expect(flattenedStyle.height).toBe(12);
    expect(flattenedStyle.backgroundColor).toBe(darkTerminalTheme.colors.surfaceRaised);
  });

  it('starts the pulse at the max opacity when motion is allowed', () => {
    render(
      <ThemeProvider>
        <Skeleton testID="loading-line" />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('loading-line').props.style);
    expect(flattenedStyle.opacity).toBe(opacityMax);
  });

  it('rests at the mid opacity under OS reduced motion (no pulse)', () => {
    jest.spyOn(Reanimated, 'useReducedMotion').mockReturnValue(true);

    render(
      <ThemeProvider>
        <Skeleton testID="loading-line" />
      </ThemeProvider>,
    );

    const flattenedStyle = StyleSheet.flatten(screen.getByTestId('loading-line').props.style);
    expect(flattenedStyle.opacity).toBe((opacityMin + opacityMax) / 2);
  });

  it('renders the row and card composites', () => {
    render(
      <ThemeProvider>
        <SkeletonRow testID="skeleton-row" />
        <SkeletonCard testID="skeleton-card" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('skeleton-row')).toBeTruthy();
    expect(screen.getByTestId('skeleton-card')).toBeTruthy();
  });
});
