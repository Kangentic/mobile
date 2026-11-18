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
      expect(Object.keys(breadcrumb).sort()).toEqual(['category', 'data', 'level']);
    }
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

describe('setReportedLens', () => {
  it('tags the lens while its screen is the one showing', async () => {
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedLens('/task/[taskId]', 'chat');

    expect(tagValue('screen')).toBe('/task/[taskId]');
    expect(tagValue('lens')).toBe('chat');
    expect(breadcrumbsIn(NAVIGATION_BREADCRUMB_CATEGORY).at(-1)?.data).toEqual({
      screen: '/task/[taskId]',
      lens: 'chat',
    });
  });

  it('records ONE breadcrumb when the lens arrives before the screen, which is the order a mounting screen reports in', async () => {
    // A screen's focus effect runs before the root tracker's effect (a later
    // sibling commits last). The lens lands first and must wait, silently, for
    // its screen: the one crumb the tracker then records already carries it.
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(['(tabs)']);
    sentryState.addBreadcrumb.mockClear();

    reportContext.setReportedLens('/task/[taskId]', 'terminal');
    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
    expect(tagValue('lens')).toBe('none');

    reportContext.setReportedScreen(TASK_SEGMENTS);
    expect(breadcrumbsIn(NAVIGATION_BREADCRUMB_CATEGORY).map((breadcrumb) => breadcrumb.data)).toEqual([
      { screen: '/task/[taskId]', lens: 'terminal' },
    ]);
  });

  it('reads none on a screen that owns no lens, however recently a lens was set', async () => {
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedLens('/task/[taskId]', 'chat');

    reportContext.setReportedScreen(['settings']);

    expect(tagValue('screen')).toBe('/settings');
    expect(tagValue('lens')).toBe('none');
  });

  it("keeps each screen's lens to that screen: a completed task's lens never shows on a session", async () => {
    // The mutation this guards: one shared "current lens" slot instead of a
    // lens per owning screen.
    const reportContext = await loadFreshModule();
    reportContext.setReportedLens('/completed-task', 'summary');
    reportContext.setReportedLens('/task/[taskId]', 'terminal');

    reportContext.setReportedScreen(['completed-task']);
    expect(tagValue('lens')).toBe('summary');

    reportContext.setReportedScreen(TASK_SEGMENTS);
    expect(tagValue('lens')).toBe('terminal');
  });

  it('restores the lens on the way back to a screen, with no blur ever having cleared it', async () => {
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedLens('/task/[taskId]', 'changes');
    reportContext.setReportedScreen(['task-actions']);
    sentryState.addBreadcrumb.mockClear();

    reportContext.setReportedScreen(TASK_SEGMENTS);

    expect(breadcrumbsIn(NAVIGATION_BREADCRUMB_CATEGORY).map((breadcrumb) => breadcrumb.data)).toEqual([
      { screen: '/task/[taskId]', lens: 'changes' },
    ]);
  });

  it('records a lens change on the showing screen as its own breadcrumb', async () => {
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);
    reportContext.setReportedLens('/task/[taskId]', 'terminal');
    reportContext.setReportedLens('/task/[taskId]', 'chat');

    expect(breadcrumbsIn(NAVIGATION_BREADCRUMB_CATEGORY).map((breadcrumb) => breadcrumb.data)).toEqual([
      { screen: '/task/[taskId]', lens: 'none' },
      { screen: '/task/[taskId]', lens: 'terminal' },
      { screen: '/task/[taskId]', lens: 'chat' },
    ]);
  });

  it('refuses a lens or an owner outside the closed sets, whatever the caller cast', async () => {
    const reportContext = await loadFreshModule();
    reportContext.setReportedScreen(TASK_SEGMENTS);
    sentryState.addBreadcrumb.mockClear();
    sentryState.setTag.mockClear();

    reportContext.setReportedLens('/task/[taskId]', 'the task title' as never);
    reportContext.setReportedLens('/settings' as never, 'chat');

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
      expect(Object.keys(breadcrumbs[0] ?? {}).sort()).toEqual(['category', 'data', 'level']);
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
