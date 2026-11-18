import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/observability/reportContext.ts` is what makes a crash report say where
 * the app was and what it was doing (task #152, from Sentry MOBILE-H, whose
 * event said neither). What these tests pin is the contract that lets that
 * leave a device at all: every value is a member of a closed set, a screen is
 * its route template and never a path, and a lens belongs to the screen that
 * set it.
 *
 * `@sentry/react-native` is mocked by string specifier rather than imported,
 * so this file does not trip the `no-restricted-imports` zone confining the
 * SDK to src/observability/.
 */

const sentryState = vi.hoisted(() => ({ addBreadcrumb: vi.fn(), setTag: vi.fn() }));
vi.mock('@sentry/react-native', () => ({
  addBreadcrumb: sentryState.addBreadcrumb,
  setTag: sentryState.setTag,
}));

const crashReportingState = vi.hoisted(() => ({ initialized: true }));
vi.mock('@/observability/crashReporting', () => ({
  isCrashReportingInitialized: () => crashReportingState.initialized,
}));

// Pure modules, safe to load for real: the categories and the closed sets are
// the things under test, so mocking them would test the mock.
const { CONNECTION_BREADCRUMB_CATEGORY, NAVIGATION_BREADCRUMB_CATEGORY } = await import('@/observability/scrubEvent');
const { CONNECTION_BREADCRUMB_STATE_LIST } = await import('@/observability/reportVocabulary');

type ReportContextModule = typeof import('@/observability/reportContext');

/** A fresh module per case: the screen, the lenses and the last-reported pair are module state. */
async function loadFreshModule(): Promise<ReportContextModule> {
  vi.resetModules();
  return import('@/observability/reportContext');
}

interface RecordedBreadcrumb {
  category?: string;
  level?: string;
  message?: string;
  type?: string;
  data?: Record<string, unknown>;
}

function recordedBreadcrumbs(): RecordedBreadcrumb[] {
  return sentryState.addBreadcrumb.mock.calls.map((call) => call[0] as RecordedBreadcrumb);
}

function breadcrumbsIn(category: string): RecordedBreadcrumb[] {
  return recordedBreadcrumbs().filter((breadcrumb) => breadcrumb.category === category);
}

/** The value a tag holds now: the last one written under that key. */
function tagValue(key: string): unknown {
  const writes = sentryState.setTag.mock.calls.filter((call) => call[0] === key);
  return writes.length === 0 ? undefined : writes[writes.length - 1]?.[1];
}

const TASK_SEGMENTS = ['task', '[taskId]'] as const;

beforeEach(() => {
  sentryState.addBreadcrumb.mockClear();
  sentryState.setTag.mockClear();
  crashReportingState.initialized = true;
});

describe('initializeReportContext', () => {
  it('starts the scope at no screen and no lens, so an event from before the first render says so', async () => {
    const reportContext = await loadFreshModule();
    reportContext.initializeReportContext();

    expect(tagValue('screen')).toBe('none');
    expect(tagValue('lens')).toBe('none');
  });

  it('records no breadcrumb: nothing has happened yet for a trail to hold', async () => {
    const reportContext = await loadFreshModule();
    reportContext.initializeReportContext();

    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('does nothing when crash reporting never started, which is every build made from source', async () => {
    crashReportingState.initialized = false;
    const reportContext = await loadFreshModule();
    reportContext.initializeReportContext();

    expect(sentryState.setTag).not.toHaveBeenCalled();
  });
});

describe('setReportedScreen', () => {
  it("tags a task's session with its route template", async () => {
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);

    expect(tagValue('screen')).toBe('/task/[taskId]');
  });

  it('never tags a resolved path: a task id handed in comes out as unknown, on the tag and on the trail', async () => {
    // The mutation this guards: a caller reading the resolved pathname instead
    // of the segments. The door is the last place that can refuse it.
    const taskId = 'a81f0c2e-7d14-4c9b-9f6e-2b5d3c1a0e77';
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(['task', taskId]);

    expect(tagValue('screen')).toBe('unknown');
    const everythingSent = JSON.stringify([sentryState.setTag.mock.calls, sentryState.addBreadcrumb.mock.calls]);
    expect(everythingSent).not.toContain(taskId);
  });

  it('records one breadcrumb per screen change, carrying the screen and the lens and nothing else', async () => {
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(['(tabs)']);
    reportContext.setReportedScreen(['settings']);

    const breadcrumbs = breadcrumbsIn(NAVIGATION_BREADCRUMB_CATEGORY);
    expect(breadcrumbs.map((breadcrumb) => breadcrumb.data)).toEqual([
      { screen: '/', lens: 'none' },
      { screen: '/settings', lens: 'none' },
    ]);
    for (const breadcrumb of breadcrumbs) {
      expect(Object.keys(breadcrumb).sort()).toEqual(['category', 'data', 'level', 'message']);
    }
  });

  it('gives each breadcrumb a message made of the same two fixed names, so the trail reads in the CLI', async () => {
    // The Sentry CLI's trail view prints only the message column. The first
    // delivered event had none, and every row of the app's own trail was blank.
    // The message must add nothing: it is the screen, and the lens when there
    // is one.
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(['settings']);
    reportContext.setReportedLens('/task/[taskId]', 'chat', 'instance-a');
    reportContext.setReportedScreen(TASK_SEGMENTS);

    expect(breadcrumbsIn(NAVIGATION_BREADCRUMB_CATEGORY).map((breadcrumb) => breadcrumb.message)).toEqual([
      '/settings',
      '/task/[taskId] chat',
    ]);
  });

  it('records nothing when the screen is reported again unchanged', async () => {
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(['settings']);
    sentryState.addBreadcrumb.mockClear();
    sentryState.setTag.mockClear();

    reportContext.setReportedScreen(['settings']);

    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
    expect(sentryState.setTag).not.toHaveBeenCalled();
  });

  it('records the first screen after launch even though the scope already says none', async () => {
    const reportContext = await loadFreshModule();
    reportContext.initializeReportContext();
    reportContext.setReportedScreen(['(tabs)']);

    expect(breadcrumbsIn(NAVIGATION_BREADCRUMB_CATEGORY)).toHaveLength(1);
    expect(tagValue('screen')).toBe('/');
  });

  it('does nothing when crash reporting never started', async () => {
    crashReportingState.initialized = false;
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);

    expect(sentryState.setTag).not.toHaveBeenCalled();
    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('never throws into the navigation that reported it', async () => {
    sentryState.setTag.mockImplementationOnce(() => {
      throw new Error('native module gone');
    });
    const reportContext = await loadFreshModule();

    expect(() => reportContext.setReportedScreen(['settings'])).not.toThrow();
  });
});

/**
 * The screen and the lens are reported by two different components, and
 * nothing guarantees which speaks first. The first device run (Android,
 * 2026-11-18) showed the tracker reporting the screen 8 ms BEFORE the screen
 * reported its lens, the opposite of what had been assumed, and the trail got
 * a `lens: none` entry followed by the real one. So every arrival is pinned
 * here in BOTH orders, and each must leave exactly one breadcrumb carrying the
 * real pair.
 */
describe('setReportedLens and clearReportedLens', () => {
  function navigationData(): unknown[] {
    return breadcrumbsIn(NAVIGATION_BREADCRUMB_CATEGORY).map((breadcrumb) => breadcrumb.data);
  }

  it('records ONE breadcrumb when the screen arrives before its lens, the order seen on a device', async () => {
    // The mutation this guards: recording a breadcrumb as soon as the screen
    // is known. That is the two-entry trail the first delivered event had.
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(['(tabs)']);
    sentryState.addBreadcrumb.mockClear();

    reportContext.setReportedScreen(TASK_SEGMENTS);
    // The tags move at once, so an event in the gap still says where the app is.
    expect(tagValue('screen')).toBe('/task/[taskId]');
    expect(tagValue('lens')).toBe('none');
    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();

    reportContext.setReportedLens('/task/[taskId]', 'chat', 'instance-a');
    expect(tagValue('lens')).toBe('chat');
    expect(navigationData()).toEqual([{ screen: '/task/[taskId]', lens: 'chat' }]);
  });

  it('records ONE breadcrumb when the lens arrives before its screen', async () => {
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(['(tabs)']);
    sentryState.addBreadcrumb.mockClear();

    reportContext.setReportedLens('/task/[taskId]', 'terminal', 'instance-a');
    // Not the showing screen yet: nothing on the trail, and the lens tag still
    // describes the screen that IS showing.
    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
    expect(tagValue('lens')).toBe('none');

    reportContext.setReportedScreen(TASK_SEGMENTS);
    expect(navigationData()).toEqual([{ screen: '/task/[taskId]', lens: 'terminal' }]);
  });

  it('still records the arrival when a lens screen is left before it ever reported a lens', async () => {
    // A held breadcrumb must not be lost. It is released by the next screen.
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(['(tabs)']);
    sentryState.addBreadcrumb.mockClear();

    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedScreen(['settings']);

    expect(navigationData()).toEqual([
      { screen: '/task/[taskId]', lens: 'none' },
      { screen: '/settings', lens: 'none' },
    ]);
  });

  it('reads none on a screen that owns no lens', async () => {
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedLens('/task/[taskId]', 'chat', 'instance-a');

    reportContext.setReportedScreen(['settings']);

    expect(tagValue('screen')).toBe('/settings');
    expect(tagValue('lens')).toBe('none');
  });

  it("keeps each screen's lens to that screen: a completed task's lens never shows on a session", async () => {
    // The mutation this guards: one shared "current lens" slot instead of a
    // lens per owning screen.
    const reportContext = await loadFreshModule();
    reportContext.setReportedLens('/completed-task', 'summary', 'instance-completed');
    reportContext.setReportedLens('/task/[taskId]', 'terminal', 'instance-session');

    reportContext.setReportedScreen(['completed-task']);
    expect(tagValue('lens')).toBe('summary');

    reportContext.setReportedScreen(TASK_SEGMENTS);
    expect(tagValue('lens')).toBe('terminal');
  });

  it('records nothing when a screen blurs: a blur only forgets, the next screen reports itself', async () => {
    // The mutation this guards: updating the scope from the clear. That puts a
    // false "same screen, no lens" entry on the trail on every exit.
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedLens('/task/[taskId]', 'chat', 'instance-a');
    sentryState.addBreadcrumb.mockClear();
    sentryState.setTag.mockClear();

    reportContext.clearReportedLens('/task/[taskId]', 'instance-a');

    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
    expect(sentryState.setTag).not.toHaveBeenCalled();
  });

  it('never shows a lens left over from an earlier visit against the next task opened', async () => {
    // Visit one ends on `changes` and blurs. Visit two is a different task on
    // the same route, arriving screen-first. Its trail entry must wait for ITS
    // lens, never borrow the last one.
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedLens('/task/[taskId]', 'changes', 'instance-a');
    reportContext.clearReportedLens('/task/[taskId]', 'instance-a');
    reportContext.setReportedScreen(['(tabs)']);
    sentryState.addBreadcrumb.mockClear();

    reportContext.setReportedScreen(TASK_SEGMENTS);
    expect(tagValue('lens')).toBe('none');
    reportContext.setReportedLens('/task/[taskId]', 'terminal', 'instance-b');

    expect(navigationData()).toEqual([{ screen: '/task/[taskId]', lens: 'terminal' }]);
  });

  it("keeps a new instance's lens when the old instance of the same route blurs after it", async () => {
    // One task opened over another from a notification: same route name, two
    // instances. The new one reports, THEN the old one's blur runs. The
    // mutation this guards is a clear that ignores who set the lens, which
    // leaves the tag reading `none` for as long as the user stays there.
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedLens('/task/[taskId]', 'chat', 'instance-a');

    reportContext.setReportedLens('/task/[taskId]', 'terminal', 'instance-b');
    reportContext.clearReportedLens('/task/[taskId]', 'instance-a');
    // Something that makes the door look at the lens again.
    reportContext.setReportedScreen(['settings']);
    reportContext.setReportedScreen(TASK_SEGMENTS);

    expect(tagValue('lens')).toBe('terminal');
  });

  it('comes back to a screen with its lens, whichever of the two reports first', async () => {
    const screenFirst = await loadFreshModule();
    screenFirst.setReportedScreen(TASK_SEGMENTS);
    screenFirst.setReportedLens('/task/[taskId]', 'changes', 'instance-a');
    screenFirst.clearReportedLens('/task/[taskId]', 'instance-a');
    screenFirst.setReportedScreen(['task-actions']);
    sentryState.addBreadcrumb.mockClear();
    screenFirst.setReportedScreen(TASK_SEGMENTS);
    screenFirst.setReportedLens('/task/[taskId]', 'changes', 'instance-a');
    expect(navigationData()).toEqual([{ screen: '/task/[taskId]', lens: 'changes' }]);

    const lensFirst = await loadFreshModule();
    lensFirst.setReportedScreen(TASK_SEGMENTS);
    lensFirst.setReportedLens('/task/[taskId]', 'changes', 'instance-a');
    lensFirst.clearReportedLens('/task/[taskId]', 'instance-a');
    lensFirst.setReportedScreen(['task-actions']);
    sentryState.addBreadcrumb.mockClear();
    lensFirst.setReportedLens('/task/[taskId]', 'changes', 'instance-a');
    lensFirst.setReportedScreen(TASK_SEGMENTS);
    expect(navigationData()).toEqual([{ screen: '/task/[taskId]', lens: 'changes' }]);
  });

  it('records a lens change on the showing screen as one breadcrumb, across the clear that precedes it', async () => {
    // A focus effect re-runs as cleanup then setup, so a lens change reaches
    // the door as a clear followed by a set.
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedLens('/task/[taskId]', 'terminal', 'instance-a');
    sentryState.addBreadcrumb.mockClear();

    reportContext.clearReportedLens('/task/[taskId]', 'instance-a');
    reportContext.setReportedLens('/task/[taskId]', 'chat', 'instance-a');

    expect(navigationData()).toEqual([{ screen: '/task/[taskId]', lens: 'chat' }]);
    expect(tagValue('lens')).toBe('chat');
  });

  it('records nothing for another task opened on the same route with the same lens', async () => {
    // Only the ID changed, and the ID is the one thing a report may not carry.
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedLens('/task/[taskId]', 'chat', 'instance-a');
    sentryState.addBreadcrumb.mockClear();
    sentryState.setTag.mockClear();

    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedLens('/task/[taskId]', 'chat', 'instance-b');
    reportContext.clearReportedLens('/task/[taskId]', 'instance-a');

    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
    expect(sentryState.setTag).not.toHaveBeenCalled();
  });

  it('refuses a lens or a screen outside the closed sets, whatever the caller cast', async () => {
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(['settings']);
    sentryState.addBreadcrumb.mockClear();
    sentryState.setTag.mockClear();

    reportContext.setReportedLens('/task/[taskId]', 'the task title' as never, 'instance-a');
    reportContext.setReportedLens('/settings' as never, 'chat', 'instance-a');
    reportContext.setReportedScreen(TASK_SEGMENTS);

    // Neither refused call stored a lens: the session arrives with none known.
    expect(tagValue('lens')).toBe('none');
    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('does nothing when crash reporting never started', async () => {
    crashReportingState.initialized = false;
    const reportContext = await loadFreshModule();
    reportContext.setReportedLens('/task/[taskId]', 'chat', 'instance-a');
    reportContext.clearReportedLens('/task/[taskId]', 'instance-a');

    expect(sentryState.setTag).not.toHaveBeenCalled();
    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
  });
});

describe('recordConnectionState', () => {
  it.each([...CONNECTION_BREADCRUMB_STATE_LIST])(
    'records %s as a breadcrumb carrying that state and nothing else',
    async (state) => {
      const reportContext = await loadFreshModule();
      reportContext.recordConnectionState(state);

      const breadcrumbs = breadcrumbsIn(CONNECTION_BREADCRUMB_CATEGORY);
      expect(breadcrumbs).toHaveLength(1);
      expect(breadcrumbs[0]?.data).toEqual({ state });
      // The message repeats the state so the CLI's trail view has something to
      // print; it must add nothing to it.
      expect(breadcrumbs[0]?.message).toBe(state);
      expect(Object.keys(breadcrumbs[0] ?? {}).sort()).toEqual(['category', 'data', 'level', 'message']);
    },
  );

  it('records nothing for a value outside the union, so free text cannot ride the trail', async () => {
    // The mutation this guards: trusting the parameter's type. A cast, or a
    // caller that passed a transport string straight through, would otherwise
    // put whatever it held into a breadcrumb.
    const reportContext = await loadFreshModule();

    reportContext.recordConnectionState('idle' as never);
    reportContext.recordConnectionState('wss://relay.example/slot/deadbeef' as never);
    reportContext.recordConnectionState(42 as never);

    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('leaves the screen tags alone', async () => {
    const reportContext = await loadFreshModule();
    reportContext.recordConnectionState('established');

    expect(sentryState.setTag).not.toHaveBeenCalled();
  });

  it('does nothing when crash reporting never started', async () => {
    crashReportingState.initialized = false;
    const reportContext = await loadFreshModule();
    reportContext.recordConnectionState('established');

    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
  });

  it('never throws into the store update that reported it', async () => {
    sentryState.addBreadcrumb.mockImplementationOnce(() => {
      throw new Error('native module gone');
    });
    const reportContext = await loadFreshModule();

    expect(() => reportContext.recordConnectionState('closed')).not.toThrow();
  });
});
