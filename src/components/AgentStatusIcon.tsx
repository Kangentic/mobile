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
 * BOTH primitives are implemented because both are allowlisted upstream in
 * scripts/syncBranding.mjs: a mark declares either a `march` (its dash offset
 * travels) or a `spin` (a transform turns), never both, and the generator's
 * whole contract is that a motion it accepts is one this component draws. The
 * two synced marks select spin and nothing today, so the march branch is
 * currently unexercised - kept rather than deleted so re-selecting it upstream
 * is a data change instead of a broken build.
 *
 * NO RECYCLING RESET IS NEEDED, and that is a property of the shapes rather
 * than luck. The working ring and the idle envelope are DISJOINT element trees,
 * so when FlashList rebinds a row from working to idle the animated node
 * unmounts and there is nothing left behind to reset.
 *
 * Read that carefully, because a rotation is exactly what broke here once. The
 * spin below is NOT the transform of commit e4e5524: that one lived on the
 * wrapper view SHARED by both branches, and because Reanimated writes straight
 * to the native node, React's prop diff never cleared it - a cancelled spin
 * froze mid-rotation and the envelope rendered tilted. This transform lives on
 * a <G> rendered only inside the working branch, keyed by mark name, so it has
 * no existence at all once the row rebinds. Keep it there. If a future change
 * ever hoists it to the shared <Svg> root, or morphs ONE shared element between
 * the two states, that bug comes back and the reset has to come back with it.
 */
export function AgentStatusIcon({ kind, size = 16, testID }: AgentStatusIconProps): React.JSX.Element {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const dashOffset = useSharedValue(0);
  const spinTurns = useSharedValue(0);

  const markName = MARK_BY_KIND[kind];
  const mark: ActivityMark = activityMarks[markName];
  const march = mark.march;
  const spin = mark.spin;
  // Below the mark's legibility floor this renders a dot, which has no outline
  // to move. Gate the animation on that too: the early return further down
  // cannot, since hooks run before it, and an infinite timing loop driving a
  // value nothing reads is pure cost on a list of recycled rows.
  const belowFloor = size < mark.minPx;
  const marching = !reducedMotion && !belowFloor && march !== undefined;
  const spinning = !reducedMotion && !belowFloor && spin !== undefined;

  // NOTE: there is no per-mark spin origin any more. The turn is a transform on
  // the wrapping view (see spinStyle below), so it pivots about the view's
  // centre, which is the viewBox centre. Upstream's rule is that same fixed
  // grid centre (activity.css: `.kng-spin { transform-origin: 12px 12px }`), and
  // every spinning mark is drawn there, so the two agree exactly.
  // tests/unit/activityMarks.test.ts asserts that agreement rather than
  // trusting this comment: an off-centre spinning mark would pivot wrongly and
  // must fail the build instead of shipping a wobbling ring.

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

  useEffect(() => {
    if (!spinning || spin === undefined) {
      cancelAnimation(spinTurns);
      spinTurns.set(0);
      return;
    }
    // One pass is one full turn, so the ring lands back where it started and
    // the loop is seamless - the same closure property the march gets from
    // travelling exactly one dash cycle.
    spinTurns.set(0);
    spinTurns.set(
      withRepeat(
        withTiming(1, {
          duration: spin.durationMs,
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
  }, [spinTurns, spin, spinning]);

  const marchProps = useAnimatedProps(() => ({ strokeDashoffset: dashOffset.get() }));
  /**
   * The spin is a TRANSFORM ON A NATIVE VIEW, not an animated SVG prop.
   *
   * It used to drive the `matrix` prop of an <G> through useAnimatedProps,
   * which re-renders react-native-svg on every frame. That was measured at
   * roughly 8 percentage points of CPU per icon: eight spinning rows on the
   * Agents list cost ~63 points, and the app never dropped to an idle frame
   * rate. A view transform is composited natively and costs none of that.
   * `.claude/rules/motion-conventions.md` asks for exactly this.
   *
   * Rotating the whole <Svg> is EXACT here rather than an approximation: the
   * only animated mark, agent-working, is a single circle at the centre of its
   * own viewBox (cx/cy 12 in a 24 grid), so the view's centre and the old
   * per-mark spin origin are the same point. That equivalence is asserted in
   * tests/unit/activityMarks.test.ts. A future off-centre spinning mark would
   * break it, which is why the assertion exists rather than a comment alone.
   */
  const spinStyle = useAnimatedStyle(() => ({
    transform: [{ rotate: `${spinTurns.get() * FULL_TURN_DEGREES}deg` }],
  }));

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

  const markSvg = (
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
        const moving = marching || spinning;
        const dashArray = mark.restRendering === 'drop-dash' && !moving ? undefined : [...shape.dash];
        if (!moving) {
          return <Circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} strokeDasharray={dashArray} />;
        }
        if (spinning) {
          // Plain: the turn belongs to the wrapping Animated.View now, and the
          // dash itself never changes.
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

  if (!spinning) return markSvg;

  // Keyed by mark name and rendered ONLY on the spinning branch, so a row
  // rebinding from working to idle UNMOUNTS the transform instead of leaving a
  // stale one behind. That is the tilted-envelope bug of commit e4e5524: the
  // transform there lived on a wrapper shared by both branches, and because
  // Reanimated writes straight to the native node, React's prop diff never
  // cleared it - a cancelled spin froze mid-rotation and the envelope rendered
  // tilted. The protection is the CONDITIONAL MOUNT, not the transform's shape,
  // so keep this branch exclusive if the animation ever changes again.
  return (
    <Animated.View key={markName} style={[{ width: size, height: size }, spinStyle]}>
      {markSvg}
    </Animated.View>
  );
}
