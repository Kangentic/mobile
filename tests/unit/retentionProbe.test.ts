import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * `src/devsupport/retentionProbe.ts` is an env-gated escape hatch, same
 * mechanism as `EXPO_PUBLIC_KANGENTIC_CRASHTEST` and `_E2E`: "Never on in a
 * store build" is a safety property, not a UI nicety, because the variants it
 * unlocks include rendering a plain Text swap for the transcript and a
 * closed motion gate - a live control surface no shipped build should expose.
 *
 * `probeEnabled` is captured as a MODULE-LEVEL const at import time, unlike
 * `crashTestEnabled()` in crashReporting.ts, which re-reads `process.env` on
 * every call. So the env var has to be set BEFORE the module is imported, and
 * every scenario needs its own fresh module instance
 * (`vi.resetModules()` + a dynamic import) - the same pattern
 * `tests/unit/crashReporting.test.ts` uses for `EXPO_PUBLIC_SENTRY_DSN`.
 *
 * The source gates `probeEnabled` in two places - `setRetentionProbeVariant`
 * refuses to move `activeVariant` off `'off'`, and `getRetentionProbeVariant`
 * separately refuses to report anything but `'off'`. Confirmed by mutation:
 * removing either guard ALONE still leaves this suite green, because the
 * other one masks it (the setter guard alone means `activeVariant` never
 * changes, so an unguarded getter still reads `'off'`; the getter guard alone
 * means a corrupted `activeVariant` is never surfaced). Only removing BOTH at
 * once reddens "is disabled and inert when the flag is unset" with "expected
 * 'off', received 'no-motion'" - the black-box contract this file actually
 * pins is "flag off implies setting a variant has no observable effect",
 * which needs both defenses breaking together to falsify from outside the
 * module. `activeVariant` and `listeners` are not exported, so a test that
 * isolates either guard individually is not possible without reaching into
 * module internals.
 */

function setProbeFlag(value: string | undefined): void {
  if (value === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_RETENTION_PROBE;
  else process.env.EXPO_PUBLIC_KANGENTIC_RETENTION_PROBE = value;
}

async function loadFreshRetentionProbe(): Promise<typeof import('@/devsupport/retentionProbe')> {
  vi.resetModules();
  return import('@/devsupport/retentionProbe');
}

describe('retentionProbe', () => {
  const originalProbeFlag = process.env.EXPO_PUBLIC_KANGENTIC_RETENTION_PROBE;

  beforeEach(() => {
    setProbeFlag(undefined);
  });

  afterEach(() => {
    setProbeFlag(originalProbeFlag);
  });

  it('is disabled and inert when the flag is unset: setting a variant has no effect', async () => {
    const retentionProbe = await loadFreshRetentionProbe();
    expect(retentionProbe.retentionProbeEnabled()).toBe(false);
    expect(retentionProbe.getRetentionProbeVariant()).toBe('off');

    retentionProbe.setRetentionProbeVariant('no-motion');

    expect(retentionProbe.getRetentionProbeVariant()).toBe('off');
  });

  it('lets a variant be set once the flag is on', async () => {
    setProbeFlag('1');
    const retentionProbe = await loadFreshRetentionProbe();
    // Guards against a silently-stale module: if resetModules/dynamic import
    // did not pick up the env change, this reads false and every assertion
    // below would pass vacuously against the 'off' branch.
    expect(retentionProbe.retentionProbeEnabled()).toBe(true);
    expect(retentionProbe.getRetentionProbeVariant()).toBe('off');

    retentionProbe.setRetentionProbeVariant('no-motion');

    expect(retentionProbe.getRetentionProbeVariant()).toBe('no-motion');
  });

  it('is a no-op for a truthy-looking value that is not the flag', async () => {
    setProbeFlag('true');
    const retentionProbe = await loadFreshRetentionProbe();
    expect(retentionProbe.retentionProbeEnabled()).toBe(false);

    retentionProbe.setRetentionProbeVariant('no-motion');

    expect(retentionProbe.getRetentionProbeVariant()).toBe('off');
  });
});
