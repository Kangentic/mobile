import React, { useEffect } from 'react';
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
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
  type ActivityMark,
  type ActivityMarkName,
  type ActivityShape,
} from '@/brand/activityMarks.generated';

/**
 * The drawing half of the activity marks, shared by `AgentStatusIcon` (the
 * agent's ring and envelope) and `ActivityMarkIcon` (the Command Terminal
 * marks and the stop control). Moved out of AgentStatusIcon unchanged apart
 * from two additions the stop control needed: a filled shape, and drawing only
 * one LAYER of a mark (its still shapes, or its moving ones).
 */

/** One full turn, so `spinTurns` (0..1 per pass) reads as degrees for the view transform. */
const FULL_TURN_DEGREES = 360;

/**
 * The motion animates on a real node, so the shapes have to be addressable.
 * That is why the marks compose <Circle>/<Path>/<Rect> from the generated
 * shape data instead of inlining XML through SvgXml the way Brandmark does: a
 * prop cannot be animated inside an XML blob.
 */
const AnimatedCircle = Animated.createAnimatedComponent(Circle);

/** Which of a mark's shapes to draw: all of them, only the ones its motion holds still, or only the ones it moves. */
export type MarkLayer = 'all' | 'still' | 'moving';

/**
 * Everything the mark's <Svg> needs to draw itself, independent of whether it
 * animates. Passed to `renderMarkSvg` by the static branch and by the marching
 * child alike, so the two paths cannot diverge.
 */
export interface MarkSvgParams {
  mark: ActivityMark;
  markName: ActivityMarkName;
  size: number;
  color: string;
  testID: string | undefined;
  /** True on the spinning branch, so the dashed ring draws plain (the turn is a wrapper transform). */
  spinning: boolean;
  /** True on the marching branch, so the dashed ring takes the animated dash-offset props below. */
  marching: boolean;
  /** The animated `strokeDashoffset` props, only supplied by the marching child. */
  marchAnimatedProps?: ReturnType<typeof useAnimatedProps>;
  /** Defaults to every shape. */
  layer?: MarkLayer;
}

function inLayer(shape: ActivityShape, layer: MarkLayer): boolean {
  if (layer === 'all') return true;
  return layer === 'moving' ? shape.moving === true : shape.moving !== true;
}

/**
 * Pure renderer for a mark's <Svg>. No Reanimated hooks live here, so the
 * common branch (idle envelope, reduced motion, a blurred screen) renders the
 * mark with ZERO animated mappers registered. On Reanimated 4.5.1 that was a
 * CPU matter: its per-vsync flush walked every registered mapper, and 64 clean
 * ones took the Agents list from ~41% to ~70% (~0.47 points each, release
 * build). 4.7.1 removed that loop and the same 64 measure free (task #102).
 * The animated variants still mount their hooks ONLY on the branch that
 * animates, because a mapper's writes outlive a FlashList recycle and a dirty
 * one runs every frame (motion-conventions.md).
 */
export function renderMarkSvg({
  mark,
  markName,
  size,
  color,
  testID,
  spinning,
  marching,
  marchAnimatedProps,
  layer = 'all',
}: MarkSvgParams): React.JSX.Element {
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
        if (!inLayer(shape, layer)) return null;
        const key = `${markName}-${shapeIndex}`;
        if (shape.kind === 'rect') {
          // The stop control's square is solid, not outlined.
          return shape.filled === true ? (
            <Rect key={key} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} fill="currentColor" stroke="none" />
          ) : (
            <Rect key={key} x={shape.x} y={shape.y} width={shape.width} height={shape.height} rx={shape.rx} />
          );
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
 *   1. a static mark registers ZERO animated mappers (the whole point of the
 *      split - see renderMarkSvg's note), and
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
 * composited natively. Rotating a whole <Svg> is exact rather than approximate
 * because every spinning outline is a circle at its viewBox centre, asserted in
 * tests/unit/activityMarks.test.ts.
 */
export function SpinningMark({ size, durationMs, children }: { size: number; durationMs: number; children: React.ReactNode }): React.JSX.Element {
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
