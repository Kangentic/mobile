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
    if (reducedMotion || kind !== 'working') return;
    spinTurns.value = 0;
    spinTurns.value = withRepeat(withTiming(1, { duration: SPIN_DURATION_MS, easing: Easing.linear }), -1, false);
    return () => {
      cancelAnimation(spinTurns);
    };
  }, [kind, reducedMotion, spinTurns]);

  const spinStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${spinTurns.value * 360}deg` }] }));

  if (kind === 'working') {
    return (
      <Animated.View style={reducedMotion ? undefined : spinStyle} testID={testID ?? 'agent-status-working'}>
        <LoaderCircle size={size} color={theme.colors.statusWorking} />
      </Animated.View>
    );
  }
  return (
    <Animated.View testID={testID ?? (kind === 'idle-unread' ? 'agent-status-idle-unread' : 'agent-status-idle')}>
      <Mail size={size} color={theme.colors.warning} />
    </Animated.View>
  );
}
