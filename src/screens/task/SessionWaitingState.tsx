import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Stack, Text, useTheme } from '@/components';

/** The card's two lines, exported so the screen tests pin the exact copy. */
export const SESSION_WAITING_TITLE = 'Waiting for the desktop';
export const SESSION_WAITING_BODY = 'This screen updates as soon as it reports a session for this task.';

export interface SessionWaitingStateProps {
  /** Switches the screen to Chat; the transcript outlives the session. */
  onReadTranscript: () => void;
  /** Opens the move-task sheet; null while no cached board holds the task (nothing to move within). */
  onMoveTask?: (() => void) | null;
}

/**
 * The ONE text surface a session swap can end on, and a card rather than a
 * verdict.
 *
 * It reveals only past SessionScreen's quiet window with the dead session
 * still bound: the desktop suspended this task's session and nothing has
 * replaced it in SESSION_SWAP_QUIET_MS. The phone cannot tell WHY from here.
 * A stalled spawn, a park with no successor, and a desktop that is running
 * fine while this device is not receiving its updates all look the same on
 * the wire, and the last is the likeliest on a phone. So the copy names what
 * the screen is doing (waiting, and updating the moment the desktop reports
 * a session) and nothing it cannot know: no "ended", no time, no column, and
 * no guess at what a move would do, since that depends on how the board is
 * set up. It replaced two surfaces ("Switching session" with the desktop's
 * label when a latch promised a successor, "Session ended" otherwise) and the
 * 20 s fallback from the first to the second, which was the phone changing
 * its verdict on a clock.
 *
 * A scrim, not a curtain: the last frame stays under it at the veil's
 * resting opacity, so the swap veil's scrim simply gains a card at the
 * deadline. The footer is a sibling BELOW the pane box this covers, so the
 * mode switcher stays on its usual row beneath the card (SessionScreen hides
 * the composer and quick keys there): Chat and Changes are one tap away, and
 * "Read transcript" is that same tap raised as the primary. No animation:
 * this can be on screen indefinitely, and per motion-conventions.md an
 * indicator that never stops holds the app drawing at full frame rate.
 */
export function SessionWaitingState({ onReadTranscript, onMoveTask = null }: SessionWaitingStateProps): React.JSX.Element {
  const theme = useTheme();
  const { opacityMin, opacityMax } = theme.motion.swapVeilPulse;
  return (
    <View
      testID="session-waiting-state"
      style={styles.overlay}
      // Modal to VoiceOver, so it cannot reach the covered pane behind the
      // scrim. Android has no equivalent on the overlay, so SessionScreen
      // hides the pane subtree there; the two together are the full fix.
      accessibilityViewIsModal
    >
      {/* The scrim is its OWN layer rather than opacity on this container: a
          container opacity fades the title and the buttons with it, over a
          live frame of arbitrary colour, which is where contrast goes. Painted
          first, so the card stacks on top. The veil's resting opacity, so the
          deadline changes nothing under the card. */}
      <View
        testID="session-waiting-scrim"
        style={[
          StyleSheet.absoluteFill,
          { backgroundColor: theme.colors.background, opacity: (opacityMin + opacityMax) / 2 },
        ]}
        pointerEvents="none"
      />
      {/* A live region rather than a `progressbar` role on the container:
          that role made the whole overlay one atomic stop, and a screen
          reader could then miss the buttons. The visible text is the
          announcement. */}
      <Stack gap="xs" style={styles.content} accessibilityLiveRegion="polite">
        <Text variant="title">{SESSION_WAITING_TITLE}</Text>
        <Text variant="body" color="secondary" style={styles.body}>
          {SESSION_WAITING_BODY}
        </Text>
        {/* Stacked and full width: the raised primary reads as the one call
            to action, with the outlined alternative under it rather than
            beside it as a same-weight pair. */}
        <Stack gap="sm" style={[styles.actions, { marginTop: theme.spacing.md }]}>
          <Button label="Read transcript" onPress={onReadTranscript} testID="session-waiting-read-transcript" />
          {onMoveTask ? (
            <Button label="Move task" variant="outline" onPress={onMoveTask} testID="session-waiting-move-task" />
          ) : null}
        </Stack>
      </Stack>
    </View>
  );
}

const styles = StyleSheet.create({
  overlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
    /**
     * Strictly above SessionScreen's panes, which carry `zIndex: 1` when
     * visible. Without this the overlay lost the stacking contest and the
     * chat pane sat ON TOP of it: the title bled through the gaps between
     * transcript cards and both buttons were dead, because React Native
     * hands a tap to the topmost view rather than falling through to an
     * occluded sibling.
     *
     * That regression shipped green through every required check: a Jest
     * `fireEvent.press` calls the handler directly and never consults hit
     * testing, so no JS tier can see a stacking-order bug. The paired
     * Maestro flow `session-ended-state.yaml` is what caught it, and
     * `SessionScreen.session-swap.test.tsx` pins the ordering itself as the
     * closest mechanical guard available. Raising a pane's zIndex without
     * raising this one reintroduces the bug.
     */
    zIndex: 2,
  },
  content: {
    alignItems: 'center',
    alignSelf: 'center',
    paddingHorizontal: 32,
    maxWidth: 400,
  },
  body: {
    textAlign: 'center',
  },
  actions: {
    alignSelf: 'stretch',
  },
});
