import { useMemo } from 'react';
import {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  SlideInDown,
  SlideOutDown,
  type ComplexAnimationBuilder,
  type EasingFunctionFactory,
} from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';
import type { MotionEasingBezier } from '../theme/tokens';

/**
 * The app's named entering/exiting animation presets, built from the theme's
 * motion tokens. Intent-based names, not mechanism names: a screen fades in,
 * a sheet slides, a banner appears. Every preset honors the OS reduce-motion
 * setting (`ReduceMotion.System`), so no consumer has to remember to.
 *
 * FlashList hard rule: never hand these (or any entering/exiting/layout
 * animation) to a renderItem root; recycling replays them on every bind.
 * Animate at the container level only.
 */
export interface MotionPresets {
  screenFadeIn: ComplexAnimationBuilder;
  sheetSlideIn: ComplexAnimationBuilder;
  sheetSlideOut: ComplexAnimationBuilder;
  bannerIn: ComplexAnimationBuilder;
  bannerOut: ComplexAnimationBuilder;
  crossfadeIn: ComplexAnimationBuilder;
}

/**
 * The one place a theme bezier token becomes a Reanimated easing. Exported so
 * call sites outside this directory never spell the four-argument
 * `Easing.bezier(...)` spread themselves - that duplication is where a literal
 * control point eventually creeps in, and `eslint.config.mjs` now bans the raw
 * call outside `src/components/motion/` (see motion-conventions.md).
 */
export function bezierEasing(controlPoints: MotionEasingBezier): EasingFunctionFactory {
  return Easing.bezier(controlPoints.x1, controlPoints.y1, controlPoints.x2, controlPoints.y2);
}

export function useMotionPresets(): MotionPresets {
  const theme = useTheme();
  return useMemo(() => {
    const { durations, easing } = theme.motion;
    const decelerate = bezierEasing(easing.decelerate);
    const accelerate = bezierEasing(easing.accelerate);
    const standard = bezierEasing(easing.standard);
    return {
      screenFadeIn: FadeIn.duration(durations.base).easing(decelerate).reduceMotion(ReduceMotion.System),
      sheetSlideIn: SlideInDown.duration(durations.base).easing(decelerate).reduceMotion(ReduceMotion.System),
      sheetSlideOut: SlideOutDown.duration(durations.fast).easing(accelerate).reduceMotion(ReduceMotion.System),
      bannerIn: FadeIn.duration(durations.fast).easing(decelerate).reduceMotion(ReduceMotion.System),
      bannerOut: FadeOut.duration(durations.fast).easing(accelerate).reduceMotion(ReduceMotion.System),
      crossfadeIn: FadeIn.duration(durations.base).easing(standard).reduceMotion(ReduceMotion.System),
    };
  }, [theme.motion]);
}
