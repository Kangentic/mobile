import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SentryReactNative from '@sentry/react-native';

/**
 * `src/observability/crashReporting.ts` is the single place every crash-reporting privacy
 * control lives, and those controls are the load-bearing evidence for the public claims in
 * docs/privacy-policy.md, docs/security.md, and the Play Data Safety / App Store privacy
 * declarations. A regression here (a flipped boolean, a filter literal that stops matching
 * after an SDK bump) ships silently: ESLint, tsc, and every other test stay green. This file
 * pins every option passed to `Sentry.init`, byte for byte, against that intent rather than
 * against whatever the source happens to compute.
 *
 * `@sentry/react-native` is mocked below (a string passed to `vi.mock`, not an import
 * declaration), so it does not trip the `no-restricted-imports` zone that confines the real SDK
 * to src/observability/. The only reference to the real package is the type-only import above,
 * which `allowTypeImports` exempts (see .claude/rules/crash-reporting-scope.md).
 */

const sentryState = vi.hoisted(() => {
  const freshBreadcrumbsIntegration = { name: 'Breadcrumbs' };
  return {
    init: vi.fn(),
    breadcrumbsIntegration: vi.fn(() => freshBreadcrumbsIntegration),
    freshBreadcrumbsIntegration,
  };
});

vi.mock('@sentry/react-native', () => ({
  init: sentryState.init,
  breadcrumbsIntegration: sentryState.breadcrumbsIntegration,
}));

type ReactNativeInitOptions = Parameters<typeof SentryReactNative.init>[0];

const testDsn = 'https://examplePublicKey@o0.ingest.sentry.io/0';

/**
 * `initializeCrashReporting()` guards itself with a module-level `initialized` flag, so every
 * scenario below needs its own fresh module instance or the guard silently no-ops after the
 * first test. `vi.resetModules()` clears the registry; the next dynamic import re-evaluates
 * crashReporting.ts (and, transitively, scrubEvent.ts) from scratch.
 */
async function loadFreshCrashReporting(): Promise<typeof import('@/observability/crashReporting')> {
  vi.resetModules();
  return import('@/observability/crashReporting');
}

/**
 * The beforeBreadcrumb/beforeSend identity check needs to compare against the SAME module
 * instance of scrubEvent.ts that crashReporting.ts itself resolved, not against a copy loaded
 * before the registry was last reset. Importing both from the same post-reset generation,
 * regardless of which specifier resolves first, guarantees they share one cached instance keyed
 * by resolved file path.
 */
async function loadFreshCrashReportingWithScrubEvent(): Promise<{
  crashReporting: typeof import('@/observability/crashReporting');
  scrubEvent: typeof import('@/observability/scrubEvent');
}> {
  vi.resetModules();
  const [crashReporting, scrubEvent] = await Promise.all([
    import('@/observability/crashReporting'),
    import('@/observability/scrubEvent'),
  ]);
  return { crashReporting, scrubEvent };
}

function setSentryDsn(value: string | undefined): void {
  if (value === undefined) delete process.env.EXPO_PUBLIC_SENTRY_DSN;
  else process.env.EXPO_PUBLIC_SENTRY_DSN = value;
}

function setE2eFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_E2E;
  else process.env.EXPO_PUBLIC_KANGENTIC_E2E = value;
}

function requireCapturedInitOptions(): ReactNativeInitOptions {
  const firstCall = sentryState.init.mock.calls[0];
  if (firstCall === undefined) {
    throw new Error('Sentry.init was not called');
  }
  return firstCall[0] as ReactNativeInitOptions;
}

describe('initializeCrashReporting', () => {
  const originalDsn = process.env.EXPO_PUBLIC_SENTRY_DSN;
  const originalE2eFlag = process.env.EXPO_PUBLIC_KANGENTIC_E2E;

  beforeEach(() => {
    sentryState.init.mockClear();
    sentryState.breadcrumbsIntegration.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    setSentryDsn(originalDsn);
    setE2eFlag(originalE2eFlag);
  });

  it('sets every privacy-critical option, so no screenshot, view hierarchy, PII, or telemetry leaves the device', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    const options = requireCapturedInitOptions();
    expect(options.dsn).toBe(testDsn);
    expect(options.sendDefaultPii).toBe(false);
    expect(options.attachScreenshot).toBe(false);
    expect(options.attachViewHierarchy).toBe(false);
    expect(options.enableCaptureFailedRequests).toBe(false);
    expect(options.enableAutoSessionTracking).toBe(false);
    expect(options.enableAutoPerformanceTracing).toBe(false);
    expect(options.enableUserInteractionTracing).toBe(false);
    expect(options.enableLogs).toBe(false);
    // Absent, NOT 0. The SDK gates its tracing integrations on
    // `typeof tracesSampleRate === 'number'`, so an explicit 0 registers them
    // and merely samples every span away. `in` rather than a value check,
    // because `toBeUndefined()` would pass for an explicitly-set undefined too.
    expect('tracesSampleRate' in options).toBe(false);
  });

  it('drops the default Breadcrumbs integration and replaces it with a hardened, allowlisted one', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    const options = requireCapturedInitOptions();
    const integrationsFactory = options.integrations;
    if (typeof integrationsFactory !== 'function') {
      throw new Error('expected the integrations option to be a factory function');
    }

    const defaultDedupeEntry = { name: 'Dedupe' };
    const defaultBreadcrumbsEntry = { name: 'Breadcrumbs' };
    const defaultHttpContextEntry = { name: 'HttpContext' };
    const syntheticDefaultIntegrations = [defaultDedupeEntry, defaultBreadcrumbsEntry, defaultHttpContextEntry];

    const resultIntegrations = integrationsFactory(syntheticDefaultIntegrations);

    // The default's own Breadcrumbs instance must not survive the filter.
    expect(resultIntegrations).not.toContain(defaultBreadcrumbsEntry);
    // Unrelated defaults pass through untouched.
    expect(resultIntegrations).toContain(defaultDedupeEntry);
    expect(resultIntegrations).toContain(defaultHttpContextEntry);
    // Exactly one Breadcrumbs integration survives, and it is the hardened replacement.
    expect(resultIntegrations.filter((integration) => integration.name === 'Breadcrumbs')).toHaveLength(1);
    expect(resultIntegrations).toContain(sentryState.freshBreadcrumbsIntegration);

    expect(sentryState.breadcrumbsIntegration).toHaveBeenCalledWith({
      console: false,
      xhr: false,
      fetch: false,
      dom: false,
      history: false,
      sentry: true,
    });
  });

  it('ignores exactly the three known transport-noise patterns, and caps breadcrumbs at 20', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    const options = requireCapturedInitOptions();
    expect(options.maxBreadcrumbs).toBe(20);

    const ignoreErrors = options.ignoreErrors;
    if (ignoreErrors === undefined) {
      throw new Error('ignoreErrors was not set');
    }
    expect(ignoreErrors).toHaveLength(3);
    const patternShapes = ignoreErrors.map((pattern) => {
      if (!(pattern instanceof RegExp)) {
        throw new Error('expected every ignoreErrors entry to be a RegExp');
      }
      return { source: pattern.source, flags: pattern.flags };
    });
    expect(patternShapes).toEqual([
      { source: 'Network request failed', flags: 'i' },
      { source: 'Relay connection closed before it opened', flags: 'i' },
      { source: 'RelayTransport\\.send\\(\\) called while not connected', flags: 'i' },
    ]);
  });

  it('wires beforeBreadcrumb and beforeSend to the real allowlistBreadcrumb and scrubEvent functions', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const { crashReporting, scrubEvent } = await loadFreshCrashReportingWithScrubEvent();
    crashReporting.initializeCrashReporting();

    const options = requireCapturedInitOptions();
    expect(options.beforeBreadcrumb).toBe(scrubEvent.allowlistBreadcrumb);
    expect(options.beforeSend).toBe(scrubEvent.scrubEvent);
  });

  it('resolves environment to e2e when the e2e flag is "1" and __DEV__ is false', async () => {
    setSentryDsn(testDsn);
    setE2eFlag('1');
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(requireCapturedInitOptions().environment).toBe('e2e');
  });

  it('resolves environment to production when __DEV__ is false and the e2e flag is unset', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(requireCapturedInitOptions().environment).toBe('production');
  });

  // Bonus coverage beyond the two branches asked for: this repo's vitest tier does not define
  // __DEV__ by default (confirmed against tests/unit/connectionManager.test.ts and
  // tests/unit/qr.test.ts, which both stub it explicitly before reaching code that reads it),
  // so all three branches are honestly reachable by stubbing the global ourselves the same way.
  it('resolves environment to development when __DEV__ is true, regardless of the e2e flag', async () => {
    setSentryDsn(testDsn);
    setE2eFlag('1');
    vi.stubGlobal('__DEV__', true);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(requireCapturedInitOptions().environment).toBe('development');
  });

  it('never calls Sentry.init when EXPO_PUBLIC_SENTRY_DSN is unset', async () => {
    setSentryDsn(undefined);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(sentryState.init).not.toHaveBeenCalled();
  });

  it('never calls Sentry.init when EXPO_PUBLIC_SENTRY_DSN is the empty string', async () => {
    setSentryDsn('');
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(sentryState.init).not.toHaveBeenCalled();
  });

  it('calls Sentry.init exactly once even when initializeCrashReporting is called twice', async () => {
    setSentryDsn(testDsn);
    setE2eFlag(undefined);
    vi.stubGlobal('__DEV__', false);

    const crashReporting = await loadFreshCrashReporting();
    crashReporting.initializeCrashReporting();
    crashReporting.initializeCrashReporting();

    expect(sentryState.init).toHaveBeenCalledTimes(1);
  });
});
