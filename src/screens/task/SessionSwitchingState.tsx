import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Button, Row, Stack, Text, useTheme } from '@/components';

/**
 * The budget from ui-copy-brevity.md's "descriptions are one line at default
 * font on a small phone (~45 characters)". All four known desktop phase
 * labels ("Switching model...", "Switching agent...", "Applying new
 * settings...", "Starting new session...") fit well under it.
 *
 * A character count is a guard against a wall of text, NOT a guarantee of one
 * rendered line: at a large accessibility font scale a 45-character caption
 * wraps whatever this says. That is harmless here (the caption is centered in
 * an overlay with nothing below it, so it grows rather than clipping), so
 * there is deliberately no `numberOfLines` clamp. Do not lean on this cap as
 * a scaling-safe mechanism elsewhere.
 */
const MAX_LABEL_LENGTH = 45;

const GENERIC_CAPTION = 'The desktop is starting a new session.';

/**
 * Every code point React Native's `<Text>` breaks a line on. U+2028 (LINE
 * SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are easy to miss: `trim()`
 * counts them as line terminators and so strips them at the ENDS, which
 * makes an INTERIOR one clear every other check below and render a two-line
 * caption from a string that passed a one-line shape test.
 *
 * Code points rather than a regex literal on purpose: written inline, U+2028
 * and U+2029 terminate the literal itself, so the guard against them cannot
 * safely be spelled with them.
 */
const LINE_BREAKING_CODE_POINTS = new Set([0x0a, 0x0d, 0x2028, 0x2029]);

function hasLineBreak(value: string): boolean {
  for (const character of value) {
    if (LINE_BREAKING_CODE_POINTS.has(character.codePointAt(0) ?? 0)) return true;
  }
  return false;
}

/**
 * Whether `label` is safe to render as-is. The desktop's spawn-progress
 * label (kangentic board #639) is untrusted DISPLAY TEXT, not a key this
 * component switches on - it can carry a decorated staleness note or a
 * git-queue wait string, so this is a length and shape check, never a
 * lookup against known values.
 *
 * Falls back rather than truncates: a chopped "Applying new sett..." reads
 * worse than the honest generic caption. Empty-string rejection mirrors
 * activityStore's messagePreview convention - never let "" mean "nothing to
 * say".
 */
function renderableLabel(label: string | null | undefined): string | null {
  if (label === null || label === undefined) return null;
  const trimmed = label.trim();
  if (trimmed.length === 0) return null;
  if (hasLineBreak(trimmed)) return null;
  if (trimmed.length > MAX_LABEL_LENGTH) return null;
  return trimmed;
}

export interface SessionSwitchingStateProps {
  /** Switches the task screen to the Changes pane; diffs outlive the swap. */
  onViewChanges: () => void;
  /**
   * The desktop's in-flight spawn-progress label (e.g. "Switching model..."),
   * or null/undefined when the desktop sent none - a column-move-triggered
   * switch, or a desktop that predates the field. See `renderableLabel` for
   * what disqualifies a label from being shown.
   */
  label?: string | null;
}

/**
 * The honest surface for a task between two sessions.
 *
 * A column move that restarts the agent, OR a same-column respawn (a
 * model/agent/effort change signalled by the desktop's spawnProgressLabel,
 * kangentic board #639), is a session SWAP on the wire: the desktop suspends
 * the old session (which pushes `session-ended`) and spawns the successor
 * seconds later. Rendering the ended state in that gap tells the user their
 * work is over when it is being handed to a new agent, and offers a "View
 * changes" button for a task that is mid-handoff.
 *
 * Unlike SessionEndedState this is a SCRIM, not an opaque panel: the dead
 * session's last frame stays visible behind it, so the screen reads as in
 * transit rather than blanked. The successor's first snapshot repaints it.
 *
 * No animation, deliberately. This can be on screen for the whole grace
 * window, and per motion-conventions.md an indicator that never stops holds
 * the app drawing at full frame rate for as long as it is mounted.
 */
export function SessionSwitchingState({ onViewChanges, label }: SessionSwitchingStateProps): React.JSX.Element {
  const theme = useTheme();
  const caption = renderableLabel(label) ?? GENERIC_CAPTION;
  return (
    <View
      testID="session-switching-state"
      style={styles.overlay}
      // Modal to VoiceOver, so it cannot reach the covered pane behind the
      // scrim. Android has no equivalent on the overlay, so SessionScreen
      // hides the pane subtree there; the two together are the full fix.
      accessibilityViewIsModal
    >
      {/* The scrim is its OWN layer rather than opacity on this container:
          a container opacity fades the label and the button with it, and they
          sit over a live frame of arbitrary colour, which is where contrast
          goes. Painted first, so the content below it stacks on top. */}
      <View
        style={[StyleSheet.absoluteFill, styles.scrim, { backgroundColor: theme.colors.background }]}
        pointerEvents="none"
      />
      {/* Announced as a live region rather than given a `progressbar` role on
          the container: that role made this whole overlay one atomic stop, and
          a screen reader could then miss the only button out of it. The
          visible text is the announcement. */}
      <Stack gap="xs" style={styles.content} accessibilityLiveRegion="polite">
        <Text variant="title">Switching session</Text>
        <Text variant="body" color="secondary" style={styles.caption}>
          {caption}
        </Text>
        {/* The one way out while the panes are covered. A swap can run the
            whole grace window on a slow machine, and the work so far is still
            readable in the diff. */}
        <Row gap="sm" style={{ marginTop: theme.spacing.md }}>
          <Button
            label="View changes"
            variant="ghost"
            onPress={onViewChanges}
            testID="session-switching-view-changes"
          />
        </Row>
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
     * visible - the same stacking contest SessionEndedState documents. Raising
     * a pane's zIndex without raising this one puts the live frame back on top
     * and this overlay bleeds through the gaps.
     */
    zIndex: 2,
  },
  /**
   * The last frame stays readable underneath. A scrim, not a curtain: the
   * point is that the session view is still there and is about to repaint.
   * Opacity lives HERE, on the background layer alone, so the title, caption
   * and button above it keep full contrast.
   */
  scrim: {
    opacity: 0.92,
  },
  content: {
    alignItems: 'center',
    paddingHorizontal: 32,
  },
  caption: {
    textAlign: 'center',
  },
});
