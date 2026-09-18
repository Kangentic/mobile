import React, { useEffect } from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import Animated, {
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import type { MotionEasingBezier } from '../theme/tokens';
import { bezierEasing } from './presets';

export interface PulsingBlockProps {
  baseStyle: ViewStyle;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  durationMs: number;
  opacityMin: number;
  opacityMax: number;
  easing: MotionEasingBezier;
}

/**
 * A block whose opacity pulses between two values forever. Owns the shared
 * value, its driver effect, and the animated style, and is rendered ONLY on
 * the branch that actually animates: the caller decides (reduced motion, the
 * screen motion gate) and mounts a plain View otherwise.
 *
 * That split is the point, and it is the same one `SpinningMark` makes in
 * AgentStatusIcon.tsx. Cancelling the driver is not enough: a registered
 * Reanimated mapper is walked every vsync whether or not it is dirty, at
 * roughly half a CPU point each, so a `useAnimatedStyle` sitting above the gate
 * keeps costing a blurred or reduced-motion screen the walk for an animation
 * that is not running. Shared by the loading Skeleton (a fixed set per loading
 * container) and the session screen's swap veil (one, while a swap is in
 * flight).
 */
export function PulsingBlock({
  baseStyle,
  style,
  testID,
  durationMs,
  opacityMin,
  opacityMax,
  easing,
}: PulsingBlockProps): React.JSX.Element {
  const pulseOpacity = useSharedValue(opacityMax);

  useEffect(() => {
    pulseOpacity.set(opacityMax);
    pulseOpacity.set(
      withRepeat(
        withTiming(opacityMin, {
          duration: durationMs,
          easing: bezierEasing(easing),
          reduceMotion: ReduceMotion.System,
        }),
        -1,
        true,
      ),
    );
    return () => {
      cancelAnimation(pulseOpacity);
    };
  }, [pulseOpacity, opacityMin, opacityMax, durationMs, easing]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: pulseOpacity.get() }));

  return <Animated.View testID={testID} style={[baseStyle, animatedStyle, style]} />;
}
