import React, { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import Animated, {
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from 'react-native-reanimated';
import { useTheme } from '@/components';
import { bezierEasing } from '@/components/motion/presets';

export interface SectionLandingPulseProps {
  /** The row's `sectionChangedAt`. Read once, at mount: the caller keys this component by it. */
  changedAtMs: number;
  testID: string;
}

/**
 * The landing pulse: a row that just changed sections tints briefly at its new
 * position so the eye can track the move. The change is marked event-side only
 * (see activityStore.sectionChangedAt), so a reconnect snapshot that reshuffles
 * everything stays silent. Timings are `theme.motion.sectionPulse`.
 *
 * BOUNDED BY A JS TIMER, NOT BY REANIMATED. The overlay used to stay mounted for
 * the row's whole life, with the tint cleared only by Reanimated writes (the
 * fade's frames, then the effect cleanup's zero). On 2026-10-05 an iOS card kept
 * the tint until the app was force-killed. Its colour solves to alpha 0.16
 * exactly (measured from the screenshot), so the native view took the first
 * write and never one fade frame. WHY the frames never landed is inferred, not
 * measured (frames lost across a background and foreground is the likeliest
 * fit), and this design does not depend on the answer: an unmount removes the
 * native view through a React commit, which needs no Reanimated frame at all.
 * Never move the unmount onto the fade's completion callback (`runOnJS`): that
 * callback runs on a Reanimated frame, which is the thing that went missing.
 *
 * The caller mounts this only for a row that has changed section at all, KEYED
 * by session and change instant. The key is what makes it correct: a new change
 * remounts it, so the pulse restarts, and a FlashList rebind to another session
 * remounts it, so a recycled row can never inherit a tint. The session is in
 * the key because one event burst can stamp two sessions in the same
 * millisecond.
 *
 * It also keeps the mapper off a resting row. The animated half
 * (`SectionPulseFade`) is mounted only while pulsing, the same split as
 * `AgentStatusIcon`'s `SpinningMark`: a registered mapper is walked on every
 * frame whether or not it is dirty (see motion-conventions.md).
 */
export function SectionLandingPulse({ changedAtMs, testID }: SectionLandingPulseProps): React.JSX.Element | null {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const { windowMs, durationMs, unmountMarginMs } = theme.motion.sectionPulse;
  const mountedForMs = durationMs + unmountMarginMs;
  // Date.now() is impure to call during render (react-hooks/purity). A lazy
  // initializer reads the clock once, at mount, and the key makes the mount
  // the only moment that matters.
  const [pulsing, setPulsing] = useState(() => Date.now() - changedAtMs < windowMs);

  useEffect(() => {
    if (!pulsing) return undefined;
    const unmountTimer = setTimeout(() => {
      setPulsing(false);
    }, mountedForMs);
    return () => {
      clearTimeout(unmountTimer);
    };
  }, [pulsing, mountedForMs]);

  // Reduced motion mounts nothing. `ReduceMotion.System` snaps the fade
  // straight to 0 (read from Reanimated's source, not measured), so the
  // always-mounted overlay never showed a tint there either, while mounting
  // this one would paint its first commit at full strength for a frame and
  // then cut.
  if (!pulsing || reducedMotion) return null;
  return <SectionPulseFade testID={testID} />;
}

/**
 * The animated half, mounted only while the gate is pulsing. The shared value
 * starts at full strength, so the first commit paints the tint before the UI
 * runtime has run a frame; the fade takes it to 0 from there, and the gate's
 * timer removes the view whether or not the fade ever ran.
 */
function SectionPulseFade({ testID }: { testID: string }): React.JSX.Element {
  const theme = useTheme();
  const { opacityMax, durationMs } = theme.motion.sectionPulse;
  const fadeEasing = theme.motion.easing.accelerate;
  const pulseOpacity = useSharedValue(opacityMax);

  useEffect(() => {
    pulseOpacity.set(
      withTiming(0, { duration: durationMs, easing: bezierEasing(fadeEasing), reduceMotion: ReduceMotion.System }),
    );
    return () => {
      cancelAnimation(pulseOpacity);
    };
  }, [pulseOpacity, durationMs, fadeEasing]);

  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulseOpacity.get() }));

  return (
    <Animated.View
      pointerEvents="none"
      testID={testID}
      style={[StyleSheet.absoluteFill, { backgroundColor: theme.colors.accent, borderRadius: theme.radii.md }, pulseStyle]}
    />
  );
}
