// '@expo/config-plugins', not 'expo/config-plugins': the latter subpath does not
// exist in SDK 57, and while `expo prebuild` resolves it anyway through Expo
// CLI's own loader, `eas build` imports this file as plain Node ESM and strictly
// honours package exports. See withAndroidPushService.ts, where that difference
// cost an iOS build while every prebuild gate stayed green.
import { withAppBuildGradle, withGradleProperties, type ConfigPlugin } from '@expo/config-plugins';

/**
 * Turns R8 OPTIMIZATION on for release builds. Minification and resource
 * shrinking were already on (expo-build-properties in app.config.ts); this is
 * the half they did not reach.
 *
 * THE ADVISORY. Play Console flagged release 14 (0.8.1) with "Improve your
 * app's memory and performance with R8 optimization": optimization not
 * enabled, optimized resource shrinking not enabled, and upgrade AGP to 9.0+.
 *
 * THE ROOT CAUSE. The SDK 57 template's release block reads
 * `proguardFiles getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro"`,
 * and that preset carries `-dontoptimize`. ProGuard options are global, so one
 * `-dontoptimize` in ANY rule file turns optimization off for the whole app:
 * R8 shrank and obfuscated but never inlined, merged classes or removed dead
 * branches. A real release build's merged `configuration.txt` (AGP writes it
 * next to mapping.txt) carried exactly one `-dontoptimize`, in the
 * `proguard-android.txt-8.12.0` section, and none from any library.
 *
 * WHY A PLUGIN. expo-build-properties 57 has no knob for either setting (its
 * Android release options are minify, shrinkResources, crunchPngs, bundle
 * compression and extraProguardRules), and `extraProguardRules` cannot undo a
 * global `-dontoptimize` that another file sets. So:
 *   1. the preset becomes `proguard-android-optimize.txt` (the same file
 *      without `-dontoptimize`, plus `-allowaccessmodification`), and
 *   2. `android.r8.optimizedResourceShrinking=true` lets R8 shrink code and
 *      resources in one reference graph. developer.android.com/build/shrink-code:
 *      "for AGP 8.12 or 8.13, add the following to your project's
 *      gradle.properties file". RN 0.86.3 pins AGP 8.12.0.
 *
 * WHY NOW, NOT WITH SDK 58. Expo SDK 58's template switches to the optimize
 * preset itself (#50108: "Apps are optimized with the
 * `proguard-android-optimize.txt` preset"), and AGP 9 drops
 * `proguard-android.txt` outright. Doing it on SDK 57 keeps "R8 optimization
 * broke X" apart from "the SDK upgrade broke X".
 *
 * DROPPABLE AT THE SDK 58 UPGRADE. On the SDK 58 template the preset swap is a
 * no-op (handled below), and on AGP 9 `shrinkResources true` implies optimized
 * resource shrinking. The property is not on AGP 9's list of properties that
 * now throw (`android.r8.integratedResourceShrinking`,
 * `android.enableNewResourceShrinker.preciseShrinking`), so leaving it cannot
 * break that build - but delete this plugin then rather than carry it.
 *
 * THE HAZARD THIS SHARPENS. Optimized resource shrinking treats resources as
 * part of the code graph. src/terminal/xterm.html is require()d from the JS
 * bundle, which R8 never reads, so nothing in the graph references it. If a
 * build ever drops it, `.github/scripts/verify-android-assets.sh` fails that
 * build; anchor the resource with a `res/raw` keep file written here, and never
 * turn the flag off.
 *
 * CNG: this is how `android/` gets native config (.claude/rules/expo-cng.md).
 */

/** The template's call, whose preset carries `-dontoptimize`. */
export const UNOPTIMIZED_PRESET_CALL = 'getDefaultProguardFile("proguard-android.txt")';

/** The same rules without `-dontoptimize`; AGP 9 supports only this one. */
export const OPTIMIZED_PRESET_CALL = 'getDefaultProguardFile("proguard-android-optimize.txt")';

/** AGP 8.12/8.13's opt-in for R8-integrated, reference-graph resource shrinking. */
export const OPTIMIZED_RESOURCE_SHRINKING_PROPERTY = 'android.r8.optimizedResourceShrinking';

/**
 * Swaps the release block's default ProGuard preset for the optimizing one.
 *
 * Returns the contents unchanged when the template already names the optimize
 * preset (the SDK 58 template), and THROWS when it names neither. Never skips
 * silently: a plugin that finds nothing to edit and carries on is how
 * withIosManualSigning shipped an archive signed for the wrong target with
 * every check green.
 */
export function applyOptimizedProguardPreset(contents: string): string {
  if (contents.includes(UNOPTIMIZED_PRESET_CALL)) {
    return contents.split(UNOPTIMIZED_PRESET_CALL).join(OPTIMIZED_PRESET_CALL);
  }
  if (contents.includes(OPTIMIZED_PRESET_CALL)) {
    return contents;
  }
  throw new Error(
    `withAndroidR8Optimization found neither ${UNOPTIMIZED_PRESET_CALL} nor ${OPTIMIZED_PRESET_CALL} ` +
      'in android/app/build.gradle. The Expo template changed; re-derive the release block before ' +
      'trusting R8 optimization to be on.',
  );
}

const withAndroidR8Optimization: ConfigPlugin = (config) => {
  const withPreset = withAppBuildGradle(config, (buildGradleConfig) => {
    // Throws rather than no-opping, for the same reason as the CMake staging
    // plugin: a Kotlin-DSL build file would hold a different call shape, and a
    // silent miss would leave optimization off with every gate green.
    if (buildGradleConfig.modResults.language !== 'groovy') {
      throw new Error(
        `withAndroidR8Optimization expects a Groovy android/app/build.gradle, got '${buildGradleConfig.modResults.language}'.`,
      );
    }
    buildGradleConfig.modResults.contents = applyOptimizedProguardPreset(buildGradleConfig.modResults.contents);
    return buildGradleConfig;
  });

  return withGradleProperties(withPreset, (propertiesConfig) => {
    propertiesConfig.modResults = propertiesConfig.modResults.filter(
      (item) => !(item.type === 'property' && item.key === OPTIMIZED_RESOURCE_SHRINKING_PROPERTY),
    );
    propertiesConfig.modResults.push({
      type: 'property',
      key: OPTIMIZED_RESOURCE_SHRINKING_PROPERTY,
      value: 'true',
    });
    return propertiesConfig;
  });
};

export default withAndroidR8Optimization;
