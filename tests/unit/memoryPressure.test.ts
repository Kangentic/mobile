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

/**
 * The Android source. Resolves to the same module the source imports: both this
 * file and `src/observability/memoryPressure.ts` sit two directories below the
 * repo root, so the specifier is identical from either.
 *
 * Mocked rather than loaded because the real `modules/memory-pressure/index.ts`
 * reads `Platform.OS` and calls into `expo-modules-core`, neither of which
 * exists under the minimal `react-native` mock above. What it CANNOT cover is
 * the trim-level filter, which is Kotlin: `TRIM_MEMORY_UI_HIDDEN` being
 * excluded is the load-bearing decision in this whole feature and no JS tier
 * can assert it. That one is verified on device with `am send-trim-memory`; see
 * the developer guide.
 */
const androidPressureState = vi.hoisted(() => {
  const listeners = new Set<(level: number) => void>();
  return {
    listeners,
    removeCount: 0,
    addAndroidMemoryPressureListener: vi.fn((listener: (level: number) => void) => {
      listeners.add(listener);
      return () => {
        androidPressureState.removeCount += 1;
        listeners.delete(listener);
      };
    }),
  };
});
vi.mock('../../modules/memory-pressure', () => ({
  addAndroidMemoryPressureListener: androidPressureState.addAndroidMemoryPressureListener,
  isAndroidMemoryPressureAvailable: () => true,
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
  androidPressureState.listeners.clear();
  androidPressureState.removeCount = 0;
  androidPressureState.addAndroidMemoryPressureListener.mockClear();
});

function fireAndroidMemoryPressure(level: number): void {
  if (androidPressureState.listeners.size === 0) {
    throw new Error('the Android memory-pressure listener was never registered');
  }
  for (const listener of [...androidPressureState.listeners]) listener(level);
}

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

  /**
   * Android used to get nothing from this module at all: React Native's
   * `AppStateModule` never emits `memoryWarning`, so the whole feature was iOS
   * only. That mattered beyond coverage - Android is the only platform whose
   * memory behaviour this project can actually measure.
   */
  it('subscribes to the Android trim-memory source as well as the iOS one', async () => {
    const module = await loadFreshModule();
    module.initializeMemoryPressure();
    module.initializeMemoryPressure();

    expect(androidPressureState.addAndroidMemoryPressureListener).toHaveBeenCalledTimes(1);
  });

  it('treats an Android trim as the same signal as an iOS warning', async () => {
    const module = await loadFreshModule();
    module.initializeMemoryPressure();
    const shed = vi.fn();
    module.subscribeToMemoryPressure(shed);

    // 15 is TRIM_MEMORY_RUNNING_CRITICAL, the foreground analogue of the iOS
    // warning. The level is not carried into the breadcrumb: the payload stays
    // a bare count, so the two platforms produce indistinguishable evidence.
    fireAndroidMemoryPressure(15);

    expect(shed).toHaveBeenCalledTimes(1);
    expect(sentryState.addBreadcrumb).toHaveBeenCalledTimes(1);
    const breadcrumb = sentryState.addBreadcrumb.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(breadcrumb.category).toBe(MEMORY_PRESSURE_BREADCRUMB_CATEGORY);
    expect(breadcrumb.data).toEqual({ count: 1 });
  });

  it('counts both sources into one running tally, never two', async () => {
    const module = await loadFreshModule();
    module.initializeMemoryPressure();

    fireMemoryWarning();
    vi.advanceTimersByTime(60_000);
    fireAndroidMemoryPressure(15);

    expect(sentryState.addBreadcrumb).toHaveBeenCalledTimes(2);
    const second = sentryState.addBreadcrumb.mock.calls[1]?.[0] as Record<string, unknown>;
    // 2, not 1: one shared counter, so a build that somehow saw both sources
    // reports a single coherent episode count rather than two half-tallies.
    expect(second.data).toEqual({ count: 2 });
  });

  it('tears both sources down together', async () => {
    const module = await loadFreshModule();
    module.initializeMemoryPressure();

    module.shutdownMemoryPressure();

    expect(appStateState.remove).toHaveBeenCalledTimes(1);
    expect(androidPressureState.removeCount).toBe(1);
    expect(androidPressureState.listeners.size).toBe(0);
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
