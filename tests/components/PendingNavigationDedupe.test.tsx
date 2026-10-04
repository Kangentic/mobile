/**
 * A notification tap for the task ALREADY on top must not stack a second
 * session screen on the same session.
 *
 * The runner used to `router.push`, and a second session screen on the same
 * session is what a tap for the open task produced: dismissing that duplicate
 * then ran its close path against the survivor's live terminal. The runner now
 * calls `router.navigate`, which tests/components/PendingNavigationRunner.test.tsx
 * pins (mutation: put `router.push` back and it reddens).
 *
 * THIS file pins the other half: that NAVIGATE actually de-duplicates. That is
 * the reducer's behaviour, not ours, and an expo-router bump could change it
 * under an unchanged call. So it drives the exact router the root `<Stack>`
 * uses (expo-router's `StackRouter`, react-navigation's stack router with
 * expo-router's `stackRouterOverride` on top) with the payload shape
 * `getNavigateAction` builds for `/task/[taskId]` (name, params, singular).
 *
 * Why the reducer and not `renderRouter`: expo-router's testing library never
 * reports its navigation container ready under this repo's jest setup (even a
 * bare `<Stack />` throws "Attempted to navigate before mounting the Root
 * Layout"), so a rendered test could not reach the reducer at all.
 *
 * The PUSH cases are the control: they document the duplicate this change
 * removes, and they fail loudly if expo-router ever starts de-duplicating PUSH
 * too (at which point the comment in PendingNavigationRunner is stale).
 */
import { StackRouter } from 'expo-router/build/layouts/StackClient';

const HOME_ROUTE = '(tabs)';
const TASK_ROUTE = 'task/[taskId]/index';

const routerConfiguration = {
  routeNames: [HOME_ROUTE, TASK_ROUTE],
  routeParamList: {},
  routeGetIdList: {},
};

type TaskAction = {
  type: 'PUSH' | 'NAVIGATE';
  payload: { name: string; params: Record<string, string>; singular: undefined };
};

function openTaskAction(type: TaskAction['type'], taskId: string, sessionId: string): TaskAction {
  return {
    type,
    payload: { name: TASK_ROUTE, params: { taskId, projectId: 'project-1', sessionId }, singular: undefined },
  };
}

interface StackRoute {
  key: string;
  name: string;
  params?: Record<string, unknown>;
}

interface StackState {
  routes: StackRoute[];
  index: number;
}

/**
 * Applies each action in order, starting from the stack's initial (Home) state,
 * and returns the state after EVERY action. One router run, so route keys (random
 * per new route) can be compared between steps.
 */
function applyActionsStepwise(actions: TaskAction[]): StackState[] {
  const router = StackRouter({});
  let state = router.getInitialState(routerConfiguration);
  const states: StackState[] = [];
  for (const action of actions) {
    const next = router.getStateForAction(state, action, routerConfiguration);
    if (next === null) throw new Error(`the stack router refused ${action.type}`);
    state = next as typeof state;
    states.push(state as unknown as StackState);
  }
  return states;
}

function applyActions(actions: TaskAction[]): StackState {
  const states = applyActionsStepwise(actions);
  const last = states[states.length - 1];
  if (last === undefined) throw new Error('no actions applied');
  return last;
}

function taskRoutes(state: StackState): StackRoute[] {
  return state.routes.filter((route) => route.name === TASK_ROUTE);
}

describe('opening a task screen that is already on top', () => {
  it('NAVIGATE reuses the open screen instead of stacking a second one', () => {
    const state = applyActions([
      openTaskAction('NAVIGATE', 'task-1', 'session-1'),
      openTaskAction('NAVIGATE', 'task-1', 'session-1'),
    ]);

    expect(state.routes.map((route) => route.name)).toEqual([HOME_ROUTE, TASK_ROUTE]);
  });

  /**
   * The same KEY is what keeps React from unmounting and remounting the screen.
   * Keys are random per new route, so this compares within one router run.
   */
  it('NAVIGATE keeps the existing route key, so the screen does not remount', () => {
    const [opened, reopened] = applyActionsStepwise([
      openTaskAction('NAVIGATE', 'task-1', 'session-1'),
      openTaskAction('NAVIGATE', 'task-1', 'session-1'),
    ]);

    expect(reopened?.routes.map((route) => route.key)).toEqual(opened?.routes.map((route) => route.key));
  });

  /**
   * A tap carrying a different session for the same task (a respawn) lands on
   * the MOUNTED screen as a param change. SessionScreen trusts the session
   * param only until the board first locates the task, so this is safe there;
   * pinned so the path is a known one.
   */
  it('NAVIGATE for the same task with a different session replaces the params in place', () => {
    const state = applyActions([
      openTaskAction('NAVIGATE', 'task-1', 'session-1'),
      openTaskAction('NAVIGATE', 'task-1', 'session-2'),
    ]);

    const routes = taskRoutes(state);
    expect(routes).toHaveLength(1);
    expect(routes[0]?.params).toMatchObject({ taskId: 'task-1', sessionId: 'session-2' });
  });

  it('NAVIGATE for a different task still opens a new screen', () => {
    const state = applyActions([
      openTaskAction('NAVIGATE', 'task-1', 'session-1'),
      openTaskAction('NAVIGATE', 'task-2', 'session-9'),
    ]);

    expect(taskRoutes(state).map((route) => route.params?.taskId)).toEqual(['task-1', 'task-2']);
  });

  it('PUSH (what the runner used to call) stacks a duplicate: the control', () => {
    const state = applyActions([
      openTaskAction('PUSH', 'task-1', 'session-1'),
      openTaskAction('PUSH', 'task-1', 'session-1'),
    ]);

    expect(taskRoutes(state)).toHaveLength(2);
  });
});
