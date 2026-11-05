import { useEffect, useSyncExternalStore } from 'react';
import { router } from 'expo-router';
import { useBoardStore } from '@/state/boardStore';
import {
  consumePendingNavigation,
  getPendingNavigation,
  subscribePendingNavigation,
  type PendingNavigation,
} from './pendingNavigation';

/**
 * Performs the navigation published to the pending slot, from INSIDE the
 * mounted navigator. See `pendingNavigation.ts` for why nothing outside React
 * may call the router directly.
 *
 * WHY THERE IS NO `navigationRef.isReady()` GUARD HERE. It would look like the
 * obvious safety check and guard nothing: since SDK 58 `isReady` is `() => true`
 * (BaseNavigationContainer.js).
 *
 * Calling the router here is correct because of where this sits. The router
 * throws until the navigation container binds it, which ImperativeRoutingQueueBridge
 * does in a LAYOUT effect. Every layout effect in a commit runs before any passive
 * effect, and a descendant of the container cannot commit before the container
 * does, so this component's effect never sees the unbound router. Correctness
 * comes from tree position, not from a runtime predicate - which is why this must
 * stay a descendant of the navigation container, rendered after the navigator
 * itself.
 */

/**
 * The server snapshot is always empty, never the live slot: the slot is module
 * state, and under a static render that state is shared across requests.
 * Navigation published by a device event has no meaning on a server pass.
 */
function getServerPendingNavigation(): null {
  return null;
}

function performPendingNavigation(navigation: PendingNavigation): void {
  if (navigation.kind === 'reset-to-root') {
    // Two intents, drained together and in this order: pop to the root, then
    // navigate to it.
    if (router.canDismiss()) router.dismissAll();
    router.navigate('/');
    return;
  }
  if (navigation.kind === 'open-project-board') {
    // A workflow-complete tap names no task, only the workflow's HOME project.
    // Selected UNCONDITIONALLY, not once the project shows up in the list: on a
    // cold start no project list has arrived yet, and the Board resolves the
    // selection whenever it does. The store is the only handle, since the Board
    // reads its project from there rather than from a route param.
    useBoardStore.getState().selectProject(navigation.projectId);
    // Dismissed first, as for a reset, so the Board is what the user sees
    // rather than a sheet or a pushed screen left over it.
    if (router.canDismiss()) router.dismissAll();
    router.navigate('/board');
    return;
  }
  if (navigation.kind === 'open-command-terminal') {
    // NAVIGATE for the reason given below: a tap for the terminal already on
    // top replaces its params rather than stacking a second screen on it.
    router.navigate({
      pathname: '/command-terminal',
      params: { sessionId: navigation.sessionId, projectId: navigation.projectId },
    });
    return;
  }
  // NAVIGATE, not push. A PUSH with no getId always appends a route, so a tap for
  // the task already on top stacked a second session screen on the same session.
  // NAVIGATE to the same [taskId] on top replaces that route's params and keeps
  // its key, so nothing remounts; a different taskId still appends
  // (build/layouts/stack-router.js, the PUSH/NAVIGATE branch of the stack router
  // override, pinned by tests/components/PendingNavigationDedupe.test.tsx). Not
  // dismissTo: it pops to the newest route of that
  // NAME, which can be another task's screen, and replaces Home when none
  // matches.
  //
  // No `mode` param: the screen resolves the lens itself (the task's remembered
  // lens, else terminal), so a push tap lands where the user last worked.
  router.navigate({
    pathname: '/task/[taskId]',
    params: {
      taskId: navigation.taskId,
      projectId: navigation.projectId,
      sessionId: navigation.sessionId,
    },
  });
}

export function usePendingNavigation(): void {
  const pending = useSyncExternalStore(
    subscribePendingNavigation,
    getPendingNavigation,
    getServerPendingNavigation,
  );

  useEffect(() => {
    if (!pending) return;
    // Cleared inside the effect, so the slot cannot be performed twice. This
    // costs one extra render with a null pending value, which no-ops. Do not
    // move the consume out of the effect to avoid it: that reintroduces the
    // double navigation.
    //
    // PERFORM WHAT CONSUME RETURNS, NEVER THE CLOSED-OVER `pending`. The two
    // differ whenever a newer intent is published between this render's commit
    // and the passive-effect flush: consume would clear the NEWER value while
    // this performed the older one, inverting the slot's "a newer intent
    // supersedes an older one" invariant. A revocation reset landing just
    // behind a notification tap is the real case - it would be swallowed, and
    // the user left on a task screen for a pairing that no longer exists.
    const consumed = consumePendingNavigation();
    if (!consumed) return;
    performPendingNavigation(consumed);
  }, [pending]);
}

/**
 * Rendered in `app/_layout.tsx` as a SIBLING of the root `Stack`, immediately
 * after it, so the hook above runs only once a navigator has mounted. Not a
 * child of `Stack` - its children are route declarations. Renders nothing.
 */
export function PendingNavigationRunner(): null {
  usePendingNavigation();
  return null;
}
