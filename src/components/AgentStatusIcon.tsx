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
import Svg, { Circle, G, Path, Rect } from 'react-native-svg';
import {
  ACTIVITY_STROKE_LINECAP,
  ACTIVITY_STROKE_LINEJOIN,
  ACTIVITY_STROKE_WIDTH,
  ACTIVITY_VIEW_BOX,
  activityMarks,
  type ActivityCircleShape,
  type ActivityMark,
  type ActivityMarkName,
} from '@/brand/activityMarks.generated';
import { spinMatrixAboutPoint } from '@/lib/activitySpin';
import { useTheme } from './theme/ThemeProvider';

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
 *
 * The spin drives the GROUP rather than the circle, because react-native-svg's
 * Fabric group takes its transform as a `matrix` prop and Reanimated writes
 * straight to the shadow node. See src/lib/activitySpin.ts for why a `rotation`
 * prop would silently do nothing.
 */
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/**
 * `matrix` is the group's NATIVE transform prop on the New Architecture, but
 * react-native-svg's public GProps exposes only the JS-side conveniences
 * (`rotation`, `originX`, ...) that it folds into that matrix AT RENDER TIME.
 * Reanimated writes animated props straight to the shadow node, so the native
 * name is the one that has to be declared here for the ring to move at all.
 *
 * The alternative is createAnimatedComponent's `jsProps` option, which routes
 * every frame back through setNativeProps on the JS thread. That is exactly the
 * hop a composited transform exists to avoid, so this widening is the cheap
 * path rather than the clever one.
 */
type SpinningGroupProps = React.ComponentProps<typeof G> & { matrix?: readonly number[] };
const SpinningGroup: React.ComponentType<SpinningGroupProps> = G;
const AnimatedGroup = Animated.createAnimatedComponent(SpinningGroup);

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

  // The spin turns the dashed outline about ITS OWN centre, in user units:
  // react-native-svg has no CSS transform-origin, and taking the viewBox centre
  // instead would swing an off-centre mark around the grid rather than spin it
  // in place. Resolved out here because useAnimatedProps runs before the shape
  // map below, which is the only other place cx/cy is in scope.
  const spinOrigin = mark.shapes.find(
    (shape): shape is ActivityCircleShape => shape.kind === 'circle' && shape.dash !== undefined,
  );
  const spinCenterX = spinOrigin?.cx ?? DOT_CENTER_X;
  const spinCenterY = spinOrigin?.cy ?? DOT_CENTER_Y;

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
  const spinProps = useAnimatedProps(() => ({
    matrix: spinMatrixAboutPoint(spinTurns.get(), spinCenterX, spinCenterY),
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
        const moving = marching || spinning;
        const dashArray = mark.restRendering === 'drop-dash' && !moving ? undefined : [...shape.dash];
        if (!moving) {
          return <Circle key={key} cx={shape.cx} cy={shape.cy} r={shape.r} strokeDasharray={dashArray} />;
        }
        if (spinning) {
          // The group turns; the circle inside it is plain, because the dash
          // itself never changes. Rendered ONLY on this branch, so a rebind to
          // the envelope unmounts the transform rather than freezing it - see
          // the docblock, this is the tilted-envelope bug's exact shape.
          return (
            <AnimatedGroup key={key} animatedProps={spinProps}>
              <Circle cx={shape.cx} cy={shape.cy} r={shape.r} strokeDasharray={dashArray} />
            </AnimatedGroup>
          );
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
