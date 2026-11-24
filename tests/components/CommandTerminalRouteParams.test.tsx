/**
 * Where a started Command Terminal's session is written, in expo-router's own
 * code (Sentry MOBILE-K).
 *
 * CommandTerminalScreen.test.tsx pins the CALL: the screen writes through
 * `useNavigation().setParams` and never through a router. It mocks both, so it
 * cannot show that the call works, and the behaviour is the library's: an
 * expo-router bump could change it under an unchanged call. THIS file pins that
 * half against the real pieces: the navigation object a screen is handed
 * (`useNavigationCache`), and the stack router the root `<Stack>` uses.
 *
 * Nothing here mounts a navigation container, so expo-router's module-level
 * navigation ref is null throughout, which is the state MOBILE-K met.
 *
 * Mutations seen failing, each standing in for the library changing: the
 * dispatched action without its `source` (the file diff takes the write), as
 * REPLACE_PARAMS (the launch and project are lost), and a navigation ref with a
 * value (the router's `setParams` no longer throws).
 *
 * Why not `renderRouter`: see PendingNavigationDedupe.test.tsx, whose seeding of
 * the stack this follows.
 */
import { renderHook } from '@testing-library/react-native';
import { createImperativeRouter } from 'expo-router/build/global-state/router';
import { navigationRef } from 'expo-router/build/global-state/navigationRef';
import { StackRouter } from 'expo-router/build/layouts/StackClient';
import { createInitialState } from 'expo-router/build/react-navigation/core/createInitialState';
import { useNavigationCache } from 'expo-router/build/react-navigation/core/useNavigationCache';
import { ROOT_CHAIN } from 'expo-router/build/react-navigation/routers/stateKeys';
import { isActionHandled } from 'expo-router/build/react-navigation/routers/utils';

const HOME_ROUTE = '(tabs)';
const TERMINAL_ROUTE = 'command-terminal';
const FILE_DIFF_ROUTE = 'file-diff';

const routerConfiguration = {
  routeNames: [HOME_ROUTE, TERMINAL_ROUTE, FILE_DIFF_ROUTE],
  routeGetIdList: {},
};

type StackRouterInstance = ReturnType<typeof StackRouter>;
type StackRouterState = Parameters<StackRouterInstance['getStateForAction']>[0];
type StackRouterAction = Parameters<StackRouterInstance['getStateForAction']>[1];
type CacheOptions = Parameters<typeof useNavigationCache>[0];

function reduce(router: StackRouterInstance, state: StackRouterState, action: StackRouterAction): StackRouterState {
  const result = router.getStateForAction(state, action, routerConfiguration);
  if (!isActionHandled(result)) throw new Error(`the stack router refused ${action.type}`);
  return result.state as StackRouterState;
}

function pushAction(name: string, params: Record<string, string>): StackRouterAction {
  return { type: 'PUSH', payload: { name, params, singular: undefined } } as StackRouterAction;
}

/** Home, then a terminal opened by its launch: the route a start or a resume opens. */
function terminalOpenedByLaunch(router: StackRouterInstance): StackRouterState {
  const initial = createInitialState<StackRouterState>({ routeNames: routerConfiguration.routeNames, parentChain: ROOT_CHAIN });
  return reduce(router, initial, pushAction(TERMINAL_ROUTE, { launchId: 'launch-1', projectId: 'project-1' }));
}

/** A file diff pushed over the terminal, so the terminal's route is no longer the focused one. */
function withFileDiffOnTop(router: StackRouterInstance, state: StackRouterState): StackRouterState {
  return reduce(router, state, pushAction(FILE_DIFF_ROUTE, { path: 'src/app.ts' }));
}

function paramsOf(state: StackRouterState, routeName: string): object | undefined {
  return state.routes.find((route) => route.name === routeName)?.params;
}

/**
 * The action the terminal screen's own navigation object dispatches for
 * `setParams`, built by expo-router's real per-route cache over a navigator that
 * only records. The recording stands where `useNavigationHelpers` enqueues, and
 * the cast is because the options carry only what building that action reads.
 */
async function dispatchedSetParams(router: StackRouterInstance, state: StackRouterState, written: object): Promise<StackRouterAction> {
  const dispatched: StackRouterAction[] = [];
  const options = {
    routes: state.routes,
    routeNames: routerConfiguration.routeNames,
    navigation: { dispatch: (action: StackRouterAction) => dispatched.push(action) },
    setOptions: () => undefined,
    router,
    emitter: { create: () => ({}) },
  } as unknown as CacheOptions;
  const { result } = await renderHook(() => useNavigationCache(options));
  const terminalRoute = state.routes.find((route) => route.name === TERMINAL_ROUTE);
  if (terminalRoute === undefined) throw new Error('no terminal route');
  result.current(terminalRoute, false).setParams(written);
  expect(dispatched).toHaveLength(1);
  return dispatched[0] as StackRouterAction;
}

describe("writing a started terminal's session into its route", () => {
  it('reaches the terminal route through its own navigation object, beside the params already there', async () => {
    const router = StackRouter({});
    const state = terminalOpenedByLaunch(router);
    expect(navigationRef.current).toBeNull();

    const action = await dispatchedSetParams(router, state, { sessionId: 'terminal-9' });

    expect(paramsOf(reduce(router, state, action), TERMINAL_ROUTE)).toEqual({
      launchId: 'launch-1',
      projectId: 'project-1',
      sessionId: 'terminal-9',
    });
  });

  it('keeps the route key, so the screen that wrote it does not remount', async () => {
    const router = StackRouter({});
    const state = terminalOpenedByLaunch(router);

    const action = await dispatchedSetParams(router, state, { sessionId: 'terminal-9' });

    expect(reduce(router, state, action).routes.map((route) => route.key)).toEqual(state.routes.map((route) => route.key));
  });

  it('reaches the terminal route, and not the one on top, when a file diff was opened over it first', async () => {
    const router = StackRouter({});
    const state = withFileDiffOnTop(router, terminalOpenedByLaunch(router));

    const action = await dispatchedSetParams(router, state, { sessionId: 'terminal-9' });
    const written = reduce(router, state, action);

    expect(paramsOf(written, TERMINAL_ROUTE)).toMatchObject({ sessionId: 'terminal-9' });
    expect(paramsOf(written, FILE_DIFF_ROUTE)).toEqual({ path: 'src/app.ts' });
  });

  /** What a router's `setParams` dispatched even when it did not throw: no source, so the focused route takes it. */
  it('lands on the focused route without a source: the control', () => {
    const router = StackRouter({});
    const state = withFileDiffOnTop(router, terminalOpenedByLaunch(router));

    const written = reduce(router, state, {
      type: 'SET_PARAMS',
      payload: { params: { sessionId: 'terminal-9' } },
    } as StackRouterAction);

    expect(paramsOf(written, TERMINAL_ROUTE)).toEqual({ launchId: 'launch-1', projectId: 'project-1' });
    expect(paramsOf(written, FILE_DIFF_ROUTE)).toMatchObject({ sessionId: 'terminal-9' });
  });
});

/**
 * Why a router's `setParams` is banned outright while everything else on
 * `useRouter()` is not. The object `useRouter()` returns is built by this same
 * `createImperativeRouter`, so the hook is no protection. Red here means
 * expo-router now queues it, and the exception in
 * .claude/rules/imperative-router-inside-react.md is stale.
 */
describe("a router's methods while the module-level navigation ref is null", () => {
  function routerOverRecordedQueue(): { router: ReturnType<typeof createImperativeRouter>; enqueue: jest.Mock } {
    const enqueue = jest.fn();
    return { router: createImperativeRouter(enqueue, jest.fn()), enqueue };
  }

  it('throws from setParams at the call site and queues nothing', () => {
    const { router, enqueue } = routerOverRecordedQueue();
    expect(navigationRef.current).toBeNull();

    expect(() => router.setParams({ sessionId: 'terminal-9' })).toThrow(
      'Attempted to navigate before mounting the Root Layout component',
    );
    expect(enqueue).not.toHaveBeenCalled();
  });

  it('queues the others, and answers false from canGoBack and canDismiss: the control', () => {
    const { router, enqueue } = routerOverRecordedQueue();

    router.back();
    router.replace('/');

    expect(enqueue).toHaveBeenCalledTimes(2);
    expect(router.canGoBack()).toBe(false);
    expect(router.canDismiss()).toBe(false);
  });
});
