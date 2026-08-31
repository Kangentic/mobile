import React from 'react';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { getRetentionProbeVariant } from './retentionProbe';

/**
 * How many extra clean mappers each feed row mounts under the `extra-mappers`
 * probe variant. Eight rows on the Agents list therefore add ~64 registered
 * (never dirty) mappers - a large enough load that if idle CPU tracks the count
 * of REGISTERED mappers at all, it moves; if `mapperRun()` genuinely skips
 * clean mappers for free, it does not.
 */
const EXTRA_MAPPERS_PER_ROW = 8;

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
 * Gated exactly like the rest of `retentionProbe.ts`: `getRetentionProbeVariant`
 * returns `'off'` unless the build was dispatched with the probe flag, so this
 * renders nothing (and its mapper-mounting children never mount) in any shipped
 * build.
 */
export function MapperLoad(): React.JSX.Element | null {
  if (getRetentionProbeVariant() !== 'extra-mappers') return null;
  return (
    <>
      {Array.from({ length: EXTRA_MAPPERS_PER_ROW }, (_unused, index) => (
        <MapperUnit key={index} />
      ))}
    </>
  );
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
  return <Animated.View pointerEvents="none" style={[{ height: 0, position: 'absolute', width: 0 }, style]} />;
}
