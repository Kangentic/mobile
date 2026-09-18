import React from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { useReducedMotion } from 'react-native-reanimated';
import { useMotionPresets, useTheme } from '@/components';
import { BlinkingBlock } from '@/components/motion/BlinkingBlock';
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
   * of the dead session's last frame, holds the scrim static, blinks a cursor
   * at the grid's origin instead, and carries the waiting label.
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
 * mirrors that in the terminal's own idiom. The pane under the scrim clears
 * from the dead frame to the empty terminal (the `waiting` layer below, the
 * terminal's own background), the scrim holds still, and one cell-sized
 * cursor blinks at the grid's origin. What the user can do is already on the
 * screen: the column chip in the header moves the task, the switcher beneath
 * reaches the transcript and the diff. The two text surfaces this replaced
 * ("Switching session", "Session ended") and the card that briefly replaced
 * them are gone.
 *
 * Why the scrim stops breathing once the pane has cleared, and why the cursor
 * blinks rather than breathes. Its breath is only visible against content:
 * the scrim is the app background over the terminal background, three colour
 * units apart, so over the empty grid the full swing moves each channel by
 * less than one unit. And a tween costs a whole window frame per vsync
 * however small the view that changed. Measured on the release build
 * (emulator, 2026-09-18, the pane hidden under this veil, the same process
 * for every arm): the full-screen scrim breath drew about 60 frames a second
 * at 20-31% of a core; a cell-sized cursor breathing under `PulsingBlock`
 * drew 57 a second at 24-28%, no cheaper at all; the same veil held static
 * (blurred under the move sheet) drew 0 frames at 1.5-4%, the Changes lens
 * beside it 0-4%. An earlier revision of this comment claimed the cursor was
 * cheap because a frame's damage was one cell rather than three full-screen
 * layers; that was inferred, not measured, and it was wrong. So the cursor
 * is `BlinkingBlock`: a two-state toggle on a JS interval, one commit per
 * half-period, no Reanimated mapper in the waiting phase at all. Measured
 * the same way once shipped: 42 frames in 25.8 s (1.6 a second) at 10-12%,
 * against a live idle terminal at 11-12.5% in the same process.
 *
 * It leaves by the crossfade it arrived by (`crossfadeOut`, the base
 * duration on the standard curve): what the eye follows at the reveal is the
 * successor's frame underneath, and the fast banner exit read as a cut.
 *
 * On the motion: motion-conventions.md says a looping animation that never
 * stops holds the app drawing at full frame rate. The quiet-phase breath is
 * bounded by the deadline for exactly that reason. The wait cursor runs for
 * as long as the screen is waiting, by decision, to match the desktop's
 * spinner, and it is allowed to because it draws two frames a second, not
 * sixty. The gates around it still matter: the session route's
 * `ScreenMotionProvider` stops it when a route is pushed over this screen, OS
 * reduced motion holds it at a steady mid opacity, and a backgrounded app
 * draws nothing (measured with the veil up and the app sent Home: 4-8% of a
 * core, zero frames). The quiet-phase scrim registers exactly one Reanimated
 * mapper and only while mounted (`PulsingBlock` is the branch that animates;
 * the other branch is a plain View). Opacity only, on absolutely positioned
 * views with no children.
 *
 * The pane under the cleared veil is HIDDEN by SessionScreen, not merely
 * covered: a dead session's page keeps the WebView painting at the full
 * frame rate for as long as the pane is drawn (measured: about 58 frames a
 * second and 30 points of a core, with this veil static), while the pane at
 * opacity 0 draws nothing. The cleared veil is opaque over it, so hiding it
 * changes nothing visible.
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
  const motionAllowed = !reducedMotion && screenMotionActive;
  const { durationMs, opacityMin, opacityMax } = theme.motion.swapVeilPulse;
  const restingOpacity = (opacityMin + opacityMax) / 2;
  const scrimStyle = { ...styles.fill, backgroundColor: theme.colors.background };
  const cursorBlink = theme.motion.waitCursorBlink;
  const cursorStyle = {
    ...styles.cursor,
    left: theme.spacing.sm,
    top: theme.spacing.sm,
    width: theme.spacing.sm,
    height: theme.spacing.lg,
    backgroundColor: theme.colors.textSecondary,
  };

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
      {/* The scrim layer carries the testID on every branch, so a test can
          read its opacity the same way whichever it took. Static once the
          pane has cleared (see the docblock), and under reduced motion or a
          blurred screen. */}
      {waiting || !motionAllowed ? (
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
      {/* The wait cursor, ABOVE the scrim so it is not dimmed by it: one cell
          at the grid's origin, blinking while the screen is waiting. */}
      {waiting && motionAllowed ? (
        <BlinkingBlock
          testID="session-swap-veil-cursor"
          baseStyle={cursorStyle}
          intervalMs={cursorBlink.intervalMs}
          opacityMin={cursorBlink.opacityMin}
          opacityMax={cursorBlink.opacityMax}
        />
      ) : null}
      {waiting && !motionAllowed ? (
        <View
          testID="session-swap-veil-cursor"
          pointerEvents="none"
          style={[cursorStyle, { opacity: (cursorBlink.opacityMin + cursorBlink.opacityMax) / 2 }]}
        />
      ) : null}
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
  cursor: {
    position: 'absolute',
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
