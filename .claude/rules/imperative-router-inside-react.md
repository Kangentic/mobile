---
paths:
  - "src/navigation/**"
  - "src/notifications/**"
  - "src/connection/**"
  - "src/channel/**"
  - "src/demo/**"
  - "app/**"
---

# Rule: only code inside the mounted navigator calls the imperative router

Everything in this section was read from expo-router 58's source, under `expo-router/build/`. The
cold-start window has not been reproduced on 58, and no JS tier can reproduce it (see Enforcement).

The exported `router` does nothing useful until the navigation container commits. Its methods start
as `unboundRouter`, and each one **throws synchronously**: *"The imperative router is unavailable
before the first render has finished."* (`global-state/router.js`).
`ImperativeRoutingQueueBridge`, rendered by `BaseNavigationContainer`, binds the real methods in a
LAYOUT effect and puts `unboundRouter` back in its cleanup (`global-state/routingQueueContext.js`).

Once bound, `router.push` and `router.navigate` still do not navigate. They add to a queue held in
React state by `RoutingQueueProvider` and return. `RoutingQueueDrainer`, rendered after the
container's children, processes it in a passive effect on a later commit. A throw while dispatching
is caught there and becomes a `console.warn`, so that navigation is **silently lost in a release
build**, and an error in the reducer surfaces during the next render, on a different stack from the
call.

A native cold start leaves the platforms in different states, and both are real.
`getInitialURLWithTimeout` is synchronous on iOS and a Promise on Android, and
`InitialStateNavigationContainer` suspends on that Promise. So on **Android** the container has not
mounted, the router is unbound, and a call from outside React **throws at the call site**. On
**iOS** the container mounts at once, so the same call enqueues, but `ExpoRoot`'s `SafeAreaProvider`
sits inside the container with no `initialMetrics` and renders **null children until the OS reports
insets**, so no navigator or route has mounted while the intent drains. An Android result therefore
proves nothing about iOS here, and "it works on Android" is not evidence.

**Why the rule exists.** Through SDK 57 the queue drained in a `NavigationContainerInner` effect that
called `store.assertIsReady()` and threw *"Attempted to navigate before mounting the Root Layout
component"*, above every route error boundary, so the throw reached the global handler and aborted
the process. That was the iOS TestFlight cold-start crash on 0.6.3 build 13 (a notification tap,
452 ms into the process). Two call sites shipped a `try/catch` that could not catch it, because the
call itself never threw. SDK 58 removed that throw, and with it `isReady` (now `() => true`), which
MOVED the failure rather than ending it: a stray call now fails at the call site on Android and can
vanish into a `console.warn` on iOS, and neither is a tap that reaches its screen. A `try/catch` at
the call site still does not make the navigation happen, so it is still the wrong fix.

## The rule

- **Never call expo-router's imperative `router` from outside the mounted navigator**: not from
  module scope, not from a bundle-entry handler, not from a notifee or expo-notifications
  callback, not from a lifecycle manager or a store subscription.
- **Publish the intent instead.** Add a variant to `PendingNavigation` in
  `src/navigation/pendingNavigation.ts` and call `publishPendingNavigation(...)`.
  `PendingNavigationRunner`, rendered in `app/_layout.tsx` as a sibling of the root `Stack`
  immediately after it, performs it from inside React.
- **Keep the runner a descendant of the navigation container, rendered after the navigator.** Its
  correctness comes from tree position: the bridge binds the router in a layout effect, every
  layout effect in a commit runs before any passive effect, and a descendant of the container
  cannot commit before the container does. So the runner's passive effect never sees the unbound
  router, on either platform. Moving the runner above the container reintroduces the throw. It is
  NOT a child of `<Stack>` and must not become one - `<Stack>` children are route declarations.
- **Do not add a `navigationRef.isReady()` guard to the runner.** It is inert: since SDK 58
  `isReady` is `() => true` (`BaseNavigationContainer.js`), so it would guard nothing while reading
  like a safety check. (On SDK 57 it was worse, reading `false` at the runner and dropping the
  navigation.)
- **Consume the slot inside the effect that performs the navigation**, so a remount cannot perform
  it twice. The extra render with a null value is intended. **Perform the value the consume
  RETURNS, never the value closed over by the render**: a newer intent published between that
  render's commit and the passive-effect flush would otherwise be cleared by the consume while the
  older one is performed, inverting the slot's newer-supersedes-older invariant.
- Hooks and components are unaffected: `Stack`, `Link`, `useRouter`, `useLocalSearchParams`,
  `useNavigationContainerRef` are all fine anywhere they can legally render.

## Enforcement (self-maintaining)

- **Lint (live now):** `eslint.config.mjs` bans the `router` named import from `expo-router`
  outside `src/screens/**`, `src/components/**` and `src/navigation/**` (`no-restricted-imports`,
  `importNames: ['router']`). `Lint (ESLint)` is a required status check on `main`. Verified to
  fire by probe file in all four directions (banned dir errors; `src/notifications/**` keeps the
  router, Sentry and haptics bans simultaneously; `src/navigation/**` permits the router while
  still refusing Sentry and haptics), not assumed. **Mind the flat-config trap documented at the
  top of `eslint.config.mjs`:** options REPLACE rather than merge, so the allow entry for the
  three navigator directories must stay ordered last and must re-state every other ban that still
  applies there.
- **Test (live now):** `tests/unit/imperativeRouterConfinement.test.ts` scans `src/**` and
  `app/**`. It exists because `no-restricted-imports` matches import SYNTAX only, never
  `require()` and never a dynamic `import()` - and the second live instance of this bug reached
  the router through `await import('expo-router')`, which the lint rule cannot see. The scan
  covers both the dynamic routes and the static import, and asserts it found files to scan at all
  so a broken glob cannot pass vacuously.
- **Test (live now):** `tests/components/PendingNavigationRunner.test.tsx` pins that one publish
  performs exactly once, survives a remount, and works both when published before mount
  (cold start) and while already mounted (warm). Note the cold-start window is NOT reproducible at
  any JS tier: expo-router supplies `INITIAL_METRICS` when `NODE_ENV === 'test'`, so the
  SafeAreaProvider gate that opens it does not exist under jest. The tests pin the invariant, not
  the failure.
- **Review (live now):** the `expo-rn-reviewer` agent carries this rule as checklist item 10, so
  a call site the lint glob and the scan both miss is still caught at `/code-review` time. That
  backstop matters because a path-scoped rule loads when a matching file is READ, not when a new
  file is created in one of these directories.

## Scope

Authored code under `src/**` and `app/**` that is not rendered inside the root navigator.
`src/screens/**` and `src/components/**` render inside it by construction and are exempt;
`src/navigation/**` is the one place allowed to perform a published navigation. Does not govern
`app/+native-intent.ts`'s `redirectSystemPath`, whose timing expo-router owns (it must still not
throw - see the comment in that file).
