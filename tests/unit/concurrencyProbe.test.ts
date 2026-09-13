import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/devsupport/concurrencyProbe.ts` is an env-gated escape hatch, the same
 * mechanism as the retention probe next to it and
 * `EXPO_PUBLIC_KANGENTIC_CRASHTEST`. "Never on in a store build" is the safety
 * property: this one hands a live control over how much the Agents feed may
 * allocate at once, and the whole point of the MOBILE-8 fix is that the cap is
 * not negotiable in a shipped build.
 *
 * `probeEnabled` is a MODULE-LEVEL const captured at import, so the env var has
 * to be set BEFORE the import and each scenario needs a fresh module instance.
 * Same structure, and the same reasoning, as `retentionProbe.test.ts`: the
 * source guards `probeEnabled` in both the setter and the getter, so only
 * removing BOTH falsifies the black-box contract from outside the module.
 */

/**
 * `expo-secure-store` reaches React Native, which rolldown cannot parse under
 * vitest - the same failure that made `scrubEvent.ts` own the breadcrumb
 * category constant rather than importing it. Mocked by specifier, with a real
 * backing map so the persistence this probe depends on is actually exercised.
 */
const secureStoreState = vi.hoisted(() => ({ items: new Map<string, string>() }));
vi.mock('expo-secure-store', () => ({
  getItem: (key: string) => secureStoreState.items.get(key) ?? null,
  setItem: (key: string, value: string) => {
    secureStoreState.items.set(key, value);
  },
  deleteItemAsync: (key: string) => {
    secureStoreState.items.delete(key);
    return Promise.resolve();
  },
}));

function setProbeFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_CONCURRENCY_PROBE;
  else process.env.EXPO_PUBLIC_KANGENTIC_CONCURRENCY_PROBE = value;
}

async function loadFreshConcurrencyProbe(): Promise<typeof import('@/devsupport/concurrencyProbe')> {
  vi.resetModules();
  return import('@/devsupport/concurrencyProbe');
}

describe('concurrencyProbe', () => {
  const originalProbeFlag = process.env.EXPO_PUBLIC_KANGENTIC_CONCURRENCY_PROBE;

  beforeEach(() => {
    setProbeFlag(undefined);
    secureStoreState.items.clear();
  });

  /**
   * THE load-bearing property, and the one this probe originally got wrong.
   *
   * What it measures is a COLD START: the feed pre-warms its snippets once, as
   * sessions register, and never again for the life of the process. So the arm
   * has to be chosen before the launch being measured. Held only in memory, the
   * depth resets on every force-stop, the shipped constant is the only value
   * that can ever apply at cold start, and every arm quietly measures the
   * control - a clean-looking A/B that is all baseline.
   */
  it('survives a process restart, so an arm can be chosen before the launch it measures', async () => {
    setProbeFlag('1');
    const firstLaunch = await loadFreshConcurrencyProbe();
    firstLaunch.setConcurrencyProbeDepth(8);
    expect(firstLaunch.getConcurrencyProbeDepth()).toBe(8);

    // A fresh module instance is what a force-stop and relaunch amounts to.
    const secondLaunch = await loadFreshConcurrencyProbe();

    expect(secondLaunch.getConcurrencyProbeDepth()).toBe(8);
  });

  it('returns to the shipped constant when the control arm is chosen', async () => {
    setProbeFlag('1');
    const firstLaunch = await loadFreshConcurrencyProbe();
    firstLaunch.setConcurrencyProbeDepth(8);
    firstLaunch.setConcurrencyProbeDepth(null);

    const secondLaunch = await loadFreshConcurrencyProbe();

    expect(secondLaunch.getConcurrencyProbeDepth()).toBeNull();
  });

  it('ignores a persisted depth that is not an offered arm', async () => {
    setProbeFlag('1');
    // A hand-edited or stale value must not reach the queue: createBoundedTaskQueue
    // throws a RangeError on a non-positive integer, which would be a crash at
    // the feed's first render rather than a bad measurement.
    secureStoreState.items.set('kangentic.probe.snippetWarmDepth', '0');
    const probe = await loadFreshConcurrencyProbe();

    expect(probe.getConcurrencyProbeDepth()).toBeNull();
  });

  it('does not read persisted state at all when the flag is off', async () => {
    secureStoreState.items.set('kangentic.probe.snippetWarmDepth', '8');
    const probe = await loadFreshConcurrencyProbe();

    // A store build must collapse to the shipped constant even if a value is
    // somehow present.
    expect(probe.getConcurrencyProbeDepth()).toBeNull();
  });

  afterEach(() => {
    setProbeFlag(originalProbeFlag);
  });

  it('is disabled and inert when the flag is unset: setting a depth has no effect', async () => {
    const concurrencyProbe = await loadFreshConcurrencyProbe();
    expect(concurrencyProbe.concurrencyProbeEnabled()).toBe(false);
    expect(concurrencyProbe.getConcurrencyProbeDepth()).toBeNull();

    concurrencyProbe.setConcurrencyProbeDepth(8);

    // Null, not 8: the feed then falls back to its shipped constant.
    expect(concurrencyProbe.getConcurrencyProbeDepth()).toBeNull();
  });

  it('lets a depth be set once the flag is on', async () => {
    setProbeFlag('1');
    const concurrencyProbe = await loadFreshConcurrencyProbe();
    // Guards against a silently-stale module: if resetModules did not pick up
    // the env change this reads false and everything below passes vacuously.
    expect(concurrencyProbe.concurrencyProbeEnabled()).toBe(true);
    expect(concurrencyProbe.getConcurrencyProbeDepth()).toBeNull();

    concurrencyProbe.setConcurrencyProbeDepth(8);
    expect(concurrencyProbe.getConcurrencyProbeDepth()).toBe(8);

    // And back to the shipped constant, which is the control arm.
    concurrencyProbe.setConcurrencyProbeDepth(null);
    expect(concurrencyProbe.getConcurrencyProbeDepth()).toBeNull();
  });

  it('is a no-op for a truthy-looking value that is not the flag', async () => {
    setProbeFlag('true');
    const concurrencyProbe = await loadFreshConcurrencyProbe();
    expect(concurrencyProbe.concurrencyProbeEnabled()).toBe(false);

    concurrencyProbe.setConcurrencyProbeDepth(8);

    expect(concurrencyProbe.getConcurrencyProbeDepth()).toBeNull();
  });

  it('offers a fully serial arm, which is what bounds what concurrency can cost', async () => {
    const concurrencyProbe = await loadFreshConcurrencyProbe();
    expect(concurrencyProbe.CONCURRENCY_PROBE_DEPTHS).toContain(1);
    // Ascending, so the Settings list reads as a sweep rather than a set.
    const depths = [...concurrencyProbe.CONCURRENCY_PROBE_DEPTHS];
    expect(depths).toEqual([...depths].sort((left, right) => left - right));
  });
});
