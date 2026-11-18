/**
 * The React half of "a crash report says which screen was open" (task #152,
 * from Sentry MOBILE-H, an iOS app hang whose event named no screen).
 *
 * What a report may carry about a screen is its fixed name: the route
 * TEMPLATE, `/task/[taskId]`, and never the path a user is actually on, whose
 * parameter is one of the desktop's task IDs. expo-router offers both from
 * hooks that look interchangeable, `useSegments()` (the route file's path,
 * unnormalized) and `usePathname()` (the parameter substituted in), so this
 * file runs the tracker against expo-router's REAL hooks over a real route
 * info object built for a task route. Mocking the hooks to return what the
 * test expects would only test the mock.
 *
 * Why not `renderRouter`: it has never reported its navigation container
 * ready under this repo's jest setup (see PendingNavigationDedupe.test.tsx),
 * and the hooks only read `RouteInfoContext`, which can be provided directly.
 *
 * MUTATION SEEN FAILING: in src/navigation/screenTracking.tsx, replacing
 * `useSegments()` with `usePathname().split('/').filter(Boolean)` turned the
 * first case red with "expected 'unknown' to be '/task/[taskId]'". Note which
 * assertion that is. The id never reached the tag even then, because the door
 * refuses anything outside its closed set, so the "no task id anywhere"
 * assertion below stays green under that mutation and is a second line, not
 * the one to watch.
 */
import React from 'react';
import { render } from '@testing-library/react-native';
import { getRouteInfoFromState } from 'expo-router/build/global-state/getRouteInfoFromState';
import { RouteInfoContext } from 'expo-router/build/global-state/routeInfoContext';
import { ScreenTracker, useReportedLens } from '@/navigation/screenTracking';
import { setReportedScreen } from '@/observability/reportContext';
import type { LensScreenName, ScreenLens } from '@/observability/reportVocabulary';

// The package root pulls in the whole router; the two hooks the tracker could
// call are taken from their own build files, real, and the focus effect is the
// plain-effect stand-in the screen tests use (the real one throws outside a
// navigator).
jest.mock('expo-router', () => ({
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  useSegments: () => require('expo-router/build/hooks/useSegments').useSegments(),
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  usePathname: () => require('expo-router/build/hooks/usePathname').usePathname(),
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  useFocusEffect: (effect: () => void | (() => void)) => require('react').useEffect(effect, [effect]),
}));

const mockSetTag = jest.fn();
const mockAddBreadcrumb = jest.fn();
jest.mock('@sentry/react-native', () => ({
  setTag: (key: string, value: unknown) => mockSetTag(key, value),
  addBreadcrumb: (breadcrumb: unknown) => mockAddBreadcrumb(breadcrumb),
}));

// The door no-ops until crash reporting has started, which it never does under
// jest (no DSN), so the flag is forced on. Everything else behind the door is
// real: the closed sets are the thing this test leans on.
jest.mock('@/observability/crashReporting', () => ({
  isCrashReportingInitialized: () => true,
}));

const TASK_ID = 'a81f0c2e-7d14-4c9b-9f6e-2b5d3c1a0e77';

type NavigationState = NonNullable<Parameters<typeof getRouteInfoFromState>[0]>;

/**
 * The navigation state expo-router holds with a task's session on top of the
 * tabs: its internal root slot, then the root Stack's two routes. The task
 * route carries its params the way a real push does, id included.
 */
function taskRouteState(): NavigationState {
  return {
    index: 0,
    routes: [
      {
        name: '__root',
        state: {
          index: 1,
          routes: [
            { name: '(tabs)', state: { index: 0, routes: [{ name: 'index' }] } },
            { name: 'task/[taskId]/index', params: { taskId: TASK_ID, projectId: 'project-1', sessionId: 'sess-1' } },
          ],
        },
      },
    ],
  } as NavigationState;
}

function tabsRouteState(tabRouteName: 'index' | 'board'): NavigationState {
  return {
    index: 0,
    routes: [
      {
        name: '__root',
        state: {
          index: 0,
          routes: [
            {
              name: '(tabs)',
              state: { index: tabRouteName === 'index' ? 0 : 1, routes: [{ name: 'index' }, { name: 'board' }] },
            },
          ],
        },
      },
    ],
  } as NavigationState;
}

function renderTracker(state: NavigationState): ReturnType<typeof render> {
  return render(
    <RouteInfoContext.Provider value={getRouteInfoFromState(state)}>
      <ScreenTracker />
    </RouteInfoContext.Provider>,
  );
}

/** The value a tag holds now: the last one written under that key. */
function tagValue(key: string): unknown {
  const writes = mockSetTag.mock.calls.filter((call) => call[0] === key);
  return writes.length === 0 ? undefined : writes[writes.length - 1]?.[1];
}

function LensReporter({ screenName, lens }: { screenName: LensScreenName; lens: Exclude<ScreenLens, 'none'> }): null {
  useReportedLens(screenName, lens);
  return null;
}

beforeEach(() => {
  // The door's screen and last-reported pair are module state and outlive a
  // case, and it records nothing for an unchanged screen. Parking it on a
  // screen no case renders makes every case's first report a real change,
  // whatever ran before it.
  setReportedScreen(['devices']);
  mockSetTag.mockClear();
  mockAddBreadcrumb.mockClear();
});

describe('ScreenTracker', () => {
  it("reports a task's session as its route template, read from expo-router's own segments", async () => {
    // Guard on the fixture itself: the two hooks must genuinely disagree for
    // this route, or the case proves nothing about which one was read.
    const routeInfo = getRouteInfoFromState(taskRouteState());
    expect(routeInfo.segments).toEqual(['task', '[taskId]']);
    expect(routeInfo.pathname).toBe(`/task/${TASK_ID}`);

    await renderTracker(taskRouteState());

    expect(tagValue('screen')).toBe('/task/[taskId]');
  });

  it('sends the task id nowhere: not on a tag, not on the trail', async () => {
    // With the session's lens reported too, so the breadcrumb is recorded and
    // there is a trail entry to inspect (the door holds a lens screen's entry
    // until its lens is known).
    await render(
      <RouteInfoContext.Provider value={getRouteInfoFromState(taskRouteState())}>
        <ScreenTracker />
        <LensReporter screenName="/task/[taskId]" lens="chat" />
      </RouteInfoContext.Provider>,
    );

    expect(mockSetTag).toHaveBeenCalled();
    expect(mockAddBreadcrumb).toHaveBeenCalled();
    const everythingSent = JSON.stringify([mockSetTag.mock.calls, mockAddBreadcrumb.mock.calls]);
    expect(everythingSent).not.toContain(TASK_ID);
    expect(everythingSent).not.toContain('project-1');
    expect(everythingSent).not.toContain('sess-1');
  });

  it('reports the two tabs under the names their URLs have, with the route group dropped', async () => {
    const agents = await renderTracker(tabsRouteState('index'));
    expect(tagValue('screen')).toBe('/');
    await agents.unmount();

    await renderTracker(tabsRouteState('board'));
    expect(tagValue('screen')).toBe('/board');
  });

  it('reports again when the route changes under it', async () => {
    const view = await renderTracker(tabsRouteState('index'));
    expect(tagValue('screen')).toBe('/');

    await view.rerender(
      <RouteInfoContext.Provider value={getRouteInfoFromState(taskRouteState())}>
        <ScreenTracker />
      </RouteInfoContext.Provider>,
    );

    expect(tagValue('screen')).toBe('/task/[taskId]');
  });

  it('renders nothing', async () => {
    const view = await renderTracker(tabsRouteState('index'));

    expect(view.toJSON()).toBeNull();
  });
});

describe('useReportedLens', () => {
  /**
   * The tracker and the screen are different components, and which one's
   * effect runs first is not something to rely on: the first device run showed
   * the tracker first, where the reverse had been assumed, and the trail got
   * two entries for one arrival. Effects run in tree order, so the two cases
   * below are the two orders, by where each component sits. Both must leave
   * ONE trail entry, carrying the real pair.
   */
  it('records one trail entry when the lens is reported before the screen', async () => {
    await render(
      <RouteInfoContext.Provider value={getRouteInfoFromState(taskRouteState())}>
        <LensReporter screenName="/task/[taskId]" lens="chat" />
        <ScreenTracker />
      </RouteInfoContext.Provider>,
    );

    expect(tagValue('screen')).toBe('/task/[taskId]');
    expect(tagValue('lens')).toBe('chat');
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1);
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ data: { screen: '/task/[taskId]', lens: 'chat' } }),
    );
  });

  it('records one trail entry when the screen is reported before the lens, the order seen on a device', async () => {
    await render(
      <RouteInfoContext.Provider value={getRouteInfoFromState(taskRouteState())}>
        <ScreenTracker />
        <LensReporter screenName="/task/[taskId]" lens="chat" />
      </RouteInfoContext.Provider>,
    );

    expect(tagValue('screen')).toBe('/task/[taskId]');
    expect(tagValue('lens')).toBe('chat');
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(1);
    expect(mockAddBreadcrumb).toHaveBeenCalledWith(
      expect.objectContaining({ data: { screen: '/task/[taskId]', lens: 'chat' } }),
    );
  });

  it('reports a lens change while the screen stays up', async () => {
    const view = await render(
      <RouteInfoContext.Provider value={getRouteInfoFromState(taskRouteState())}>
        <LensReporter screenName="/task/[taskId]" lens="terminal" />
        <ScreenTracker />
      </RouteInfoContext.Provider>,
    );
    expect(tagValue('lens')).toBe('terminal');

    await view.rerender(
      <RouteInfoContext.Provider value={getRouteInfoFromState(taskRouteState())}>
        <LensReporter screenName="/task/[taskId]" lens="changes" />
        <ScreenTracker />
      </RouteInfoContext.Provider>,
    );

    expect(tagValue('lens')).toBe('changes');
    // One entry for the change. The focus effect re-runs as a cleanup then a
    // setup, and the cleanup's clear must not put an entry of its own between.
    expect(mockAddBreadcrumb).toHaveBeenLastCalledWith(
      expect.objectContaining({ data: { screen: '/task/[taskId]', lens: 'changes' } }),
    );
    expect(mockAddBreadcrumb).toHaveBeenCalledTimes(2);
  });

  it('records nothing when the screen that owns the lens goes away: a blur only forgets', async () => {
    // The screen that takes over reports itself. Recording from the blur would
    // put a false "same screen, no lens" entry on the trail on every exit.
    const view = await render(
      <RouteInfoContext.Provider value={getRouteInfoFromState(taskRouteState())}>
        <LensReporter screenName="/task/[taskId]" lens="chat" />
        <ScreenTracker />
      </RouteInfoContext.Provider>,
    );
    // Non-vacuity: the lens really was reported before the owner goes away.
    expect(tagValue('lens')).toBe('chat');
    mockSetTag.mockClear();
    mockAddBreadcrumb.mockClear();

    await view.rerender(
      <RouteInfoContext.Provider value={getRouteInfoFromState(taskRouteState())}>
        <ScreenTracker />
      </RouteInfoContext.Provider>,
    );

    expect(mockSetTag).not.toHaveBeenCalled();
    expect(mockAddBreadcrumb).not.toHaveBeenCalled();
  });

  it('forgets the lens with the visit, so the next screen on that route waits for its own', async () => {
    // Visit one, on `changes`, goes away. Visit two arrives screen-first: its
    // lens tag must read `none` until IT reports, never the last visit's.
    const firstVisit = await render(
      <RouteInfoContext.Provider value={getRouteInfoFromState(taskRouteState())}>
        <ScreenTracker />
        <LensReporter screenName="/task/[taskId]" lens="changes" />
      </RouteInfoContext.Provider>,
    );
    expect(tagValue('lens')).toBe('changes');
    await firstVisit.unmount();
    setReportedScreen(['devices']);
    mockSetTag.mockClear();
    mockAddBreadcrumb.mockClear();

    await renderTracker(taskRouteState());

    expect(tagValue('screen')).toBe('/task/[taskId]');
    expect(tagValue('lens')).toBe('none');
    expect(mockAddBreadcrumb).not.toHaveBeenCalled();
  });
});
