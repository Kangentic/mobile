/**
 * A one-slot queue of navigation the app wants to perform, published from
 * OUTSIDE React and performed from inside it.
 *
 * WHY THIS EXISTS. expo-router's imperative `router` singleton is unsafe to
 * call from module scope, a bundle-entry handler, or any other non-React
 * caller. Until the navigation container commits, every method THROWS 'The
 * imperative router is unavailable before the first render has finished'. Once
 * bound, `router.push`/`navigate` still do not navigate: they add to a queue in
 * React state, and a failure draining it is caught and becomes a console.warn,
 * so that navigation is silently lost.
 *
 * On a native cold start that window is real, and the platforms land on
 * different sides of it: `getInitialURLWithTimeout` is synchronous on iOS and a
 * Promise on Android, so on Android the container suspends and the call throws,
 * and on iOS it enqueues while the SafeAreaProvider inside the container still
 * renders nothing, waiting for the OS to report insets. Through SDK 57 the iOS
 * side threw from the drain effect, above every route error boundary, and aborted
 * the process: the iOS TestFlight cold-start crash on 0.6.3 build 13, reached by a
 * notification tap.
 *
 * A try/catch at the call site does not help: it stops a throw, but the navigation
 * still does not happen. The only fix is to not call the router until a navigator
 * exists, which is what publishing here and consuming in
 * `PendingNavigationRunner` achieves. Publishing here fixes both platforms. See
 * .claude/rules/imperative-router-inside-react.md.
 *
 * One slot, not a list: every intent here is "where the app should be now", so
 * a newer one supersedes an older one rather than replaying behind it.
 */

export type PendingNavigation =
  | {
      readonly kind: 'open-task';
      readonly taskId: string;
      readonly projectId: string;
      readonly sessionId: string;
    }
  /**
   * A Command Terminal's notification (protocol 0.20.0, `sessionKind:
   * 'command-terminal'`): opens that terminal by its session. Its own variant,
   * never `open-task`, because a terminal's envelope names a made-up task id
   * that no board row has, and opening it as a task lands on a blank "Task"
   * screen that never connects (design change 7's "Today").
   */
  | {
      readonly kind: 'open-command-terminal';
      readonly projectId: string;
      readonly sessionId: string;
    }
  /**
   * A workflow-complete notification (protocol 0.21.0): every task of a
   * workflow reached Done, so there is no one task to open. Its envelope names
   * the workflow's HOME project and carries empty task and session ids, so it
   * opens that project's board rather than an `open-task` with an empty id.
   */
  | {
      readonly kind: 'open-project-board';
      readonly projectId: string;
    }
  | { readonly kind: 'reset-to-root' };

let pendingNavigation: PendingNavigation | null = null;
const pendingNavigationSubscribers = new Set<() => void>();

export function publishPendingNavigation(next: PendingNavigation | null): void {
  pendingNavigation = next;
  for (const subscriber of pendingNavigationSubscribers) subscriber();
}

export function subscribePendingNavigation(onStoreChange: () => void): () => void {
  pendingNavigationSubscribers.add(onStoreChange);
  return () => {
    pendingNavigationSubscribers.delete(onStoreChange);
  };
}

/**
 * The `useSyncExternalStore` snapshot. Returns the stored reference itself and
 * never a fresh object: a snapshot that allocates on every call makes
 * useSyncExternalStore re-render forever.
 */
export function getPendingNavigation(): PendingNavigation | null {
  return pendingNavigation;
}

export function consumePendingNavigation(): PendingNavigation | null {
  const consumed = pendingNavigation;
  if (consumed !== null) publishPendingNavigation(null);
  return consumed;
}
