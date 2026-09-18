import React from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useReducedMotion } from 'react-native-reanimated';
import { useMotionPresets, useTheme } from '@/components';
import { PulsingBlock } from '@/components/motion/PulsingBlock';
import { useScreenMotionActive } from '@/components/motion/ScreenMotion';

/**
 * What a screen reader hears when the veil opens (SessionScreen announces it
 * once per swap window) and what the veil itself is labelled. Accessibility
 * copy is exempt from the no-text rule, and from the brevity rule.
 */
export const SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL = 'Switching session, please wait';

/**
 * The ONE silent transitional surface for a session swap.
 *
 * On most column moves the desktop suspends the task's session and spawns or
 * resumes a successor a few seconds later. From the `session-ended` push
 * until the successor's first frame has painted, this covers the pane box:
 * the dead session's last frame stays under a scrim that breathes slowly,
 * and NOTHING is written on it - no title, no caption, no button. There is
 * nothing for the user to read or try to act on, which is the point: the
 * text surfaces that used to flash here for a second or two
 * (SessionSwitchingState, SessionEndedState) now reveal only if the swap
 * outlives SessionScreen's quiet threshold, the abnormal case.
 *
 * Why this one may animate when SessionSwitchingState deliberately did not:
 * the pulse is BOUNDED by that threshold (a few seconds, never the 20 s grace
 * window), it is gated by the session route's `ScreenMotionProvider` so a
 * pushed route stops it, it registers exactly one Reanimated mapper and only
 * while mounted (`PulsingBlock` is the branch that animates; the other branch
 * is a plain View), and OS reduced motion degrades it to a static scrim at the
 * pulse's mid opacity. Opacity only, on an absolutely positioned layer with
 * no children, per motion-conventions.md.
 *
 * The root keeps the default `pointerEvents`: it must swallow a tap on the
 * covered pane (a tap on the WebView toggles the keyboard for a dead PTY). It
 * covers the PANE box only, as a sibling of the pane wrapper, so the footer
 * beneath is untouched and its mode pill stays live.
 */
export function SessionSwapVeil(): React.JSX.Element {
  const theme = useTheme();
  const presets = useMotionPresets();
  const reducedMotion = useReducedMotion();
  const screenMotionActive = useScreenMotionActive();
  const { durationMs, opacityMin, opacityMax } = theme.motion.swapVeilPulse;
  const restingOpacity = (opacityMin + opacityMax) / 2;
  const scrimStyle = { ...styles.fill, backgroundColor: theme.colors.background };

  return (
    <Animated.View
      testID="session-swap-veil"
      style={styles.overlay}
      entering={presets.crossfadeIn}
      exiting={presets.bannerOut}
      // Modal to VoiceOver, so it cannot reach the covered pane behind the
      // scrim; SessionScreen hides the pane subtree for Android. One atomic
      // stop is right here, unlike the switching overlay: there is no button
      // inside it for a screen reader to miss.
      accessibilityViewIsModal
      accessibilityRole="progressbar"
      accessibilityLabel={SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL}
      accessibilityState={{ busy: true }}
    >
      {/* The scrim layer carries the testID on BOTH branches, so a test can
          read its opacity the same way either side. */}
      {reducedMotion || !screenMotionActive ? (
        <View testID="session-swap-veil-scrim" pointerEvents="none" style={[scrimStyle, { opacity: restingOpacity }]} />
      ) : (
        <PulsingBlock
          testID="session-swap-veil-scrim"
          baseStyle={scrimStyle}
          durationMs={durationMs}
          opacityMin={opacityMin}
          opacityMax={opacityMax}
          easing={theme.motion.easing.standard}
        />
      )}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  fill: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
  },
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    /**
     * Strictly above SessionScreen's panes, which carry `zIndex: 1` when
     * visible - the same stacking contest the two text overlays document.
     */
    zIndex: 2,
  },
});
