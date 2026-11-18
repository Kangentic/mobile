import { useCallback, useEffect } from 'react';
import { useFocusEffect, useSegments } from 'expo-router';
import { setReportedLens, setReportedScreen } from '@/observability/reportContext';
import type { LensScreenName, ScreenLens } from '@/observability/reportVocabulary';

/**
 * Tells the crash reporter which screen is showing, so that an event can say
 * where the app was (task #152, from Sentry MOBILE-H, whose event could not).
 * The values, and why they can never name a task, are in
 * `src/observability/reportVocabulary.ts`; this file is only the React half
 * that reads the router.
 *
 * `useSegments()`, NEVER `usePathname()`. The two look interchangeable and are
 * opposites where it matters: segments are the route FILE's path, so a task's
 * session reads `['task', '[taskId]']` whichever task is open, while the
 * pathname has the parameter substituted in and reads `/task/<that task's id>`.
 * A task ID is the desktop's, and the privacy policy says a crash report never
 * names one. The door refuses a resolved path anyway (it comes out as
 * `unknown`), so swapping the hook would cost the screen name rather than leak
 * the ID, and tests/components/ScreenTracker.test.tsx goes red on exactly that
 * swap.
 */

/**
 * Renders nothing. Mounted once in `app/_layout.tsx`, as a sibling AFTER the
 * root `<Stack>`.
 *
 * Its own component rather than a hook in the root layout, so that a
 * navigation re-renders this and not the layout and every `Stack.Screen`
 * declaration in it.
 *
 * THE POSITION IS LOAD-BEARING, for a different reason from the pending
 * navigation runner's beside it. Passive effects run child-first and in
 * sibling order, so every screen under `<Stack>` runs its effects before this
 * one does. A screen that owns a lens reports it from a focus effect
 * (`useReportedLens` below), which therefore lands BEFORE this reports the
 * screen. The lens waits against its owner, and the one breadcrumb this then
 * records already carries it. Mounted before `<Stack>`, the order flips and
 * every arrival on a lens screen records two crumbs, the first with a stale
 * lens. tests/unit/rootLayoutWiring.test.ts pins the position.
 */
export function ScreenTracker(): null {
  const segments = useSegments();

  useEffect(() => {
    // Reported on every change of the segments array, including a change of
    // route params that leaves the template alone. That is deliberate and
    // free: the door compares against what it last reported and does nothing
    // when the screen and lens are unchanged.
    setReportedScreen(segments);
  }, [segments]);

  return null;
}

/**
 * Reports which lens a lens-owning screen is on. One call in each of the three
 * screens that hold a lens in local state: a task's session, a Command
 * Terminal, and a completed task.
 *
 * On FOCUS, and with no cleanup, on purpose. Focus because a lens screen stays
 * mounted underneath whatever is pushed over it, and coming back to it must
 * report its lens again (the same route name can be on the stack twice: one
 * task opened over another from a notification). No cleanup because there is
 * nothing to clear: the door keeps the lens against its owning screen and
 * applies it only while that screen is showing. Clearing it on blur was the
 * first design, and it was wrong in a way no single screen shows: the new
 * screen's focus effect runs BEFORE the old screen's blur, so the blur wiped
 * the lens the new screen had just reported.
 *
 * Call it above any early return, like every hook: a screen that is still
 * loading has a lens too.
 */
export function useReportedLens(screen: LensScreenName, lens: Exclude<ScreenLens, 'none'>): void {
  useFocusEffect(
    useCallback(() => {
      setReportedLens(screen, lens);
    }, [screen, lens]),
  );
}
