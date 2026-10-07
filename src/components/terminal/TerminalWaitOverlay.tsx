import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { Text } from '../Text';
import { useTheme } from '../theme/ThemeProvider';
import { useScreenMotionActive } from '../motion/ScreenMotion';
import { WaitCursor } from '../motion/WaitCursor';
import { hasSeed, subscribeChunks } from '@/state/terminalFeed';

/**
 * How long the pane waits before saying the wait is the desktop's. Most opens
 * paint in about half a second (measured on the Pixel, 2026-10-07: medians of
 * 536-766 ms over 18 opens per build), so a fast open never shows it, and a
 * desktop answering in 0.4-3 s (the same day's slow afternoons, desktop task
 * #774) mostly lands before it.
 */
export const TERMINAL_WAIT_CAPTION_AFTER_MS = 3000;

export interface TerminalWaitOverlayProps {
  sessionId: string;
  /** False while the pane is not the visible lens: the cursor holds still, since nothing can see it blink. */
  active: boolean;
}

/**
 * What the terminal pane shows from opening a session until the desktop's
 * first frame paints, so a slow desktop reads as a wait rather than a dead
 * black screen. TerminalPane mounts this only while it waits.
 *
 * The cursor is the swap veil's wait cursor (WaitCursor, which both draw):
 * one cell at the grid's origin, blinking on a JS interval that registers no
 * Reanimated mapper. It holds still under OS reduced motion, while a route
 * covers the screen, while the pane is not the visible lens, and past
 * `terminalWaitCursor.holdAfterMs`.
 *
 * After TERMINAL_WAIT_CAPTION_AFTER_MS, one muted line names who is slow, but
 * only while this session's ring has never been seeded: the seed is the
 * desktop's read-stream answer, so before it the wait really is the desktop's.
 * A seed landing after the caption shows takes it down again. A seeded ring
 * that still paints nothing keeps the cursor and never the caption: its frame
 * is normally one live write away, and a terminal that really is blank is a
 * cursor on an empty grid anyway.
 *
 * Per session: TerminalPane keys this on the session id, so a swap that
 * happens while the pane still waits starts the caption delay and the blink
 * bound over for the successor.
 *
 * Opaque, in the terminal's own background: the grid under it is blank by
 * definition while TerminalPane waits, so the fill hides only xterm's own
 * cursor, which a seed can park anywhere on the grid (seen on the Pixel as a
 * second, hollow cursor halfway down the pane). It passes every touch
 * through, and the pane's own buttons render above it, so the quick keys, the
 * switcher and those buttons stay live under the wait.
 */
export function TerminalWaitOverlay({ sessionId, active }: TerminalWaitOverlayProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const screenMotionActive = useScreenMotionActive();
  const holdAfterMs = theme.motion.terminalWaitCursor.holdAfterMs;
  const [captionVisible, setCaptionVisible] = useState(false);
  const [blinkExpired, setBlinkExpired] = useState(false);

  useEffect(() => {
    const captionTimer = setTimeout(() => {
      if (!hasSeed(sessionId)) setCaptionVisible(true);
    }, TERMINAL_WAIT_CAPTION_AFTER_MS);
    // The desktop answered: whatever the pane still waits for is no longer
    // the desktop's to send, so the caption that says it is comes down.
    const unsubscribeSeed = subscribeChunks(sessionId, (event) => {
      if (event.kind === 'seed') setCaptionVisible(false);
    });
    return () => {
      clearTimeout(captionTimer);
      unsubscribeSeed();
    };
  }, [sessionId]);

  useEffect(() => {
    const holdTimer = setTimeout(() => {
      setBlinkExpired(true);
    }, holdAfterMs);
    return () => {
      clearTimeout(holdTimer);
    };
  }, [holdAfterMs]);

  const blinking = active && screenMotionActive && !reducedMotion && !blinkExpired;

  return (
    <View
      testID="terminal-wait"
      pointerEvents="none"
      style={[styles.fill, { backgroundColor: theme.colors.terminalBackground }]}
      accessible
      accessibilityRole="progressbar"
      accessibilityLabel="Waiting for the desktop to send the terminal"
      accessibilityState={{ busy: true }}
    >
      <WaitCursor testID="terminal-wait-cursor" blinking={blinking} />
      {captionVisible ? (
        <View style={styles.captionBox}>
          <Text testID="terminal-wait-caption" variant="body" color="muted">
            Waiting for desktop
          </Text>
        </View>
      ) : null}
    </View>
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
  captionBox: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
