import React, { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import { CirclePause, LoaderCircle } from 'lucide-react-native';
import type { SessionUsageWire } from '@kangentic/protocol';
import { ContextUsageBar, Row, Text, useTheme } from '@/components';
import { useScreenMotionActive } from '@/components/motion/ScreenMotion';
import type { CardSessionDisplay } from './cardSessionDisplay';

/** The desktop footer's glyph size (lucide Loader2 / CirclePause at 12). */
const STATUS_GLYPH_SIZE = 12;
const FULL_TURN_DEGREES = 360;
/** The desktop's wording, verbatim (TaskCard.tsx's bottom-bar switch). */
const STARTING_AGENT_LABEL = 'Starting agent...';
const QUEUED_LABEL = 'Queued...';
const PAUSED_LABEL = 'Paused';

export interface CardStatusFooterProps {
  display: CardSessionDisplay;
  usage: SessionUsageWire | null;
  /** The card's testID: the usage bar keys off it as `-usage`, a status bar as `-status-bar`. */
  testID: string;
}

/**
 * The task card's footer, a port of the desktop card's bottom-bar switch
 * (kangentic `src/renderer/components/board/TaskCard.tsx`): every state a
 * session can be in between "nothing" and "working" shows here, as faint text
 * beside a 12 dp glyph over an empty track, and nowhere else on the card.
 *
 *   - running, model not reported yet: spinner, "Starting agent..."
 *   - running: the usage bar (model, %, fill), at 0% until the window is known
 *   - preparing (a respawn's step): spinner, the desktop's own step text
 *   - queued: spinner, "Queued..."
 *   - suspended: a still pause circle, "Paused"
 *   - none, exited: nothing
 *
 * Every bar keeps the usage bar's box (a caption row over a 4 dp track), so a
 * card holds one height from queued through running. Returns null when there
 * is no footer, so the card can drop its divider with it.
 *
 * A plain function, not a component: the card needs to know whether a footer
 * exists before it draws the divider above it. It calls no hooks; the bars it
 * returns are components that do.
 */
export function cardStatusFooter({ display, usage, testID }: CardStatusFooterProps): React.JSX.Element | null {
  switch (display.kind) {
    case 'running': {
      // The desktop shows the human model name or nothing: never a raw id.
      const modelName = usage?.model.displayName ?? '';
      if (usage === null || modelName.length === 0) {
        return <StatusBar glyph="spinner" label={STARTING_AGENT_LABEL} testID={`${testID}-status-bar`} />;
      }
      return <ContextUsageBar usage={usage} testID={`${testID}-usage`} />;
    }
    case 'preparing':
      return <StatusBar glyph="spinner" label={display.label} testID={`${testID}-status-bar`} />;
    case 'queued':
      return <StatusBar glyph="spinner" label={QUEUED_LABEL} testID={`${testID}-status-bar`} />;
    case 'suspended':
      return <StatusBar glyph="pause" label={PAUSED_LABEL} testID={`${testID}-status-bar`} />;
    case 'none':
    case 'exited':
      return null;
  }
}

/** The desktop's `CardStatusBar`: a faint label row over an inert, empty track. */
function StatusBar({ glyph, label, testID }: { glyph: 'spinner' | 'pause'; label: string; testID: string }): React.JSX.Element {
  const theme = useTheme();
  const glyphColor = theme.colors.textMuted;
  return (
    <View testID={testID}>
      <Row gap="xs" style={styles.labelRow}>
        {glyph === 'spinner' ? (
          <FooterSpinner color={glyphColor} testID={`${testID}-spinner`} />
        ) : (
          // The testID rides a wrapping View: lucide forwards `testID` as the
          // web-only `data-testid`, which neither RNTL nor Maestro can select.
          <View testID={`${testID}-paused`}>
            <CirclePause size={STATUS_GLYPH_SIZE} color={glyphColor} />
          </View>
        )}
        <Text variant="caption" color="muted" numberOfLines={1} style={styles.label} testID={`${testID}-label`}>
          {label}
        </Text>
      </Row>
      <View style={[styles.track, { backgroundColor: theme.colors.border, marginTop: theme.spacing.xs }]} />
    </View>
  );
}

/**
 * The footer's spinner. It spins only where motion is allowed (OS reduced
 * motion off, the screen focused), which the desktop's does not check; it
 * holds still otherwise. The spinning wrapper is its own component, mounted
 * only on that branch, so a still spinner registers no Reanimated mapper and a
 * recycled row never keeps a stale angle (motion-conventions.md).
 */
function FooterSpinner({ color, testID }: { color: string; testID: string }): React.JSX.Element {
  const reducedMotion = useReducedMotion();
  const screenMotionActive = useScreenMotionActive();
  const glyph = <LoaderCircle size={STATUS_GLYPH_SIZE} color={color} />;
  if (reducedMotion || !screenMotionActive) {
    return <View testID={testID}>{glyph}</View>;
  }
  return <SpinningGlyph testID={testID}>{glyph}</SpinningGlyph>;
}

/** One linear turn per `statusSpinner.turnMs`, as a transform on a native view (never an SVG prop). */
function SpinningGlyph({ testID, children }: { testID: string; children: React.ReactNode }): React.JSX.Element {
  const theme = useTheme();
  const turnMs = theme.motion.statusSpinner.turnMs;
  const spinTurns = useSharedValue(0);
  useEffect(() => {
    spinTurns.set(0);
    spinTurns.set(
      withRepeat(withTiming(1, { duration: turnMs, easing: Easing.linear, reduceMotion: ReduceMotion.System }), -1, false),
    );
    return () => {
      cancelAnimation(spinTurns);
    };
  }, [spinTurns, turnMs]);
  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spinTurns.get() * FULL_TURN_DEGREES}deg` }],
  }));
  return (
    <Animated.View testID={testID} style={[styles.glyphBox, spinStyle]}>
      {children}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  labelRow: {
    alignItems: 'center',
  },
  label: {
    flexShrink: 1,
  },
  track: {
    height: 4,
    borderRadius: 2,
  },
  glyphBox: {
    width: STATUS_GLYPH_SIZE,
    height: STATUS_GLYPH_SIZE,
  },
});
