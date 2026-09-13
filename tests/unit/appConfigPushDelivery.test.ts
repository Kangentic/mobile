/**
 * Pins three settings that are the entire difference between background push
 * working and dying silently on a FORCE-QUIT Android app. All three fail with
 * zero signal if removed or refactored away: no crash locally, no lint
 * failure, a green CI pipeline, and background push simply stops once the
 * change reaches production.
 *
 * The two ProGuard rules stop R8 stripping `RNHeadlessAppLoader`: nothing
 * references that class statically, only a manifest meta-data string
 * resolved through `Class.forName`, so without the `-keep` rule a push to a
 * killed app throws `ClassNotFoundException` and `expo-task-manager` then
 * dereferences the resulting null. `SourceFile,LineNumberTable` is what makes
 * a stripped frame elsewhere still readable in a mapping file. See the
 * `extraProguardRules` comment in app.config.ts for the full incident.
 *
 * `buildFromSource` is the other half: it is what makes
 * `patches/expo-task-manager+57.0.17.patch` actually reach the APK. Both
 * `expo-task-manager` and `unimodules-app-loader` have to be named, because
 * expo-task-manager's build.gradle references
 * `project(':unimodules-app-loader')`, which only exists as a source project
 * once that entry is present too - otherwise the module ships a prebuilt AAR
 * and the patched .java never compiles into anything.
 */
import { describe, expect, it } from 'vitest';
import type { ExpoConfig } from 'expo/config';
import appConfig from '../../app.config';
import packageManifest from '../../package.json';

interface AndroidBuildProperties {
  extraProguardRules?: string;
}

/**
 * Same shape as the equivalent helper in appConfigBrand.test.ts: a bare-string
 * plugin entry (no options tuple) throws the same not-found error a missing
 * plugin does, so an assertion against options fails loudly rather than
 * passing vacuously against `{}`.
 */
function pluginOptions<Options>(config: ExpoConfig, pluginName: string): Options {
  for (const plugin of config.plugins ?? []) {
    if (!Array.isArray(plugin) || plugin[0] !== pluginName) continue;
    return (plugin[1] ?? {}) as Options;
  }
  throw new Error(`${pluginName} plugin entry not found (or not in tuple form) in app.config.ts`);
}

function androidBuildProperties(config: ExpoConfig): AndroidBuildProperties {
  const options = pluginOptions<{ android?: AndroidBuildProperties }>(config, 'expo-build-properties');
  return options.android ?? {};
}

describe('app.config.ts ProGuard rules for background push', () => {
  it('keeps the SourceFile/LineNumberTable attribute, or a stripped frame becomes undiagnosable', () => {
    const extraProguardRules = androidBuildProperties(appConfig).extraProguardRules ?? '';
    expect(extraProguardRules).toContain('-keepattributes SourceFile,LineNumberTable');
  });

  it('keeps the HeadlessAppLoader keep rule that stops R8 stripping RNHeadlessAppLoader', () => {
    const extraProguardRules = androidBuildProperties(appConfig).extraProguardRules ?? '';
    expect(extraProguardRules).toContain(
      '-keep class * implements expo.modules.apploader.HeadlessAppLoader { *; }'
    );
  });
});

describe('package.json autolinking buildFromSource', () => {
  it('builds expo-task-manager and unimodules-app-loader from source, or the task-manager patch never reaches the APK', () => {
    const buildFromSource = packageManifest.expo.autolinking.buildFromSource;
    expect(Array.isArray(buildFromSource)).toBe(true);
    expect(buildFromSource).toContain('expo-task-manager');
    expect(buildFromSource).toContain('unimodules-app-loader');
  });
});
