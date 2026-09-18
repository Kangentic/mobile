import React, { useEffect, useState } from 'react';
import { View } from 'react-native';
import type { StyleProp, ViewStyle } from 'react-native';

export interface BlinkingBlockProps {
  baseStyle: ViewStyle;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  /** Half-period: lit for one interval, dim for the next. */
  intervalMs: number;
  opacityMin: number;
  opacityMax: number;
}

/**
 * A block that blinks between two opacities forever: lit for `intervalMs`,
 * dim for the next, on a JS interval. Rendered ONLY on the branch that
 * animates, exactly like `PulsingBlock`: the caller decides (reduced motion,
 * the screen motion gate) and mounts a plain View otherwise.
 *
 * Why a JS interval and not a Reanimated worklet: motion-conventions.md says a
 * two-state toggle is not a worklet, and here the measurement makes that
 * load-bearing. A tween on a shared value writes the native view every vsync,
 * and every write draws a whole window frame however small the view: on the
 * release build (emulator, 2026-09-18) the swap veil's cell-sized cursor
 * breathing under `PulsingBlock` drew 57 frames a second at 24-28% of a
 * core, the same cost its full-screen scrim breath had, while the identical
 * veil held still drew nothing at 1.5-4%. A stepped Reanimated animation
 * would still walk a mapper every vsync. This commits one React update per
 * half-period, one frame each, and registers no mapper at all.
 *
 * The interval keeps running while the app is backgrounded (the OS stops
 * delivering frames, so the toggle costs a state update and no draw); the
 * focus gate at the call site stops it under a pushed route.
 */
export function BlinkingBlock({
  baseStyle,
  style,
  testID,
  intervalMs,
  opacityMin,
  opacityMax,
}: BlinkingBlockProps): React.JSX.Element {
  const [lit, setLit] = useState(true);

  useEffect(() => {
    const handle = setInterval(() => {
      setLit((previous) => !previous);
    }, intervalMs);
    return () => {
      clearInterval(handle);
    };
  }, [intervalMs]);

  return <View testID={testID} style={[baseStyle, { opacity: lit ? opacityMax : opacityMin }, style]} />;
}
