import { useCallback, useEffect, useId } from 'react';
import { useFocusEffect, useSegments } from 'expo-router';
import { clearReportedLens, setReportedLens, setReportedScreen } from '@/observability/reportContext';
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
 *
 * TWO REPORTERS, IN NO PARTICULAR ORDER. The tracker below reports the screen
 * and each lens-owning screen reports its own lens, from different places in
 * the tree. Do not reason about which effect runs first: an earlier version
 * did (a later sibling's effect runs last, so the screen's focus effect should
 * land before the tracker's), and the first delivered event showed the
 * opposite on a real device, because a route's screen mounts after the
 * navigation state naming it has already changed. The door is built to give
 * the same result in either order (`src/observability/reportContext.ts`).
 */

/**
 * Renders nothing. Mounted once in `app/_layout.tsx`, beside the pending
 * navigation runner.
 *
 * Its own component rather than a hook in the root layout, so that a
 * navigation re-renders this and not the layout and every `Stack.Screen`
 * declaration in it. Where exactly it sits in the root layout does not matter
 * (see above); that it is mounted at all does, and
 * tests/unit/rootLayoutWiring.test.ts pins that.
 */
export function ScreenTracker(): null {
  const segments = useSegments();

  useEffect(() => {
    // Reported on every change of the segments array, including a change of
    // route params that leaves the template alone. That is deliberate: the
    // door returns before writing anything when the screen's name is unchanged
    // (`setReportedScreen`).
    setReportedScreen(segments);
  }, [segments]);

  return null;
}

/**
 * Reports which lens a lens-owning screen is on. One call in each of the three
 * screens that hold a lens in local state: a task's session, a Command
 * Terminal, and a completed task.
 *
 * On FOCUS, and cleared on blur. Focus because a lens screen stays mounted
 * underneath whatever is pushed over it, and coming back to it must report its
 * lens again. Cleared on blur so a lens cannot outlive the visit and be shown
 * against a different task opened later on the same route.
 *
 * The `useId()` is what makes the clear safe. The same route can be on the
 * stack twice (one task opened over another from a notification), and the old
 * instance's blur can run after the new instance has reported its lens. The
 * door clears an entry only for the instance that set it, so that late blur
 * removes nothing.
 *
 * Call it above any early return, like every hook: a screen that is still
 * loading has a lens too.
 */
export function useReportedLens(screen: LensScreenName, lens: Exclude<ScreenLens, 'none'>): void {
  const owner = useId();
  useFocusEffect(
    useCallback(() => {
      setReportedLens(screen, lens, owner);
      return () => clearReportedLens(screen, owner);
    }, [screen, lens, owner]),
  );
}
