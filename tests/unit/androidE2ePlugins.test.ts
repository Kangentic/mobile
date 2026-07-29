/**
 * The INERT direction of the e2e-only Android carve-outs: with the flag unset,
 * the plugin must hand back the config untouched.
 *
 * The enabled direction is checked in `ci.yml`'s `Native config (CNG)`
 * job, by prebuilding with EXPO_PUBLIC_KANGENTIC_E2E=1 and grepping the real
 * manifest, because only a prebuild proves the attribute survives Expo's
 * manifest merge. Splitting it this way keeps the expensive half to one prebuild
 * instead of two.
 *
 * Why the inert half matters at all: `gwpAsanMode=never` disables a
 * memory-safety mitigation, so leaking it into `preview` or `production` would
 * weaken a shipping binary to buy nothing (the crash it works around is a
 * `userdebug` emulator artifact).
 */
import { describe, expect, it } from 'vitest';
import type { ExpoConfig } from 'expo/config';
import type { ExportedConfig } from '@expo/config-plugins';
import withAndroidE2eGwpAsanOff from '../../plugins/withAndroidE2eGwpAsanOff';

/**
 * Unlike app.config.ts, which reads process.env at MODULE EVALUATION time and
 * therefore needs `vi.resetModules()` plus a fresh import per flag state, this
 * plugin reads the flag when it is CALLED. So the flag only has to be set
 * across the call, and a single static import is enough.
 *
 * Worth stating because the reverse mistake is silent: set the env, import the
 * module, restore the env in a `finally`, then call the plugin, and the plugin
 * sees the restored value while the test reads as though it were testing the
 * set one.
 */
function applyPluginWithE2eFlag(flagValue: string | undefined, config: ExpoConfig): ExpoConfig {
  const previous = process.env.EXPO_PUBLIC_KANGENTIC_E2E;
  if (flagValue === undefined) {
    delete process.env.EXPO_PUBLIC_KANGENTIC_E2E;
  } else {
    process.env.EXPO_PUBLIC_KANGENTIC_E2E = flagValue;
  }
  try {
    return withAndroidE2eGwpAsanOff(config);
  } finally {
    if (previous === undefined) {
      delete process.env.EXPO_PUBLIC_KANGENTIC_E2E;
    } else {
      process.env.EXPO_PUBLIC_KANGENTIC_E2E = previous;
    }
  }
}

function baseConfig(): ExpoConfig {
  return { name: 'Kangentic', slug: 'kangentic-mobile' };
}

/**
 * Whether the plugin registered an Android manifest mod.
 *
 * NOT object identity. `withAndroidManifest` MUTATES the config it is given and
 * returns that same object, so `toBe(config)` is true whether the plugin ran or
 * short-circuited, and an identity assertion passes vacuously in both
 * directions. The registered mod is the only observable difference.
 */
function registersManifestMod(config: ExpoConfig): boolean {
  const mods = (config as ExportedConfig).mods;
  return typeof mods?.android?.manifest === 'function';
}

describe('withAndroidE2eGwpAsanOff', () => {
  it('registers an Android manifest mod for the exact flag value the e2e profile sets', () => {
    expect(registersManifestMod(applyPluginWithE2eFlag('1', baseConfig()))).toBe(true);
  });

  it('is a no-op when the e2e flag is unset', () => {
    expect(registersManifestMod(applyPluginWithE2eFlag(undefined, baseConfig()))).toBe(false);
  });

  it('is a no-op for a truthy-looking value that is not the flag', () => {
    // Matches the exact-match discipline in src/pairing/qr.ts and the
    // usesCleartextTraffic gate: only the string '1' counts, so a stray 'true'
    // cannot switch a memory-safety mitigation off in a shipping build.
    for (const strayValue of ['true', '0', 'yes', '']) {
      expect(registersManifestMod(applyPluginWithE2eFlag(strayValue, baseConfig()))).toBe(false);
    }
  });
});
