import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/observability/memoryPressure.ts` exists because iOS warns before it
 * kills a foreground app for memory and this app recorded nothing - the blind
 * spot behind Sentry MOBILE-8. Its value is entirely in the breadcrumb
 * reaching the persisted native scope, so what these tests pin is the contract
 * that makes that possible: the right category (the one `scrubEvent`
 * allowlists), coalescing on the LEADING edge so a kill mid-burst still leaves
 * evidence, and no user content in the payload.
 *
 * `@sentry/react-native` and `react-native` are both mocked by string
 * specifier rather than imported, so this file does not trip the
 * `no-restricted-imports` zone confining the SDK to src/observability/.
 */

const sentryState = vi.hoisted(() => ({ addBreadcrumb: vi.fn() }));
vi.mock('@sentry/react-native', () => ({ addBreadcrumb: sentryState.addBreadcrumb }));

const appStateState = vi.hoisted(() => {
  const handlers = new Map<string, () => void>();
  const remove = vi.fn();
  return {
    handlers,
    remove,
    addEventListener: vi.fn((event: string, handler: () => void) => {
      handlers.set(event, handler);
      return { remove };
    }),
  };
});
vi.mock('react-native', () => ({
  AppState: { addEventListener: appStateState.addEventListener },
}));

const crashReportingState = vi.hoisted(() => ({ initialized: true }));
vi.mock('@/observability/crashReporting', () => ({
  isCrashReportingInitialized: () => crashReportingState.initialized,
}));

// scrubEvent.ts is deliberately React-Native-free and safe to load for real,
// which is the point of the category living there rather than beside its
// producer - see the comment on the constant.
const { MEMORY_PRESSURE_BREADCRUMB_CATEGORY } = await import('@/observability/scrubEvent');

async function loadFreshModule(): Promise<typeof import('@/observability/memoryPressure')> {
  vi.resetModules();
  return import('@/observability/memoryPressure');
}

function fireMemoryWarning(): void {
  const handler = appStateState.handlers.get('memoryWarning');
  if (handler === undefined) throw new Error('memoryWarning handler was never registered');
  handler();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-13T04:36:37.000Z'));
  appStateState.handlers.clear();
  appStateState.addEventListener.mockClear();
  appStateState.remove.mockClear();
  sentryState.addBreadcrumb.mockClear();
  crashReportingState.initialized = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('initializeMemoryPressure', () => {
  it('subscribes to the memoryWarning AppState event exactly once', async () => {
    const module = await loadFreshModule();
    module.initializeMemoryPressure();
    module.initializeMemoryPressure();

    expect(appStateState.addEventListener).toHaveBeenCalledTimes(1);
    expect(appStateState.addEventListener).toHaveBeenCalledWith('memoryWarning', expect.any(Function));
  });

  it('records a breadcrumb in the allowlisted category, carrying a count and no content', async () => {
    const module = await loadFreshModule();
    module.initializeMemoryPressure();

    fireMemoryWarning();

    expect(sentryState.addBreadcrumb).toHaveBeenCalledTimes(1);
    const breadcrumb = sentryState.addBreadcrumb.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(breadcrumb.category).toBe(MEMORY_PRESSURE_BREADCRUMB_CATEGORY);
    expect(breadcrumb.level).toBe('warning');
    // The payload is a count and nothing else. A free-text field here would be
    // the way user content could start riding a native crash report.
    expect(breadcrumb.data).toEqual({ count: 1 });
  });

  it('records on the LEADING edge, so a kill mid-burst still leaves evidence', async () => {
    const module = await loadFreshModule();
    module.initializeMemoryPressure();

    fireMemoryWarning();

    // Nothing is waiting on a timer: the breadcrumb is already in hand before
    // any further warning, which is the whole reason this is not a trailing
    // summary. Advancing the clock adds nothing.
    expect(sentryState.addBreadcrumb).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(60_000);
    expect(sentryState.addBreadcrumb).toHaveBeenCalledTimes(1);
  });

  it('coalesces a burst into one breadcrumb, then records again after the window', async () => {
    const module = await loadFreshModule();
    module.initializeMemoryPressure();

    fireMemoryWarning();
    fireMemoryWarning();
    fireMemoryWarning();
    expect(sentryState.addBreadcrumb).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(module.MEMORY_PRESSURE_COALESCE_MS + 1);
    fireMemoryWarning();

    expect(sentryState.addBreadcrumb).toHaveBeenCalledTimes(2);
    // Cumulative for the launch, so a suppressed burst stays legible in the
    // next breadcrumb that does get through.
    const second = sentryState.addBreadcrumb.mock.calls[1]?.[0] as Record<string, unknown>;
    expect(second.data).toEqual({ count: 4 });
  });

  it('still notifies listeners when crash reporting is off, and records no breadcrumb', async () => {
    crashReportingState.initialized = false;
    const module = await loadFreshModule();
    module.initializeMemoryPressure();
    const listener = vi.fn();
    module.subscribeToMemoryPressure(listener);

    fireMemoryWarning();

    // A build from source has no DSN and reports nothing, but must still shed.
    expect(listener).toHaveBeenCalledTimes(1);
    expect(sentryState.addBreadcrumb).not.toHaveBeenCalled();
  });
});

describe('subscribeToMemoryPressure', () => {
  it('notifies every listener on EVERY warning, not only the recorded ones', async () => {
    const module = await loadFreshModule();
    module.initializeMemoryPressure();
    const first = vi.fn();
    const second = vi.fn();
    module.subscribeToMemoryPressure(first);
    module.subscribeToMemoryPressure(second);

    fireMemoryWarning();
    fireMemoryWarning();

    // Coalescing governs the breadcrumb buffer, never how often it is worth
    // releasing memory.
    expect(sentryState.addBreadcrumb).toHaveBeenCalledTimes(1);
    expect(first).toHaveBeenCalledTimes(2);
    expect(second).toHaveBeenCalledTimes(2);
  });

  it('stops notifying after unsubscribe', async () => {
    const module = await loadFreshModule();
    module.initializeMemoryPressure();
    const listener = vi.fn();
    const unsubscribe = module.subscribeToMemoryPressure(listener);

    fireMemoryWarning();
    unsubscribe();
    fireMemoryWarning();

    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener neither stops the others nor escapes', async () => {
    const module = await loadFreshModule();
    module.initializeMemoryPressure();
    const survivor = vi.fn();
    module.subscribeToMemoryPressure(() => {
      throw new Error('shedder blew up');
    });
    module.subscribeToMemoryPressure(survivor);

    expect(() => fireMemoryWarning()).not.toThrow();
    expect(survivor).toHaveBeenCalledTimes(1);
  });
});
