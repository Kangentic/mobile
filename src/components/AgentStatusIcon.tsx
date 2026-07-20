import React, { useEffect } from 'react';
import Animated, {
  Easing,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { LoaderCircle, Mail } from 'lucide-react-native';
import { useTheme } from './theme/ThemeProvider';

export type AgentStatusKind = 'working' | 'idle-unread' | 'idle';

export interface AgentStatusIconProps {
  kind: AgentStatusKind;
  size?: number;
  testID?: string;
}

const SPIN_DURATION_MS = 1200;

/**
 * Desktop-parity session status: a spinning green loader while the agent
 * thinks (the board's green spinner) and the yellow mail envelope for an
 * idle session (the desktop's idle marker - the turn ended, the user's
 * move). All idle sessions carry the SAME static envelope: they are equal
 * priority, first come first served ('idle-unread' is kept as a semantic
 * kind for testing/telemetry but renders identically). Reduced motion
 * rests the spinner on a static frame.
 */
export function AgentStatusIcon({ kind, size = 16, testID }: AgentStatusIconProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const spinTurns = useSharedValue(0);

  useEffect(() => {
    if (!reducedMotion && kind === 'working') {
      spinTurns.value = 0;
      spinTurns.value = withRepeat(withTiming(1, { duration: SPIN_DURATION_MS, easing: Easing.linear }), -1, false);
      return () => {
        cancelAnimation(spinTurns);
        // List recycling reuses this view for the next row: a cancelled
        // spin must never leave a frozen mid-rotation transform behind
        // (the "tilted envelope" artifact).
        spinTurns.value = 0;
      };
    }
    cancelAnimation(spinTurns);
    spinTurns.value = 0;
  }, [kind, reducedMotion, spinTurns]);

  // Applied on EVERY branch so the reset actually reaches the native view
  // when a recycled row switches from spinner to envelope.
  const spinStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${spinTurns.value * 360}deg` }] }));

  const fallbackTestID =
    kind === 'working' ? 'agent-status-working' : kind === 'idle-unread' ? 'agent-status-idle-unread' : 'agent-status-idle';
  return (
    <Animated.View style={reducedMotion ? undefined : spinStyle} testID={testID ?? fallbackTestID}>
      {kind === 'working' ? (
        <LoaderCircle size={size} color={theme.colors.statusWorking} />
      ) : (
        <Mail size={size} color={theme.colors.warning} />
      )}
    </Animated.View>
  );
}
