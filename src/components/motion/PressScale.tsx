import React, { useCallback } from 'react';
import {
  Pressable,
  type GestureResponderEvent,
  type PressableProps,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import Animated, { ReduceMotion, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';
import { useTheme } from '../theme/ThemeProvider';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

export interface PressScaleProps extends Omit<PressableProps, 'style' | 'children'> {
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/**
 * The design system's pressed-depth primitive: a Pressable that scales to
 * theme.motion.pressedScale on press-in and springs back on release, honoring
 * OS reduced motion. Card, Button, and IconButton adopt it internally, so
 * their public APIs and testIDs are unchanged; it is also the ONLY per-item
 * animation permitted inside FlashList rows (a transform on the item's own
 * pressable never fights list recycling the way entering/exiting/layout
 * animations do).
 */
export function PressScale({ style, onPressIn, onPressOut, children, ...rest }: PressScaleProps): React.JSX.Element {
  const theme = useTheme();
  const pressedScale = theme.motion.pressedScale;
  const pressInDurationMs = theme.motion.durations.instant;
  const pressOutDurationMs = theme.motion.durations.fast;
  const scale = useSharedValue(1);

  // .get()/.set() instead of .value: the React-Compiler-safe shared-value
  // accessors, which also keep the react-hooks immutability lint happy.
  const animatedStyle = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));

  const handlePressIn = useCallback(
    (event: GestureResponderEvent) => {
      scale.set(withTiming(pressedScale, { duration: pressInDurationMs, reduceMotion: ReduceMotion.System }));
      onPressIn?.(event);
    },
    [scale, pressedScale, pressInDurationMs, onPressIn],
  );

  const handlePressOut = useCallback(
    (event: GestureResponderEvent) => {
      scale.set(withTiming(1, { duration: pressOutDurationMs, reduceMotion: ReduceMotion.System }));
      onPressOut?.(event);
    },
    [scale, pressOutDurationMs, onPressOut],
  );

  return (
    <AnimatedPressable style={[animatedStyle, style]} onPressIn={handlePressIn} onPressOut={handlePressOut} {...rest}>
      {children}
    </AnimatedPressable>
  );
}
