/**
 * The INERT direction of the profiling opt-in: with the flag unset, the plugin
 * must hand back the config untouched. `<profileable android:shell="true"/>`
 * opens simpleperf CPU sampling AND Perfetto's heapprofd to any local shell on
 * the device, and this app's crypto is pure TypeScript on Hermes - Noise keys
 * and decrypted transcript content live in the JS heap rather than behind a
 * native module - so that exposure must never reach a `preview` or
 * `production` build. See `plugins/withAndroidProfileable.ts`.
 *
 * Unlike the e2e carve-outs (`tests/unit/androidE2ePlugins.test.ts`), no CI job
 * prebuilds with EXPO_PUBLIC_KANGENTIC_PROFILEABLE=1 and greps the generated
 * manifest, so this file is the only mechanical check that the plugin wires the
 * node in at all when the flag IS set. Whether Expo's manifest merge preserves
 * `android:shell` end to end through a real prebuild is unverified by anything
 * in this repo.
 */
import { describe, expect, it } from 'vitest';
import type { ExpoConfig } from 'expo/config';
import type { ExportedConfig } from '@expo/config-plugins';
import withAndroidProfileable from '../../plugins/withAndroidProfileable';

/**
 * The plugin reads the flag when it is CALLED (not at module-evaluation time),
 * so a single static import is enough and the flag only needs to be set across
 * the call itself. See the same note in androidE2ePlugins.test.ts.
 */
function applyPluginWithProfileableFlag(flagValue: string | undefined, config: ExpoConfig): ExpoConfig {
  const previous = process.env.EXPO_PUBLIC_KANGENTIC_PROFILEABLE;
  if (flagValue === undefined) {
    delete process.env.EXPO_PUBLIC_KANGENTIC_PROFILEABLE;
  } else {
    process.env.EXPO_PUBLIC_KANGENTIC_PROFILEABLE = flagValue;
  }
  try {
    return withAndroidProfileable(config);
  } finally {
    if (previous === undefined) {
      delete process.env.EXPO_PUBLIC_KANGENTIC_PROFILEABLE;
    } else {
      process.env.EXPO_PUBLIC_KANGENTIC_PROFILEABLE = previous;
    }
  }
}

function baseConfig(): ExpoConfig {
  return { name: 'Kangentic', slug: 'kangentic-mobile' };
}

/**
 * Whether the plugin registered an Android manifest mod. NOT object identity:
 * `withAndroidManifest` mutates the config it is given and returns that same
 * object, so `toBe(config)` is true whether the plugin ran or short-circuited.
 * The registered mod is the only observable difference at this layer - the mod
 * function itself only runs during a real prebuild.
 */
function registersManifestMod(config: ExpoConfig): boolean {
  const mods = (config as ExportedConfig).mods;
  return typeof mods?.android?.manifest === 'function';
}

describe('withAndroidProfileable', () => {
  it('registers an Android manifest mod for the exact flag value the profiling workflow sets', () => {
    expect(registersManifestMod(applyPluginWithProfileableFlag('1', baseConfig()))).toBe(true);
  });

  it('is a no-op when the profileable flag is unset, so no eas.json profile can carry it by accident', () => {
    expect(registersManifestMod(applyPluginWithProfileableFlag(undefined, baseConfig()))).toBe(false);
  });

  it('is a no-op for a truthy-looking value that is not the flag', () => {
    for (const strayValue of ['true', '0', 'yes', '']) {
      expect(registersManifestMod(applyPluginWithProfileableFlag(strayValue, baseConfig()))).toBe(false);
    }
  });
});
