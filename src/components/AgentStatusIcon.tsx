import React, { useEffect } from 'react';
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
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
import { useScreenMotionActive } from './motion/ScreenMotion';
import { useTheme } from './theme/ThemeProvider';

/** One full turn, so `spinTurns` (0..1 per pass) reads as degrees for the view transform. */
const FULL_TURN_DEGREES = 360;

export type AgentStatusKind = 'working' | 'idle-unread' | 'idle';

export interface AgentStatusIconProps {
  kind: AgentStatusKind;
  size?: number;
  testID?: string;
}

/**
 * The motion animates on a real node, so the shapes have to be addressable.
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
 * Everything the mark's <Svg> needs to draw itself, independent of whether it
 * animates. Passed to `renderMarkSvg` by the static branch and by the marching
 * child alike, so the two paths cannot diverge.
 */
interface MarkSvgParams {
  mark: ActivityMark;
  markName: ActivityMarkName;
  size: number;
  color: string;
  testID: string;
  /** True on the spinning branch, so the dashed ring draws plain (the turn is a wrapper transform). */
  spinning: boolean;
  /** True on the marching branch, so the dashed ring takes the animated dash-offset props below. */
  marching: boolean;
  /** The animated `strokeDashoffset` props, only supplied by the marching child. */
  marchAnimatedProps?: ReturnType<typeof useAnimatedProps>;
}

/**
 * Pure renderer for a mark's <Svg>. No Reanimated hooks live here, so the
 * common branch (idle envelope, reduced motion, a blurred screen) renders the
 * mark with ZERO animated mappers registered - which matters because the
 * per-vsync mapper flush walks every registered mapper whether or not it is
 * dirty. Measured on a release build, Pixel 11 Pro: adding 64 clean, never-
 * animating mappers to the Agents list took idle CPU from ~41% to ~70% (~0.47
 * points per registered mapper), so an idle row that used to register a dead
 * `useAnimatedProps` and a dead `useAnimatedStyle` was paying for both. The
 * animated variants below mount their hooks ONLY on the branch that animates.
 */
function renderMarkSvg({ mark, markName, size, color, testID, spinning, marching, marchAnimatedProps }: MarkSvgParams): React.JSX.Element {
  return (
    // `color` is what resolves the marks' `currentColor`, so the tone stays a
    // theme token and no hex ever reaches this file.
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
      testID={testID}
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
        const moving = marching || spinning;
        const dashArray = mark.restRendering === 'drop-dash' && !moving ? undefined : [...shape.dash];
        if (!moving) {
          return <Circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} strokeDasharray={dashArray} />;
        }
        if (spinning) {
          // Plain: the turn belongs to the wrapping Animated.View, and the dash
          // itself never changes.
          return <Circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} strokeDasharray={dashArray} />;
        }
        return (
          <AnimatedCircle
            key={key}
            cx={shape.cx}
            cy={shape.cy}
            r={shape.r}
            strokeDasharray={dashArray}
            animatedProps={marchAnimatedProps}
          />
        );
      })}
    </Svg>
  );
}

/**
 * The spinning wrapper. Owns the spin shared value, its driver effect, and the
 * transform - and is rendered ONLY on the spinning branch, so:
 *
 *   1. an idle-envelope row registers ZERO animated mappers (the whole point of
 *      the split - see renderMarkSvg's note), and
 *   2. a FlashList rebind from working to idle UNMOUNTS this wrapper rather than
 *      leaving a stale rotation behind. Reanimated writes straight to the native
 *      node, so React's prop diff never clears a transform on a node that
 *      survives the rebind - the row would keep whatever angle was last written
 *      and the envelope would render tilted. That is the tilted-envelope bug of
 *      commit e4e5524, and the CONDITIONAL MOUNT is what fixes it, not the
 *      transform's shape. Keep this mounted only while spinning.
 *
 * The turn is a transform on this native view, NOT an animated SVG prop. Driving
 * an SVG group's `matrix` through useAnimatedProps re-renders react-native-svg
 * every frame and was measured at ~8 CPU points per icon; a view transform is
 * composited natively. Rotating the whole <Svg> is exact rather than approximate
 * because agent-working is a single circle at its viewBox centre, asserted in
 * tests/unit/activityMarks.test.ts.
 */
function SpinningMark({ size, durationMs, children }: { size: number; durationMs: number; children: React.ReactNode }): React.JSX.Element {
  const spinTurns = useSharedValue(0);
  useEffect(() => {
    // One pass is one full turn, so the ring lands back where it started and the
    // loop is seamless.
    spinTurns.set(0);
    spinTurns.set(
      withRepeat(
        withTiming(1, {
          duration: durationMs,
          easing: Easing.linear,
          reduceMotion: ReduceMotion.System,
        }),
        -1,
        false,
      ),
    );
    return () => {
      cancelAnimation(spinTurns);
    };
  }, [spinTurns, durationMs]);
  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spinTurns.get() * FULL_TURN_DEGREES}deg` }],
  }));
  return <Animated.View style={[{ width: size, height: size }, spinStyle]}>{children}</Animated.View>;
}

/**
 * The marching wrapper. Owns the dash-offset shared value, its driver effect,
 * and the animated `strokeDashoffset` props, and builds its own <Svg> so the
 * animated circle lives inside it. Rendered ONLY on the marching branch, so a
 * non-marching row registers none of this.
 *
 * Currently unexercised: neither synced mark declares a `march`
 * (activityMarks.generated selects `spin` for agent-working and nothing for
 * agent-idle). Kept correct rather than deleted so re-selecting a march upstream
 * is a data change, not a broken build. A shape that genuinely changes per frame
 * (a dash marching) is the deliberate exception to the transform-only rule - it
 * has to re-run the SVG, and that cost is argued for, not a default.
 */
function MarchingMark({
  mark,
  markName,
  size,
  color,
  testID,
  periodUserUnits,
  durationMs,
}: {
  mark: ActivityMark;
  markName: ActivityMarkName;
  size: number;
  color: string;
  testID: string;
  periodUserUnits: number;
  durationMs: number;
}): React.JSX.Element {
  const dashOffset = useSharedValue(0);
  useEffect(() => {
    // One pass walks the dash a full cycle, so the outline lands back where it
    // started. The period is the user-unit dash sum, not the pathLength ratio:
    // react-native-svg ignores pathLength.
    dashOffset.set(0);
    dashOffset.set(
      withRepeat(
        withTiming(-periodUserUnits, {
          duration: durationMs,
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
  }, [dashOffset, periodUserUnits, durationMs]);
  const marchProps = useAnimatedProps(() => ({ strokeDashoffset: dashOffset.get() }));
  return renderMarkSvg({ mark, markName, size, color, testID, spinning: false, marching: true, marchAnimatedProps: marchProps });
}

/**
 * Desktop-parity session status, drawn from @kangentic/branding's activity
 * marks: a green ring that SPINS while the agent thinks, and the yellow
 * envelope for an idle session (the turn ended, the user's move). All idle
 * sessions carry the SAME static envelope: they are equal priority, first come
 * first served ('idle-unread' is kept as a semantic kind for testing/telemetry
 * but renders identically).
 *
 * The geometry, the 1400ms period and the reduced-motion rendering all arrive
 * as generated data, so none of them can drift from the assets the desktop and
 * the website draw. Do not hardcode a duration or a dash here.
 *
 * The animation, when there is one, lives in a CHILD component
 * (`SpinningMark` / `MarchingMark`) rendered only on the branch that animates.
 * This component itself registers NO Reanimated mappers, so an idle-envelope row
 * - the common case in the feed - costs nothing on the per-vsync mapper flush.
 * That is a measured lever, not a tidy-up: registered-mapper count drives idle
 * CPU on this screen almost linearly (see renderMarkSvg's note and the
 * REACT-NATIVE-5 section of docs/developer-guide.md).
 */
export function AgentStatusIcon({ kind, size = 16, testID }: AgentStatusIconProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const screenMotionActive = useScreenMotionActive();

  const markName = MARK_BY_KIND[kind];
  const mark: ActivityMark = activityMarks[markName];
  const march = mark.march;
  const spin = mark.spin;
  // Below the mark's legibility floor this renders a dot, which has no outline
  // to move. Gate the animation on that too: an infinite timing loop driving a
  // value nothing reads is pure cost on a list of recycled rows.
  const belowFloor = size < mark.minPx;
  /**
   * Blur drops the MOUNT, not just the driver, and the honest reason is
   * correctness rather than a measured saving on the blurred screen itself.
   * Forcing this gate closed on a FOCUSED screen (the probe's `no-motion`
   * variant) takes idle CPU from ~49% to ~40% on a release build, so the loop is
   * worth roughly 9 points while it runs; the blurred-screen before/after (50%
   * vs 47.5%) sat inside the run-to-run spread. Either way, a gated-off row now
   * renders through the hookless static path, so it holds no registered mapper
   * for a view nobody can see.
   */
  const marching = !reducedMotion && screenMotionActive && !belowFloor && march !== undefined;
  const spinning = !reducedMotion && screenMotionActive && !belowFloor && spin !== undefined;

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

  if (spinning && spin !== undefined) {
    // Keyed by mark name so a rebind from one spinning mark to another remounts
    // the wrapper (there is only one spinning mark today, but the key keeps the
    // conditional-mount guarantee explicit). The <Svg> inside is fully static -
    // its dashed ring draws plain and the turn is the wrapper's transform.
    return (
      <SpinningMark key={markName} size={size} durationMs={spin.durationMs}>
        {renderMarkSvg({ mark, markName, size, color, testID: resolvedTestID, spinning: true, marching: false })}
      </SpinningMark>
    );
  }

  if (marching && march !== undefined) {
    return (
      <MarchingMark
        mark={mark}
        markName={markName}
        size={size}
        color={color}
        testID={resolvedTestID}
        periodUserUnits={march.periodUserUnits}
        durationMs={march.durationMs}
      />
    );
  }

  // Idle envelope, reduced motion, a blurred screen: static, no animated hooks.
  return renderMarkSvg({ mark, markName, size, color, testID: resolvedTestID, spinning: false, marching: false });
}
