import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { LoaderCircle } from 'lucide-react-native';
import { useScreenMotionActive } from './motion/ScreenMotion';
import { useTheme } from './theme/ThemeProvider';

const FULL_TURN_DEGREES = 360;

export interface StatusSpinnerProps {
  size: number;
  color: string;
  testID: string;
}

/**
 * The desktop's in-between-state spinner: lucide's Loader2 (LoaderCircle) turning
 * once per `statusSpinner.turnMs`, the desktop's own `animate-spin` rate. The
 * task card's footer draws it at 12 for Queued, Starting agent and a respawn's
 * step; the session header at 16 while a respawn is in flight.
 *
 * It spins only where motion is allowed (OS reduced motion off, the screen
 * focused), which the desktop's does not check, and holds still otherwise. The
 * spinning wrapper is its own component, mounted only on that branch, so a still
 * spinner registers no Reanimated mapper and a recycled row never keeps a stale
 * angle (motion-conventions.md).
 */
export function StatusSpinner({ size, color, testID }: StatusSpinnerProps): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const screenMotionActive = useScreenMotionActive();
  const glyph = <LoaderCircle size={size} color={color} />;
  if (reducedMotion || !screenMotionActive) {
    return <View testID={testID}>{glyph}</View>;
  }
  return (
    <SpinningGlyph size={size} testID={testID}>
      {glyph}
    </SpinningGlyph>
  );
}

/** One linear turn per `statusSpinner.turnMs`, as a transform on a native view (never an SVG prop). */
function SpinningGlyph({ size, testID, children }: { size: number; testID: string; children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  const turnMs = theme.motion.statusSpinner.turnMs;
  const spinTurns = useSharedValue(0);
  useEffect(() => {
    spinTurns.set(0);
    spinTurns.set(
      withRepeat(withTiming(1, { duration: turnMs, easing: Easing.linear, reduceMotion: ReduceMotion.System }), -1, false),
    );
    return () => {
      cancelAnimation(spinTurns);
    };
  }, [spinTurns, turnMs]);
  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spinTurns.get() * FULL_TURN_DEGREES}deg` }],
  }));
  return (
    <Animated.View testID={testID} style={[styles.box, { width: size, height: size }, spinStyle]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  box: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
