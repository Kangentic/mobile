import React, { createContext, useContext, useEffect, useState } from 'react';
import { useScreenFocusActive } from './motion/ScreenMotion';

/**
 * How often the shared clock advances.
 *
 * The labels built on it have minute resolution, so this bounds how stale one
 * can look: half a minute. A full 60s would let a label sit a whole minute
 * behind and read as stuck at the moment the user is watching it tick over.
 * Tests import this rather than hardcoding the number.
 */
export const NOW_TICK_MS = 30_000;

/**
 * One clock per screen, read by the leaves that render elapsed time.
 *
 * WHY A CONTEXT AND NOT A HOOK PER ROW: a feed of twenty rows would otherwise
 * own twenty intervals to display the same instant. One timer publishes to the
 * leaves that care, and a row with nothing to count never subscribes at all.
 *
 * WHY NOT REANIMATED: this drives a text label that changes twice a minute.
 * `motion-conventions.md` puts something at that frequency on "the platform
 * default or nothing", and a registered mapper costs ~0.47 CPU points whether
 * it is dirty or not (measured, release build). A plain setState is cheaper
 * than the hook that would animate it, so the number never animates.
 *
 * Outside a provider this returns the mount instant and never advances, which
 * is the right degradation: a label renders correctly once instead of throwing
 * or pinning a timer nobody asked for.
 */
const NowTickContext = createContext<number | null>(null);

export interface NowTickProviderProps {
  /**
   * Whether anything on this screen currently needs a clock. False runs no
   * timer at all.
   *
   * Correct for an empty or all-working feed, but do not mistake it for a cost
   * control: any single idle session makes it true, and a feed of idle sessions
   * is what this screen is for. The focus gate below is what actually stops the
   * timer in the common case.
   */
  enabled: boolean;
  children: React.ReactNode;
}

export function NowTickProvider({ enabled, children }: NowTickProviderProps): React.JSX.Element {
  // Date.now() is impure to call during render (react-hooks/purity); a lazy
  // initializer runs it once at mount instead.
  const [nowMs, setNowMs] = useState(() => Date.now());
  // A clock costs the same as a looping animation while the screen is covered,
  // and for the same reason: nothing about being off-screen stops the work.
  const focused = useScreenFocusActive();
  const running = enabled && focused;

  useEffect(() => {
    if (!running) return undefined;
    // Re-read on RESUME, not just on each tick: the timer stops while the
    // screen is covered, so a feed returned to after an hour would otherwise
    // show hour-old elapsed times until the first interval fired.
    //
    // Deferred by a zero-delay timer rather than called straight from the
    // effect body, which `react-hooks/set-state-in-effect` rejects for
    // cascading renders. The updater returns the PREVIOUS value when nothing
    // has meaningfully moved, so React bails out and a fresh mount does not
    // pay for a second render just to learn the time it already had.
    const refresh = (): void =>
      setNowMs((previous) => {
        const current = Date.now();
        return current - previous >= 1_000 ? current : previous;
      });
    const resumeTimer = setTimeout(refresh, 0);
    const tickTimer = setInterval(refresh, NOW_TICK_MS);
    return () => {
      clearTimeout(resumeTimer);
      clearInterval(tickTimer);
    };
  }, [running]);

  return <NowTickContext.Provider value={nowMs}>{children}</NowTickContext.Provider>;
}

/**
 * The current instant, refreshed every `NOW_TICK_MS` while the screen is
 * focused. Frozen at mount outside a `NowTickProvider`.
 */
export function useNowTick(): number {
  const provided = useContext(NowTickContext);
  const [mountedAtMs] = useState(() => Date.now());
  return provided ?? mountedAtMs;
}
