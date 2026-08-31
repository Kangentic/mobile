import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { StyleSheet } from 'react-native';
import * as Reanimated from 'react-native-reanimated';
import { ThemeProvider, Skeleton, SkeletonCard, SkeletonRow, darkTerminalTheme } from '@/components';
import { ScreenMotionOverride } from '@/components/motion/ScreenMotion';

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

  /**
   * A loop nobody can see costs the same as one they can (see
   * .claude/rules/motion-conventions.md): the per-vsync Reanimated flush walks
   * every REGISTERED mapper, dirty or not, at ~0.47 CPU points each measured
   * on a release build. The pulse's useSharedValue/effect/useAnimatedStyle now
   * live in a PulsingBlock child mounted ONLY on the branch that animates
   * (!reducedMotion && screenMotionActive), so a blurred or reduced-motion
   * skeleton registers NO mapper rather than a cancelled one.
   *
   * A skeleton that never animates still renders a correct-looking static
   * block at the resting opacity - the "rests at the mid opacity" test above
   * passes whether or not a mapper is silently registered behind it. So the
   * assertion here is on the MECHANISM (useAnimatedStyle called or not),
   * mirroring AgentStatusIcon.test.tsx's "registered mappers" block: a
   * regression that hoists these hooks back above the gate (the old shape,
   * still calling them unconditionally and branching only on the returned
   * element) renders identically for every other test in this file and would
   * only be caught here.
   */
  describe('the screen motion gate', () => {
    it('rests at mid opacity and registers no animated mapper while the screen is blurred', () => {
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');

      render(
        <ThemeProvider>
          <ScreenMotionOverride active={false}>
            <Skeleton testID="loading-line" />
          </ScreenMotionOverride>
        </ThemeProvider>,
      );

      const flattenedStyle = StyleSheet.flatten(screen.getByTestId('loading-line').props.style);
      expect(flattenedStyle.opacity).toBe((opacityMin + opacityMax) / 2);
      expect(animatedStyleSpy).not.toHaveBeenCalled();
    });

    it('starts the pulse and registers exactly one animated mapper once the screen is focused', () => {
      const animatedStyleSpy = jest.spyOn(Reanimated, 'useAnimatedStyle');

      render(
        <ThemeProvider>
          <ScreenMotionOverride active={true}>
            <Skeleton testID="loading-line" />
          </ScreenMotionOverride>
        </ThemeProvider>,
      );

      const flattenedStyle = StyleSheet.flatten(screen.getByTestId('loading-line').props.style);
      expect(flattenedStyle.opacity).toBe(opacityMax);
      expect(animatedStyleSpy).toHaveBeenCalledTimes(1);
    });
  });
});
