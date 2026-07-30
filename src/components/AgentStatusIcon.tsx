import React, { useEffect } from 'react';
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle, Path, Rect } from 'react-native-svg';
import {
  ACTIVITY_STROKE_LINECAP,
  ACTIVITY_STROKE_LINEJOIN,
  ACTIVITY_STROKE_WIDTH,
  ACTIVITY_VIEW_BOX,
  activityMarks,
  type ActivityMark,
  type ActivityMarkName,
} from '@/brand/activityMarks.generated';
import { useTheme } from './theme/ThemeProvider';

export type AgentStatusKind = 'working' | 'idle-unread' | 'idle';

export interface AgentStatusIconProps {
  kind: AgentStatusKind;
  size?: number;
  testID?: string;
}

/**
 * The dash offset animates on a real node, so the circle has to be addressable.
 * That is why this component composes <Circle>/<Path>/<Rect> from the generated
 * shape data instead of inlining XML through SvgXml the way Brandmark does: a
 * prop cannot be animated inside an XML blob.
 */
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * The below-floor dot, in the marks' own viewBox units. Its centre is derived
 * from the generated grid rather than written as 12, so it stays centred if the
 * grid ever moves upstream. The radius is a chosen weight: a quarter of the
 * 18-unit indicator slot, which reads as a dot rather than as a shrunken ring.
 */
const [, , ACTIVITY_GRID_WIDTH, ACTIVITY_GRID_HEIGHT] = ACTIVITY_VIEW_BOX.split(' ').map(Number);
const DOT_CENTER_X = ACTIVITY_GRID_WIDTH / 2;
const DOT_CENTER_Y = ACTIVITY_GRID_HEIGHT / 2;
const DOT_RADIUS_UNITS = 3;

const MARK_BY_KIND: Record<AgentStatusKind, ActivityMarkName> = {
  working: 'agent-working',
  'idle-unread': 'agent-idle',
  idle: 'agent-idle',
};

/**
 * Desktop-parity session status, drawn from @kangentic/branding's activity
 * marks: a green ring that MARCHES while the agent thinks, and the yellow
 * envelope for an idle session (the turn ended, the user's move). All idle
 * sessions carry the SAME static envelope: they are equal priority, first come
 * first served ('idle-unread' is kept as a semantic kind for testing/telemetry
 * but renders identically).
 *
 * The geometry, the 1400ms march and the reduced-motion rendering all arrive as
 * generated data, so none of them can drift from the assets the desktop and the
 * website draw. Do not hardcode a duration or a dash here.
 *
 * NO RECYCLING RESET IS NEEDED, and that is a property of the shapes rather
 * than luck. The working ring and the idle envelope are DISJOINT element trees,
 * so when FlashList rebinds a row from working to idle the animated node
 * unmounts and there is nothing left behind to reset. The rotation transform
 * this replaced did need one - it lived on the shared wrapper view, so a
 * cancelled spin froze mid-rotation and the envelope rendered tilted (commit
 * e4e5524). If a future change ever morphs ONE shared element between the two
 * states, that bug comes back and the reset has to come back with it.
 */
export function AgentStatusIcon({ kind, size = 16, testID }: AgentStatusIconProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const dashOffset = useSharedValue(0);

  const markName = MARK_BY_KIND[kind];
  const mark: ActivityMark = activityMarks[markName];
  const march = mark.march;
  // Below the mark's legibility floor this renders a dot, which has no outline
  // to march. Gate the animation on that too: the early return further down
  // cannot, since hooks run before it, and an infinite timing loop driving a
  // value nothing reads is pure cost on a list of recycled rows.
  const belowFloor = size < mark.minPx;
  const marching = !reducedMotion && !belowFloor && march !== undefined;

  useEffect(() => {
    if (!marching || march === undefined) {
      cancelAnimation(dashOffset);
      dashOffset.set(0);
      return;
    }
    // One pass walks the dash a full cycle, so the outline lands back where it
    // started and the loop is seamless. The period is the user-unit dash sum,
    // not the pathLength ratio: react-native-svg ignores pathLength.
    dashOffset.set(0);
    dashOffset.set(
      withRepeat(
        withTiming(-march.periodUserUnits, {
          duration: march.durationMs,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.System,
        }),
        -1,
        false,
      ),
    );
    return () => {
      cancelAnimation(dashOffset);
    };
  }, [dashOffset, march, marching]);

  const marchProps = useAnimatedProps(() => ({ strokeDashoffset: dashOffset.get() }));

  const color = kind === 'working' ? theme.colors.statusWorking : theme.colors.warning;
  const fallbackTestID =
    kind === 'working' ? 'agent-status-working' : kind === 'idle-unread' ? 'agent-status-idle-unread' : 'agent-status-idle';
  const resolvedTestID = testID ?? fallbackTestID;

  // Below the mark's legibility floor a 2px stroke on a 24 grid falls under one
  // device pixel and the glyph turns to mush, so the contract says draw a dot
  // instead. No caller is below the floor today (they render at 15 and 16).
  if (belowFloor) {
    return (
      <Svg width={size} height={size} viewBox={ACTIVITY_VIEW_BOX} color={color} testID={resolvedTestID}>
        <Circle cx={DOT_CENTER_X} cy={DOT_CENTER_Y} r={DOT_RADIUS_UNITS} fill="currentColor" />
      </Svg>
    );
  }

  return (
    // `color` is what resolves the marks' `currentColor`, so the tone stays a
    // theme token and no hex ever reaches this file. The manifest labels
    // agent-idle's tone "attention" (this app's needs-you token is brand
    // amber), but that is advisory: the package publishes #3ddc84/#d9b83f as
    // the mobile pair, and tokens.ts's two-hue rule forbids pointing a warning
    // role back at amber. So the working/warning pair below is deliberate.
    <Svg
      width={size}
      height={size}
      viewBox={ACTIVITY_VIEW_BOX}
      color={color}
      fill="none"
      stroke="currentColor"
      strokeWidth={ACTIVITY_STROKE_WIDTH}
      strokeLinecap={ACTIVITY_STROKE_LINECAP}
      strokeLinejoin={ACTIVITY_STROKE_LINEJOIN}
      testID={resolvedTestID}
    >
      {mark.shapes.map((shape, shapeIndex) => {
        const key = `${markName}-${shapeIndex}`;
        if (shape.kind === 'rect') {
          return <Rect key={key} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} />;
        }
        if (shape.kind === 'path') {
          return <Path key={key} d={shape.d} />;
        }
        if (shape.dash === undefined) {
          return <Circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} />;
        }
        // Reduced motion is a RENDERING, not a mute button: 'keep-dash' rests
        // holding its arc rather than closing into a solid ring, 'drop-dash'
        // sheds the dash because a frozen partial outline reads as torn.
        const dashArray = mark.restRendering === 'drop-dash' && !marching ? undefined : [...shape.dash];
        if (!marching) {
          return <Circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} strokeDasharray={dashArray} />;
        }
        return (
          <AnimatedCircle
            key={key}
            cx={shape.cx}
            cy={shape.cy}
            r={shape.r}
            strokeDasharray={dashArray}
            animatedProps={marchProps}
          />
        );
      })}
    </Svg>
  );
}
