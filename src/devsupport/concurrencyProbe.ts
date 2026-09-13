import { useSyncExternalStore } from 'react';

/**
 * A RUNTIME switch for the Agents feed's snippet pre-warm depth.
 *
 * WHY A SEPARATE MODULE FROM `retentionProbe.ts`. That probe's variants all
 * target ChatPane and the markdown renderer on the SESSION screen, and they
 * bisect RETENTION - what survives a forced GC. This measures neither: the
 * defect behind Sentry MOBILE-8 is on Home, retains nothing at all, and is peak
 * simultaneous TRANSIENT allocation. Folding a depth knob into a retention
 * variant union would put two unrelated questions behind one control and make
 * the retention probe's "variants are additive, measure a delta over a fresh
 * baseline" contract false for one of its members.
 *
 * WHY A RUNTIME SWITCH AT ALL. `.claude/rules/performance-claims-are-measured.md`
 * requires an A/B to be switched inside ONE process: a release APK embeds its
 * JS bundle, so a rebuild per depth costs an APK each AND compares different
 * installs against different content. That rule was written after exactly that
 * mistake produced a confidently wrong number ("PressScale costs ~19 points",
 * which an in-process swap put at zero).
 *
 * WHAT THIS DELIBERATELY DOES NOT SWEEP: `SUBSCRIBE_FAN_OUT_CONCURRENCY` in
 * `src/channel/subscriptionManager.ts`. Both caps are chosen rather than
 * measured, but an A/B whose two arms differ in more than one thing measures
 * neither, so the fan-out is held fixed while this one moves. Sweeping it wants
 * its own run.
 *
 * Gated exactly like the retention probe and the crash-reporting rig:
 * `EXPO_PUBLIC_*` is inlined at bundle time, so this is inert and
 * dead-code-eliminated in every build not dispatched with the flag on. Never on
 * in a store build.
 */
const probeEnabled = process.env.EXPO_PUBLIC_KANGENTIC_CONCURRENCY_PROBE === '1';

/**
 * The depths offered in Settings.
 *
 * 1 is included on purpose even though nobody would ship it: a fully serial
 * arm is the cleanest possible upper bound on what concurrency costs, and if
 * the delta between 1 and 8 is inside the run-to-run spread then the knee is
 * not here and no depth in between is worth arguing about either.
 */
export const CONCURRENCY_PROBE_DEPTHS = [1, 2, 3, 5, 8] as const;

export type ConcurrencyProbeDepth = (typeof CONCURRENCY_PROBE_DEPTHS)[number];

let activeDepth: ConcurrencyProbeDepth | null = null;
const listeners = new Set<() => void>();

/** True only in a build dispatched with the probe flag on. */
export function concurrencyProbeEnabled(): boolean {
  return probeEnabled;
}

/**
 * The override, or null for "use the shipped constant". Always null when the
 * probe is not compiled in, so every call site collapses to the shipped value.
 */
export function getConcurrencyProbeDepth(): ConcurrencyProbeDepth | null {
  return probeEnabled ? activeDepth : null;
}

export function setConcurrencyProbeDepth(depth: ConcurrencyProbeDepth | null): void {
  if (!probeEnabled || activeDepth === depth) return;
  activeDepth = depth;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Subscribes the Settings control, and the feed's queue, to the active depth. */
export function useConcurrencyProbeDepth(): ConcurrencyProbeDepth | null {
  return useSyncExternalStore(subscribe, getConcurrencyProbeDepth, getConcurrencyProbeDepth);
}
