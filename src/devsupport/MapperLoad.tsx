import React, { useEffect } from 'react';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { traceConnection } from './connectionTrace';
import { retentionProbeEnabled, useRetentionProbeVariant } from './retentionProbe';

/**
 * How many extra clean mappers each feed row mounts under the `extra-mappers`
 * probe variant. Eight rows on the Agents list therefore add ~64 registered
 * (never dirty) mappers - a large enough load that if idle CPU tracks the count
 * of REGISTERED mappers at all, it moves; if `mapperRun()` genuinely skips
 * clean mappers for free, it does not.
 */
const EXTRA_MAPPERS_PER_ROW = 8;

/** How long a burst of mounts or unmounts settles before its count is logged. */
const MOUNT_REPORT_DEBOUNCE_MS = 500;

/**
 * A RUNTIME probe for the idle-CPU investigation, NOT shippable behaviour.
 *
 * The open question after the Reanimated fast-path flag is whether the residual
 * idle CPU scales with the number of Reanimated mappers merely REGISTERED on a
 * screen (`useAnimatedStyle` registers one per mounted component; the per-frame
 * flush walks the registered set even when nothing animates), or only with the
 * number of DIRTY mappers running a driver. `no-motion` cancels every driver
 * but leaves the mappers registered; this variant adds a large, deliberately
 * inert block of registered mappers on top, so the delta between the two arms
 * isolates the registration cost from the driver cost - measured in ONE process
 * per `.claude/rules/performance-claims-are-measured.md`.
 *
 * It SUBSCRIBES to the variant. It used to read it at render time, so a switch
 * reached only rows that happened to re-render (the feed's rows are memoized):
 * on 2026-10-06 the arm mounted one row's mappers instead of the whole list's,
 * and its CPU reading was meaningless. And it REPORTS what it mounted: every
 * change in the count of mounted units is logged on the connection trace as
 * `mapper-load mounted=N`, so an arm is checked before its CPU is read.
 *
 * Gated exactly like the rest of `retentionProbe.ts`: without the probe flag
 * this is a component that renders nothing and calls no hook, so a shipped
 * build pays for neither the subscription nor the mappers.
 */
export const MapperLoad: () => React.JSX.Element | null = retentionProbeEnabled() ? SubscribedMapperLoad : NoMapperLoad;

function NoMapperLoad(): null {
  return null;
}

function SubscribedMapperLoad(): React.JSX.Element | null {
  const variant = useRetentionProbeVariant();
  if (variant !== 'extra-mappers') return null;
  return (
    <>
      {Array.from({ length: EXTRA_MAPPERS_PER_ROW }, (_unused, index) => (
        <MapperUnit key={index} />
      ))}
    </>
  );
}

let mountedMapperUnits = 0;
let mountReportTimer: ReturnType<typeof setTimeout> | null = null;

function noteMountedMapperUnits(delta: number): void {
  mountedMapperUnits += delta;
  if (mountReportTimer !== null) return;
  mountReportTimer = setTimeout(() => {
    mountReportTimer = null;
    traceConnection('mapper-load', { mounted: mountedMapperUnits });
  }, MOUNT_REPORT_DEBOUNCE_MS);
}

/**
 * One registered-but-clean mapper. The shared value never changes, so the
 * mapper is registered with the UI runtime yet permanently clean - exactly the
 * state an idle-envelope row's dead `spinStyle`/`marchProps` mappers sit in.
 * Zero-sized and non-interactive so it cannot affect layout or hit-testing.
 */
function MapperUnit(): React.JSX.Element {
  const value = useSharedValue(0);
  const style = useAnimatedStyle(() => ({ opacity: value.get() }));
  useEffect(() => {
    noteMountedMapperUnits(1);
    return () => noteMountedMapperUnits(-1);
  }, []);
  return <Animated.View pointerEvents="none" style={[{ height: 0, position: 'absolute', width: 0 }, style]} />;
}
