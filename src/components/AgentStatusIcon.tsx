import React, { useEffect } from 'react';
import {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedProps,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';
import Svg, { Circle } from 'react-native-svg';
import { ACTIVITY_VIEW_BOX, activityMarks, type ActivityMark, type ActivityMarkName } from '@/brand/activityMarks.generated';
import { SpinningMark, renderMarkSvg } from './activityMarkRendering';
import { useScreenMotionActive } from './motion/ScreenMotion';
import { useTheme } from './theme/ThemeProvider';

export type AgentStatusKind = 'working' | 'idle-unread' | 'idle';

export interface AgentStatusIconProps {
  kind: AgentStatusKind;
  size?: number;
  testID?: string;
  /**
   * Draws the mark without its motion, through the hookless static path: for a
   * LEGEND (the Show sections sheet's rows), where the glyph names a section
   * rather than reporting a live session, so a spin would only hold a
   * Reanimated mapper and keep the app drawing frames while the sheet is open.
   */
  still?: boolean;
}

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
 * The testID a caller gets when it passes none. A `Record` like the mark map
 * above rather than a ternary chain, so a fifth kind fails the build here
 * instead of silently falling through to the idle id.
 */
const FALLBACK_TESTID_BY_KIND: Record<AgentStatusKind, string> = {
  working: 'agent-status-working',
  'idle-unread': 'agent-status-idle-unread',
  idle: 'agent-status-idle',
};

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
 * marks: a green ring that SPINS while the agent thinks, and the amber
 * envelope for an idle session (the turn ended, the user's move). All idle
 * sessions carry the SAME static envelope: they are equal priority, first come
 * first served ('idle-unread' is kept as a semantic kind for testing/telemetry
 * but renders identically). A session that is not running (queued, paused,
 * mid-respawn) draws no agent icon at all, as on the desktop: its card footer
 * and the session header say what it is instead.
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
export function AgentStatusIcon({ kind, size = 16, testID, still = false }: AgentStatusIconProps): React.JSX.Element {
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
  const marching = !still && !reducedMotion && screenMotionActive && !belowFloor && march !== undefined;
  const spinning = !still && !reducedMotion && screenMotionActive && !belowFloor && spin !== undefined;

  // Needs-you is amber, the attention hue, everywhere it appears (task #113,
  // H1): the envelope used to borrow the caution yellow, which put two
  // attention colours side by side on one card beside the amber wait time.
  // statusNeedsYou rather than accent so a project accent cannot re-point it.
  const color = kind === 'working' ? theme.colors.statusWorking : theme.colors.statusNeedsYou;
  const resolvedTestID = testID ?? FALLBACK_TESTID_BY_KIND[kind];

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

  // Idle envelope, reduced motion, a blurred screen, a legend: static, no animated hooks.
  return renderMarkSvg({ mark, markName, size, color, testID: resolvedTestID, spinning: false, marching: false });
}
