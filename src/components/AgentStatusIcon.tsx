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
const PULSE_DURATION_MS = 900;

/**
 * Desktop-parity session status: a spinning green loader while the agent
 * thinks (the board's green spinner) and the yellow mail envelope for an
 * idle session (the desktop's idle marker - the turn ended, the user's
 * move). Unread results make the envelope pulse. Reduced motion rests
 * both animations on a static frame.
 */
export function AgentStatusIcon({ kind, size = 16, testID }: AgentStatusIconProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const spinTurns = useSharedValue(0);
  const pulseOpacity = useSharedValue(1);

  useEffect(() => {
    if (reducedMotion) return;
    if (kind === 'working') {
      spinTurns.value = 0;
      spinTurns.value = withRepeat(withTiming(1, { duration: SPIN_DURATION_MS, easing: Easing.linear }), -1, false);
    }
    if (kind === 'idle-unread') {
      pulseOpacity.value = withRepeat(withTiming(0.45, { duration: PULSE_DURATION_MS, easing: Easing.inOut(Easing.quad) }), -1, true);
    }
    return () => {
      cancelAnimation(spinTurns);
      cancelAnimation(pulseOpacity);
    };
  }, [kind, reducedMotion, spinTurns, pulseOpacity]);

  const spinStyle = useAnimatedStyle(() => ({ transform: [{ rotate: `${spinTurns.value * 360}deg` }] }));
  const pulseStyle = useAnimatedStyle(() => ({ opacity: pulseOpacity.value }));

  if (kind === 'working') {
    return (
      <Animated.View style={reducedMotion ? undefined : spinStyle} testID={testID ?? 'agent-status-working'}>
        <LoaderCircle size={size} color={theme.colors.statusWorking} />
      </Animated.View>
    );
  }
  if (kind === 'idle-unread') {
    return (
      <Animated.View style={reducedMotion ? undefined : pulseStyle} testID={testID ?? 'agent-status-idle-unread'}>
        <Mail size={size} color={theme.colors.warning} />
      </Animated.View>
    );
  }
  return (
    <Animated.View testID={testID ?? 'agent-status-idle'}>
      <Mail size={size} color={theme.colors.warning} />
    </Animated.View>
  );
}
