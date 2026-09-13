import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `index.js` is the bundle entry, and it is the single point at which the
 * app's out-of-React initializers are wired. Everything it calls is
 * side-effect-only, so a DELETED line there fails completely silently: every
 * other test in this repo still passes, tsc and ESLint stay green, and the
 * shipped app simply never registers the thing. That is the failure mode
 * `.claude/rules/crash-reporting-scope.md` calls "a check that can never fire
 * is worse than none", and the same reasoning already produced
 * tests/components/PendingNavigationRunner.test.tsx and the root-layout wiring
 * test for the navigation runner.
 *
 * These assertions are about ORDER as much as presence:
 *
 * - crash reporting first, so a throw from any later initializer is reported;
 * - memory pressure immediately after, because its breadcrumb needs the SDK
 *   up, and because the episode it exists to describe (Sentry MOBILE-8) fit
 *   inside ~23 seconds of launch - arming it any later than bundle entry could
 *   miss one entirely;
 * - the shedders after the listener they subscribe to.
 *
 * Every module is mocked by string specifier: index.js pulls in
 * `expo-router/entry`, the crypto polyfills and the notifications stack, none
 * of which can load in the node-environment vitest tier.
 */

const callOrder = vi.hoisted(() => [] as string[]);

vi.mock('@/lib/cryptoPolyfills', () => {
  callOrder.push('cryptoPolyfills:imported');
  return {};
});

vi.mock('expo-router/entry', () => {
  callOrder.push('expo-router/entry:imported');
  return {};
});

vi.mock('@/observability/crashReporting', () => ({
  initializeCrashReporting: vi.fn(() => callOrder.push('initializeCrashReporting')),
}));

vi.mock('@/observability/memoryPressure', () => ({
  initializeMemoryPressure: vi.fn(() => callOrder.push('initializeMemoryPressure')),
}));

vi.mock('@/state/memoryShed', () => ({
  registerMemoryShedders: vi.fn(() => {
    callOrder.push('registerMemoryShedders');
    return () => undefined;
  }),
}));

vi.mock('@/notifications', () => ({
  initializeNotifications: vi.fn(() => callOrder.push('initializeNotifications')),
}));

async function loadBundleEntry(): Promise<void> {
  vi.resetModules();
  callOrder.length = 0;
  await import('../../index.js');
}

beforeEach(() => {
  callOrder.length = 0;
});

describe('index.js (bundle entry)', () => {
  it('arms every out-of-React initializer exactly once', async () => {
    await loadBundleEntry();

    expect(callOrder.filter((entry) => entry === 'initializeCrashReporting')).toHaveLength(1);
    expect(callOrder.filter((entry) => entry === 'initializeMemoryPressure')).toHaveLength(1);
    expect(callOrder.filter((entry) => entry === 'registerMemoryShedders')).toHaveLength(1);
    expect(callOrder.filter((entry) => entry === 'initializeNotifications')).toHaveLength(1);
  });

  it('initializes crash reporting before memory pressure, which needs the SDK up', async () => {
    await loadBundleEntry();

    expect(callOrder.indexOf('initializeCrashReporting')).toBeLessThan(callOrder.indexOf('initializeMemoryPressure'));
  });

  it('registers the shedders after the pressure listener they subscribe to', async () => {
    await loadBundleEntry();

    expect(callOrder.indexOf('initializeMemoryPressure')).toBeLessThan(callOrder.indexOf('registerMemoryShedders'));
  });

  it('runs the initializers in the documented order', async () => {
    await loadBundleEntry();

    const initializerCalls = callOrder.filter((entry) => !entry.endsWith(':imported'));
    expect(initializerCalls).toEqual([
      'initializeCrashReporting',
      'initializeMemoryPressure',
      'registerMemoryShedders',
      'initializeNotifications',
    ]);
  });
});
