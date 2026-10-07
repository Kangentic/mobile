import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { BlinkingBlock } from './BlinkingBlock';

export interface WaitCursorProps {
  testID: string;
  /**
   * True mounts the blink; false holds the cursor still at the blink's mid
   * opacity. The caller owns every gate (OS reduced motion, the screen motion
   * gate, its own bound), so this registers nothing on the still branch.
   */
  blinking: boolean;
}

/**
 * The terminal's wait cursor: one cell at the grid's origin in
 * `textSecondary`, blinking on `waitCursorBlink` through `BlinkingBlock`, a
 * two-state toggle on a JS interval that registers no Reanimated mapper (see
 * BlinkingBlock for why). The swap veil (SessionSwapVeil.tsx) and the
 * terminal pane's own wait (TerminalWaitOverlay.tsx) both draw it, so the two
 * waits show the same cursor.
 */
export function WaitCursor({ testID, blinking }: WaitCursorProps): React.JSX.Element {
  const theme = useTheme();
  const cursorBlink = theme.motion.waitCursorBlink;
  const cursorStyle = {
    ...styles.cursor,
    left: theme.spacing.sm,
    top: theme.spacing.sm,
    width: theme.spacing.sm,
    height: theme.spacing.lg,
    backgroundColor: theme.colors.textSecondary,
  };

  if (blinking) {
    return (
      <BlinkingBlock
        testID={testID}
        baseStyle={cursorStyle}
        intervalMs={cursorBlink.intervalMs}
        opacityMin={cursorBlink.opacityMin}
        opacityMax={cursorBlink.opacityMax}
      />
    );
  }
  return (
    <View
      testID={testID}
      pointerEvents="none"
      style={[cursorStyle, { opacity: (cursorBlink.opacityMin + cursorBlink.opacityMax) / 2 }]}
    />
  );
}

const styles = StyleSheet.create({
  cursor: {
    position: 'absolute',
  },
});
