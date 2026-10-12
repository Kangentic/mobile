import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useReducedMotion } from 'react-native-reanimated';
import { activityMarks, type ActivityMarkName } from '@/brand/activityMarks.generated';
import { SpinningMark, renderMarkSvg } from './activityMarkRendering';
import { useScreenMotionActive } from './motion/ScreenMotion';
import { useTheme } from './theme/ThemeProvider';

/**
 * A mark's tone: the three the branding manifest names (activity.json `tones`),
 * the working hue, the needs-you hue and the surface's muted foreground (a
 * button at rest, like the "new terminal" mark), plus the phone's own
 * `danger`, for the stop mark leading a destructive sheet row ("Stop
 * terminal"), which takes the row's colour as Delete's trash glyph does.
 */
export type ActivityMarkTone = 'working' | 'needs-you' | 'rest' | 'danger';

function colorForTone(tone: ActivityMarkTone, colors: ReturnType<typeof useTheme>['colors']): string {
  switch (tone) {
    case 'working':
      return colors.statusWorking;
    case 'needs-you':
      return colors.statusNeedsYou;
    case 'rest':
      return colors.textSecondary;
    case 'danger':
      return colors.danger;
  }
}

/** The marks this component draws: everything but the agent's own, which AgentStatusIcon owns. */
export type CommandTerminalMarkName = Exclude<ActivityMarkName, 'agent-idle' | 'agent-working'>;

export interface ActivityMarkIconProps {
  mark: CommandTerminalMarkName;
  tone: ActivityMarkTone;
  size?: number;
  testID?: string;
}

/**
 * The Command Terminal surfaces' branding marks (task #113): the terminal
 * silhouette (`terminal-idle`, drawn static in either tone, see
 * syncBranding.mjs for why there is no blink), the "new terminal" mark, and
 * the desktop's stop control, whose ring spins green while the terminal works
 * and rests amber when it needs you (CommandTerminalWindow.tsx's `stopGlyph`).
 *
 * The stop control is the one mark here whose motion moves only PART of it:
 * the ring turns and the square holds still. So it draws in two layers, the
 * still shapes under a spinning wrapper that holds only the moving ones,
 * instead of turning the whole <Svg> as AgentStatusIcon does for its lone ring.
 * The spin, like the agent's, mounts only on the branch that animates: reduced
 * motion, a screen out of focus, or a static mark registers no mapper at all.
 */
export function ActivityMarkIcon({ mark: markName, tone, size = 16, testID }: ActivityMarkIconProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const screenMotionActive = useScreenMotionActive();
  const mark = activityMarks[markName];
  const color = colorForTone(tone, theme.colors);
  const spin = mark.spin;
  const spinning = spin !== undefined && !reducedMotion && screenMotionActive;

  if (spinning) {
    return (
      <View style={{ width: size, height: size }} testID={testID}>
        <View style={StyleSheet.absoluteFill}>
          {renderMarkSvg({ mark, markName, size, color, testID: undefined, spinning: true, marching: false, layer: 'still' })}
        </View>
        <SpinningMark key={markName} size={size} durationMs={spin.durationMs}>
          {renderMarkSvg({ mark, markName, size, color, testID: undefined, spinning: true, marching: false, layer: 'moving' })}
        </SpinningMark>
      </View>
    );
  }
  return renderMarkSvg({ mark, markName, size, color, testID, spinning: false, marching: false });
}
