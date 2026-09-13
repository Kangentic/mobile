import React, { createContext, useCallback, useContext, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { getRetentionProbeVariant } from '@/devsupport/retentionProbe';

/**
 * Whether continuous motion on this screen should actually run.
 *
 * A looping animation costs the same whether or not anyone can see it.
 * Reanimated drives its worklets on the UI thread every vsync, independent of
 * React and independent of whether the view is on screen, so a screen that is
 * merely COVERED by a pushed route keeps paying full price. Measured on a
 * release build, Pixel 11 Pro, the Agents list underneath the Settings screen:
 * 22-46% of a core (peaking at 86%) with **zero frames rendered** - the app was
 * animating eight activity rings nobody could see and drawing nothing at all.
 * Reduced motion took the same screen to ~6%.
 *
 * The default is `true` so this is opt-IN per screen and inert everywhere else:
 * a component that reads it outside a provider (including every component test)
 * animates exactly as before. That is also why this is a context rather than a
 * `useFocusEffect` inside the leaf components - navigation hooks throw outside a
 * navigator, so putting one in `AgentStatusIcon` would have forced a mock into
 * every test that renders a task card.
 */
const ScreenMotionContext = createContext<boolean>(true);

export interface ScreenMotionProviderProps {
  children: React.ReactNode;
}

/**
 * Pauses continuous motion in its subtree while the screen is blurred.
 *
 * Wrap a screen that hosts looping animation - a list of activity rings, a
 * skeleton - and its motion stops the moment another route covers it and
 * resumes on return. Screens with no looping motion do not need it.
 */
export function ScreenMotionProvider({ children }: ScreenMotionProviderProps): React.JSX.Element {
  const [focused, setFocused] = useState(true);

  useFocusEffect(
    useCallback(() => {
      setFocused(true);
      return () => setFocused(false);
    }, []),
  );

  return <ScreenMotionContext.Provider value={focused}>{children}</ScreenMotionContext.Provider>;
}

/**
 * True when looping motion in this subtree should run. Always true outside a
 * `ScreenMotionProvider`, so reading it can never turn an animation off by
 * accident.
 */
export function useScreenMotionActive(): boolean {
  // Built ON the focus gate rather than beside it, so the pair cannot drift:
  // this hook is exactly `useScreenFocusActive` PLUS the probe override, and
  // saying so in code is what stops a later edit to one silently diverging the
  // other. The difference between them is the override and nothing else.
  const focused = useScreenFocusActive();
  // Probe override: forces every gate closed at runtime, so "is looping motion
  // the cost" is one Settings tap rather than one APK.
  if (getRetentionProbeVariant() === 'no-motion') return false;
  return focused;
}

/**
 * True when this subtree's screen is focused. Same context, same provider, same
 * `ScreenMotionOverride` test seam as `useScreenMotionActive` - but WITHOUT the
 * retention probe's `no-motion` override.
 *
 * The distinction exists because not everything that should pause on blur is
 * motion. A periodic clock costs the same as a looping animation while nobody
 * can see it, so it wants the focus gate; but freezing it under the probe would
 * make elapsed times stop advancing during the very run that is measuring idle
 * cost, confounding the measurement with a second changed variable. Read this
 * for work that is merely PERIODIC, and `useScreenMotionActive` for work that
 * actually animates.
 */
export function useScreenFocusActive(): boolean {
  return useContext(ScreenMotionContext);
}

/**
 * Test seam: drives the gate directly, without a navigator. The provider above
 * needs a navigation context to know about focus, which a component test does
 * not have.
 */
export function ScreenMotionOverride({
  active,
  children,
}: {
  active: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return <ScreenMotionContext.Provider value={active}>{children}</ScreenMotionContext.Provider>;
}
