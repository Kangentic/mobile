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
