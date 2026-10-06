/**
 * The R8 optimization plugin: the preset swap that turns optimization on, the
 * gradle property that turns on optimized resource shrinking, and the ci.yml
 * greps that prove both reached a real prebuild.
 *
 * Split the same way as androidCmakeBuildStaging.test.ts, each layer where it
 * can actually run:
 *   1. here, over the pure transforms and the mods the plugin registers;
 *   2. ci.yml's Native config job, grepping the real prebuilt build.gradle and
 *      gradle.properties;
 *   3. .github/scripts/verify-r8-optimization.sh, over the merged R8
 *      configuration a real release build wrote (tested in
 *      verifyR8Optimization.test.ts).
 *
 * Only the third proves optimization is ON. A library consumer rule carrying
 * `-dontoptimize` disables it app-wide however the preset is set, and nothing
 * at this layer can see that.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ExpoConfig } from 'expo/config';
import type { ExportedConfig } from '@expo/config-plugins';

import withAndroidR8Optimization, {
  applyOptimizedProguardPreset,
  OPTIMIZED_PRESET_CALL,
  OPTIMIZED_RESOURCE_SHRINKING_PROPERTY,
  UNOPTIMIZED_PRESET_CALL,
} from '../../plugins/withAndroidR8Optimization';

/**
 * The release block of `android/app/build.gradle` as `expo prebuild`
 * generates it for this app on SDK 57 (identical at 0.8.1). Copied verbatim
 * rather than minimised, so an upstream template change that would break the
 * swap shows up here.
 */
const GENERATED_BUILD_TYPES = `    buildTypes {
        debug {
            signingConfig signingConfigs.debug
        }
        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
            def enableShrinkResources = findProperty('android.enableShrinkResourcesInReleaseBuilds') ?: 'false'
            shrinkResources enableShrinkResources.toBoolean()
            minifyEnabled enableMinifyInReleaseBuilds
            proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"
            def enablePngCrunchInRelease = findProperty('android.enablePngCrunchInReleaseBuilds') ?: 'true'
            crunchPngs enablePngCrunchInRelease.toBoolean()
        }
    }
`;

/** What the SDK 58 template is expected to hold: the optimize preset already. */
const SDK_58_SHAPED_BUILD_TYPES = GENERATED_BUILD_TYPES.replace(
  'getDefaultProguardFile("proguard-android.txt")',
  'getDefaultProguardFile("proguard-android-optimize.txt")',
);

describe('applyOptimizedProguardPreset', () => {
  it('starts from a fixture that carries the unoptimized preset', () => {
    // Non-vacuity guard: every swap assertion below is meaningless against a
    // fixture that already names the optimize preset.
    expect(GENERATED_BUILD_TYPES).toContain(UNOPTIMIZED_PRESET_CALL);
    expect(GENERATED_BUILD_TYPES).not.toContain(OPTIMIZED_PRESET_CALL);
  });

  it('swaps the -dontoptimize preset for the optimizing one', () => {
    const result = applyOptimizedProguardPreset(GENERATED_BUILD_TYPES);
    expect(result).toContain(
      'proguardFiles getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro"',
    );
    expect(result).not.toContain(UNOPTIMIZED_PRESET_CALL);
  });

  it('keeps the app rules file and everything else the template generated', () => {
    const result = applyOptimizedProguardPreset(GENERATED_BUILD_TYPES);
    // proguard-rules.pro is where expo-build-properties appends
    // extraProguardRules, including the HeadlessAppLoader keep rule that
    // killed-app push depends on. Dropping it would be a silent push outage.
    expect(result).toContain('"proguard-rules.pro"');
    expect(result).toContain('minifyEnabled enableMinifyInReleaseBuilds');
    expect(result).toContain('shrinkResources enableShrinkResources.toBoolean()');
    expect(result.replace(OPTIMIZED_PRESET_CALL, UNOPTIMIZED_PRESET_CALL)).toBe(GENERATED_BUILD_TYPES);
  });

  it('is a no-op on a template that already uses the optimize preset (SDK 58)', () => {
    expect(applyOptimizedProguardPreset(SDK_58_SHAPED_BUILD_TYPES)).toBe(SDK_58_SHAPED_BUILD_TYPES);
  });

  it('is idempotent, so a repeated prebuild leaves one optimize preset', () => {
    const once = applyOptimizedProguardPreset(GENERATED_BUILD_TYPES);
    expect(applyOptimizedProguardPreset(once)).toBe(once);
  });

  it('throws rather than skipping when the template names neither preset', () => {
    // The withIosManualSigning lesson: a plugin that finds nothing to edit and
    // carries on ships the unedited build with every check green.
    const unrecognised = GENERATED_BUILD_TYPES.replace(UNOPTIMIZED_PRESET_CALL, 'getDefaultProguardFile("something-else.txt")');
    expect(() => applyOptimizedProguardPreset(unrecognised)).toThrow(/withAndroidR8Optimization/);
  });
});

interface ContentsModConfig {
  modResults: { contents: string; language: string; path: string };
}

interface PropertyItem {
  type: 'property';
  key: string;
  value: string;
}

interface CommentItem {
  type: 'comment';
  value: string;
}

interface PropertiesModConfig {
  modResults: (PropertyItem | CommentItem)[];
}

/** Async because @expo/config-plugins wraps every mod in an async interceptor. */
type ContentsMod = (config: ContentsModConfig) => Promise<ContentsModConfig>;
type PropertiesMod = (config: PropertiesModConfig) => Promise<PropertiesModConfig>;

function baseConfig(): ExpoConfig {
  return { name: 'Kangentic', slug: 'kangentic-mobile' };
}

function registeredMods(config: ExpoConfig): { appBuildGradle?: ContentsMod; gradleProperties?: PropertiesMod } {
  // Not object identity: the with* helpers MUTATE the config they are given,
  // so the registered mod is the only observable difference.
  const androidMods = (config as ExportedConfig).mods?.android;
  return {
    appBuildGradle: androidMods?.appBuildGradle as unknown as ContentsMod | undefined,
    gradleProperties: androidMods?.gradleProperties as unknown as PropertiesMod | undefined,
  };
}

function buildGradleModConfig(language: string): ContentsModConfig {
  return { modResults: { contents: GENERATED_BUILD_TYPES, language, path: 'android/app/build.gradle' } };
}

describe('withAndroidR8Optimization', () => {
  it('registers both an app build.gradle mod and a gradle.properties mod', () => {
    const mods = registeredMods(withAndroidR8Optimization(baseConfig()));
    expect(typeof mods.appBuildGradle).toBe('function');
    expect(typeof mods.gradleProperties).toBe('function');
  });

  it('writes the optimize preset into the generated build.gradle', async () => {
    const mod = registeredMods(withAndroidR8Optimization(baseConfig())).appBuildGradle;
    const result = await mod?.(buildGradleModConfig('groovy'));
    expect(result?.modResults.contents).toContain(OPTIMIZED_PRESET_CALL);
    expect(result?.modResults.contents).not.toContain(UNOPTIMIZED_PRESET_CALL);
  });

  it('throws rather than editing a Kotlin DSL build file it cannot parse', async () => {
    const mod = registeredMods(withAndroidR8Optimization(baseConfig())).appBuildGradle;
    await expect(mod?.(buildGradleModConfig('kt'))).rejects.toThrow(/Groovy/);
  });

  it('sets android.r8.optimizedResourceShrinking=true', async () => {
    const mod = registeredMods(withAndroidR8Optimization(baseConfig())).gradleProperties;
    const result = await mod?.({ modResults: [{ type: 'property', key: 'android.useAndroidX', value: 'true' }] });
    expect(result?.modResults).toContainEqual({
      type: 'property',
      key: OPTIMIZED_RESOURCE_SHRINKING_PROPERTY,
      value: 'true',
    });
    expect(result?.modResults).toContainEqual({ type: 'property', key: 'android.useAndroidX', value: 'true' });
  });

  it('replaces an existing value rather than writing the key twice', async () => {
    // A repeated prebuild merges into the existing gradle.properties, so the
    // key can already be present, including with the wrong value.
    const mod = registeredMods(withAndroidR8Optimization(baseConfig())).gradleProperties;
    const result = await mod?.({
      modResults: [{ type: 'property', key: OPTIMIZED_RESOURCE_SHRINKING_PROPERTY, value: 'false' }],
    });
    const matching = (result?.modResults ?? []).filter(
      (item) => item.type === 'property' && item.key === OPTIMIZED_RESOURCE_SHRINKING_PROPERTY,
    );
    expect(matching).toEqual([{ type: 'property', key: OPTIMIZED_RESOURCE_SHRINKING_PROPERTY, value: 'true' }]);
  });
});

/**
 * ci.yml greps the generated files for these exact strings - a shell step
 * cannot import a TypeScript constant. Nothing else ties those copies to the
 * plugin, so renaming a constant would leave CI asserting a string that no
 * longer exists, failing with a message that blames the build.
 */
describe("ci.yml's R8 optimization assertions", () => {
  const ciWorkflow = readFileSync(
    join(fileURLToPath(new URL('../..', import.meta.url)), '.github/workflows/ci.yml'),
    'utf8',
  );

  it('greps build.gradle for the optimize preset the plugin writes', () => {
    expect(ciWorkflow).toContain('proguard-android-optimize.txt');
  });

  it('greps gradle.properties for the property the plugin sets', () => {
    expect(ciWorkflow).toContain(`^${OPTIMIZED_RESOURCE_SHRINKING_PROPERTY.replace(/\./g, '\\.')}=true$`);
  });
});
