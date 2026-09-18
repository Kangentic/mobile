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
 * What the veil is labelled, and what SessionScreen announces once, when the
 * wait passes the quiet deadline with nothing having arrived: the pane under
 * it has cleared to the empty terminal and there is still nothing to read.
 */
export const SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL = 'Waiting for the desktop to report a session';

/**
 * Announced once when the swap SETTLES (the successor painted, or its
 * transcript landed), so a screen reader user who heard the label above
 * also hears that the wait is over.
 */
export const SESSION_SWAP_SETTLED_ANNOUNCEMENT = 'Session ready';

export interface SessionSwapVeilProps {
  /**
   * True once the window has passed its quiet deadline with the dead session
   * still bound (SessionScreen's waiting phase, and for the rest of that
   * window). The veil then paints the empty terminal under its scrim in place
   * of the dead session's last frame, and carries the waiting label.
   */
  waiting?: boolean;
}

/**
 * The ONE transitional surface for a session swap, and for the wait that
 * follows one.
 *
 * On most column moves the desktop suspends the task's session and spawns or
 * resumes a successor a few seconds later. From the `session-ended` push
 * until the successor's first frame has painted, this covers the pane box:
 * the dead session's last frame stays under a scrim that breathes slowly,
 * and NOTHING is written on it - no title, no caption, no button. There is
 * nothing for the user to read or try to act on, which is the point.
 *
 * Past SessionScreen's quiet deadline with nothing having arrived, nothing is
 * revealed either. The desktop's task detail has no text card for this
 * stretch: while a session is spawning it shows a launch overlay (a muted
 * spinner over a blank terminal area) for as long as it takes, and the phone
 * mirrors that. The scrim keeps breathing, the pane under it clears from the
 * dead frame to the empty terminal (the `waiting` layer below, the terminal's
 * own background), and what the user can do is already on the screen: the
 * column chip in the header moves the task, the switcher beneath reaches the
 * transcript and the diff. The two text surfaces this replaced ("Switching
 * session", "Session ended") and the card that briefly replaced them are
 * gone.
 *
 * It leaves by the crossfade it arrived by (`crossfadeOut`, the base
 * duration on the standard curve): what the eye follows at the reveal is the
 * successor's frame underneath, and the fast banner exit read as a cut.
 *
 * On the pulse: motion-conventions.md says a looping animation that never
 * stops holds the app drawing at full frame rate, and until 2026-09-18 this
 * one was bounded by the quiet deadline for exactly that reason. It now runs
 * for as long as the screen is waiting, by decision, to match the desktop's
 * spinner. Measured on the release build (emulator, `top` over the window):
 * about 11% of a core against 5% with the scrim static, so the exception is
 * real and the gates around it matter: the session route's
 * `ScreenMotionProvider` stops it when a route is pushed over this screen or
 * the app backgrounds, OS reduced motion degrades it to a static scrim at the
 * pulse's mid opacity, and it registers exactly one Reanimated mapper and
 * only while mounted (`PulsingBlock` is the branch that animates; the other
 * branch is a plain View). Opacity only, on an absolutely positioned layer
 * with no children.
 *
 * The root keeps the default `pointerEvents`: it must swallow a tap on the
 * covered pane (a tap on the WebView toggles the keyboard for a dead PTY). It
 * covers the PANE box only, as a sibling of the pane wrapper, so the footer
 * beneath is untouched and its switcher stays live.
 */
export function SessionSwapVeil({ waiting = false }: SessionSwapVeilProps): React.JSX.Element {
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
      exiting={presets.crossfadeOut}
      // Modal to VoiceOver, so it cannot reach the covered pane behind the
      // scrim; SessionScreen hides the pane subtree for Android. One atomic
      // stop is right: there is no button inside it for a screen reader to
      // miss.
      accessibilityViewIsModal
      accessibilityRole="progressbar"
      accessibilityLabel={waiting ? SESSION_SWAP_WAITING_ACCESSIBILITY_LABEL : SESSION_SWAP_VEIL_ACCESSIBILITY_LABEL}
      accessibilityState={{ busy: true }}
    >
      {/* The empty terminal, painted under the scrim once the wait has
          outlived the deadline: the terminal's own background, opaque, so the
          dead session's last frame is no longer what the user stares at.
          Kept for the rest of the window, so a late successor paints under
          this rather than over the dead frame. */}
      {waiting ? (
        <View
          testID="session-swap-veil-empty"
          pointerEvents="none"
          style={[styles.fill, { backgroundColor: theme.colors.terminalBackground }]}
        />
      ) : null}
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
     * visible. Without this the visible pane would win the stacking contest
     * and paint over the scrim; a tap swallowed by the wrong layer is the
     * only way that fault ever showed, and `SessionScreen.session-swap
     * .test.tsx` pins the ordering as the closest mechanical guard.
     */
    zIndex: 2,
  },
});
