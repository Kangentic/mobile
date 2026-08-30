/**
 * Parity between app.config.ts and the brand foundations, plus a guard on the
 * hand-bumped release version fields. The Expo config loader cannot import
 * the tokens module (it transpiles only the config file itself), so the
 * config inlines the background hex; this test is the mechanical guard that
 * keeps the inline value equal to the token.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExpoConfig } from 'expo/config';
import appConfig from '../../app.config';
import { brandTokens, darkTerminalTheme } from '@/components/theme/tokens';

interface AndroidBuildProperties {
  usesCleartextTraffic?: boolean;
  extraMavenRepos?: string[];
  enableMinifyInReleaseBuilds?: boolean;
  enableShrinkResourcesInReleaseBuilds?: boolean;
}

interface SentryAndroidGradlePluginOptions {
  enableAndroidGradlePlugin?: boolean;
  uploadNativeSymbols?: boolean;
  autoUploadNativeSymbols?: boolean;
}

interface SentryPluginOptions {
  organization?: string;
  project?: string;
  experimental_android?: SentryAndroidGradlePluginOptions;
}

interface NotificationPluginOptions {
  icon?: string;
  color?: string;
}

interface SplashScreenPluginOptions {
  image?: string;
  backgroundColor?: string;
}

/**
 * app.config.ts reads process.env at MODULE EVALUATION time (that is the whole
 * point - EXPO_PUBLIC_* values are build-time constants), so each flag state
 * needs its own fresh import rather than a re-read of the cached one.
 *
 * Takes a map rather than one flag because two independent build-time gates now
 * need this: EXPO_PUBLIC_KANGENTIC_E2E for the cleartext carve-out, and
 * SENTRY_AUTH_TOKEN for whether the Sentry plugin entry exists at all.
 */
async function loadAppConfigWithEnv(
  environmentOverrides: Record<string, string | undefined>
): Promise<ExpoConfig> {
  const originalValues = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(environmentOverrides)) {
    originalValues.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    vi.resetModules();
    const freshModule = await import('../../app.config');
    return freshModule.default;
  } finally {
    for (const [name, value] of originalValues) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function loadAppConfigWithE2eFlag(flagValue: string | undefined): Promise<ExpoConfig> {
  return loadAppConfigWithEnv({ EXPO_PUBLIC_KANGENTIC_E2E: flagValue });
}

/**
 * Options of a plugin entry in the CONFIGURED (`[name, options]` tuple) form.
 * A bare-string entry does not match, so it throws the same not-found error a
 * missing plugin does: either way a test asserting on options fails loudly
 * rather than passing vacuously against `{}`.
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

describe('app.config.ts brand parity', () => {
  it('keeps the inline root background color equal to the theme background token', () => {
    expect(appConfig.backgroundColor).toBe(darkTerminalTheme.colors.background);
  });

  it('points the app icon and Android adaptive icon at the synced brand assets', () => {
    expect(appConfig.icon).toBe('./assets/brand/icon.png');
    expect(appConfig.android?.adaptiveIcon?.foregroundImage).toBe('./assets/brand/adaptive-icon-foreground.png');
    expect(appConfig.android?.adaptiveIcon?.backgroundImage).toBe('./assets/brand/adaptive-icon-background.png');
    expect(appConfig.android?.adaptiveIcon?.monochromeImage).toBe('./assets/brand/adaptive-icon-monochrome.png');
  });

  it('points the iOS light/dark/tinted icons at the synced brand assets', () => {
    const iosIcon = appConfig.ios?.icon;
    expect(typeof iosIcon).toBe('object');
    expect(iosIcon).toEqual({
      light: './assets/brand/icon.png',
      dark: './assets/brand/icon-dark.png',
      tinted: './assets/brand/icon-tinted.png',
    });
  });

  it('points the expo-notifications plugin at the dedicated mono icon, tinted rust', () => {
    const options = pluginOptions<NotificationPluginOptions>(appConfig, 'expo-notifications');
    expect(options.icon).toBe('./assets/brand/notification-icon.png');
    expect(options.color).toBe(brandTokens.rust);
  });

  // Asserted through the evaluated config, not a source string match: the
  // plugin is live now, and a readFileSync/toContain check would pass just as
  // happily if the block were commented back out.
  it('keeps the expo-splash-screen plugin block pointed at the synced splash mark', () => {
    const options = pluginOptions<SplashScreenPluginOptions>(appConfig, 'expo-splash-screen');
    expect(options.image).toBe('./assets/brand/splash-icon.png');
    expect(options.backgroundColor).toBe(darkTerminalTheme.colors.background);
  });
});

describe('app.config.ts iOS plugin order', () => {
  // withIosManualSigning is inert without the KANGENTIC_IOS_* variables, which
  // only build-ios.yml's device job sets, and ci.yml's prebuild jobs hold no
  // secrets at all - so a reversed order produces a byte-identical generated
  // project on every PR, and CI stays green. The break surfaces only on a real
  // `build-ios.yml -f target=device` dispatch: withIosManualSigning scopes its
  // writes to a target it finds BY NAME, so if it runs first there is no
  // KangenticNSE target yet, it silently signs nothing for the extension, and
  // the archive fails deep in xcodebuild with a message naming neither plugin.
  it('registers the Notification Service Extension plugin before manual signing', () => {
    const entryNames = (appConfig.plugins ?? []).map((plugin) => (Array.isArray(plugin) ? plugin[0] : plugin));
    const nseIndex = entryNames.indexOf('./plugins/withIosNotificationServiceExtension.ts');
    const signingIndex = entryNames.indexOf('./plugins/withIosManualSigning.ts');
    expect(nseIndex).toBeGreaterThan(-1);
    expect(signingIndex).toBeGreaterThan(-1);
    expect(nseIndex).toBeLessThan(signingIndex);
  });
});

describe('app.config.ts iOS privacy manifest', () => {
  // Declares what Sentry's SDK collects, required because React Native links
  // sentry-cocoa statically, so Apple does not auto-process the pod's own
  // manifest (see the comment in app.config.ts). If this list changes,
  // docs/store-listing.md's App Store Connect answers must change with it -
  // they are one consistency requirement, not two independent edits.
  it('declares crash, performance, other-diagnostic, and device-ID data, none linked or used for tracking', () => {
    const collectedTypes = appConfig.ios?.privacyManifests?.NSPrivacyCollectedDataTypes;
    expect(collectedTypes).toBeDefined();
    expect(collectedTypes?.map((entry) => entry.NSPrivacyCollectedDataType).sort()).toEqual(
      [
        'NSPrivacyCollectedDataTypeCrashData',
        'NSPrivacyCollectedDataTypeDeviceID',
        'NSPrivacyCollectedDataTypeOtherDiagnosticData',
        'NSPrivacyCollectedDataTypePerformanceData',
      ].sort()
    );
    for (const entry of collectedTypes ?? []) {
      expect(entry.NSPrivacyCollectedDataTypeLinked).toBe(false);
      expect(entry.NSPrivacyCollectedDataTypeTracking).toBe(false);
      // Both purposes, in this order. Analytics is here because it is what the
      // Play Data safety form accepted for crash reporting (Play has no
      // "Diagnostics" purpose, only a Diagnostics data type), and Apple
      // cross-checks the App Privacy answers against this manifest, so the two
      // stores have to be answered the same way.
      expect(entry.NSPrivacyCollectedDataTypePurposes).toEqual([
        'NSPrivacyCollectedDataTypePurposeAppFunctionality',
        'NSPrivacyCollectedDataTypePurposeAnalytics',
      ]);
    }
  });

  it('declares the three required-reason APIs Sentry calls, with the reason codes from its own guidance', () => {
    const accessedTypes = appConfig.ios?.privacyManifests?.NSPrivacyAccessedAPITypes;
    expect(accessedTypes).toBeDefined();
    const byCategory = new Map(accessedTypes?.map((entry) => [entry.NSPrivacyAccessedAPIType, entry.NSPrivacyAccessedAPITypeReasons]));
    expect(byCategory.get('NSPrivacyAccessedAPICategoryUserDefaults')).toEqual(['CA92.1']);
    expect(byCategory.get('NSPrivacyAccessedAPICategorySystemBootTime')).toEqual(['35F9.1']);
    expect(byCategory.get('NSPrivacyAccessedAPICategoryFileTimestamp')).toEqual(['C617.1']);
  });
});

describe('app.config.ts hand-bumped release versions', () => {
  // cli.appVersionSource is "local" in eas.json, so EAS does not track these
  // server-side; nothing else in CI checks them (see the Android release
  // section of docs/developer-guide.md, "Enforcement: none"). This is the
  // one mechanical guard that the values are present and well-formed.
  it('keeps android.versionCode a positive integer', () => {
    const versionCode = appConfig.android?.versionCode;
    expect(versionCode).toBeDefined();
    expect(Number.isInteger(versionCode)).toBe(true);
    expect(versionCode).toBeGreaterThan(0);
  });

  it('keeps ios.buildNumber a positive integer string', () => {
    const buildNumber = appConfig.ios?.buildNumber;
    expect(buildNumber).toBeDefined();
    expect(buildNumber).toMatch(/^\d+$/);
    expect(Number(buildNumber)).toBeGreaterThan(0);
  });
});

/**
 * The Android-manifest counterpart to the ws://10.0.2.2 carve-out in
 * src/pairing/qr.ts, gated on the same build-time flag. Android refuses a
 * cleartext socket in a release-shaped build before any of our code runs, so
 * the e2e profile has to relax it - and ONLY the e2e profile, because shipping
 * a binary that permits cleartext at the OS level would undo the wss://-only
 * rule the pairing token's confidentiality rests on.
 */
describe('app.config.ts cleartext-traffic gate', () => {
  it('omits usesCleartextTraffic entirely when the e2e flag is unset', async () => {
    const androidProperties = androidBuildProperties(await loadAppConfigWithE2eFlag(undefined));
    expect('usesCleartextTraffic' in androidProperties).toBe(false);
    // The block itself must still exist, or this test would pass vacuously
    // against a config that dropped expo-build-properties altogether.
    expect(androidProperties.extraMavenRepos).toBeDefined();
  });

  it('sets usesCleartextTraffic only for the exact flag value the e2e profile sets', async () => {
    const e2eProperties = androidBuildProperties(await loadAppConfigWithE2eFlag('1'));
    expect(e2eProperties.usesCleartextTraffic).toBe(true);

    // A stray truthy-looking value is not the flag, matching qr.ts.
    const truthyProperties = androidBuildProperties(await loadAppConfigWithE2eFlag('true'));
    expect('usesCleartextTraffic' in truthyProperties).toBe(false);

    const zeroProperties = androidBuildProperties(await loadAppConfigWithE2eFlag('0'));
    expect('usesCleartextTraffic' in zeroProperties).toBe(false);
  });
});

/**
 * R8. These two properties are the entire difference between a release build
 * Play Console rates "App optimization: Low" and one it does not, and dropping
 * them breaks nothing locally - so without a check, the first signal is a Play
 * Console row nobody reads for weeks.
 *
 * This is the SOURCE-CONFIG layer of two. ci.yml's "Confirm R8 is enabled for
 * release builds" step is the other, and it asserts against the
 * android/gradle.properties a real prebuild produced - so it also catches a
 * plugin-side regression that never touched app.config.ts. This test catches
 * the same drop far more cheaply, and without a prebuild.
 *
 * Asserted through the evaluated config rather than a source-string match, for
 * the same reason as the splash-screen block above: a readFileSync/toContain
 * check would pass just as happily against a commented-out property.
 */
describe('app.config.ts R8 release optimization', () => {
  it('enables minification and resource shrinking for release builds', () => {
    const androidProperties = androidBuildProperties(appConfig);
    expect(androidProperties.enableMinifyInReleaseBuilds).toBe(true);
    expect(androidProperties.enableShrinkResourcesInReleaseBuilds).toBe(true);
  });

  // Not a style preference. expo-build-properties throws on shrink-without-minify
  // ("`android.enableShrinkResourcesInReleaseBuilds` requires
  // `android.enableMinifyInReleaseBuilds`"), which fails prebuild rather than
  // lint, so it surfaces as a broken CI job instead of a config error.
  //
  // Asserted as an unconditional implication rather than an `if` around the
  // expect. Guarding on `shrinkResources === true` would make this test pass
  // having asserted NOTHING the moment that property went missing - which is
  // precisely the regression the test exists to catch.
  it('never sets shrinkResources without minify, which prebuild rejects', () => {
    const androidProperties = androidBuildProperties(appConfig);
    const shrinkImpliesMinify =
      !androidProperties.enableShrinkResourcesInReleaseBuilds ||
      androidProperties.enableMinifyInReleaseBuilds === true;
    expect(shrinkImpliesMinify).toBe(true);
  });
});

/**
 * The other half of turning R8 on: without the Sentry Android Gradle Plugin no
 * ProGuard mapping is uploaded, and every Java/Kotlin frame in an Android crash
 * arrives as a.b.c(). JS frames (Hermes source maps) and native frames (debug
 * symbols) travel separate paths and are unaffected by R8, so this is narrower
 * than "R8 breaks Sentry".
 */
describe('app.config.ts Sentry Android Gradle Plugin', () => {
  it('enables the Gradle plugin so R8 mapping files upload', async () => {
    const config = await loadAppConfigWithEnv({ SENTRY_AUTH_TOKEN: 'test-token' });
    const options = pluginOptions<SentryPluginOptions>(config, '@sentry/react-native/expo');
    expect(options.experimental_android?.enableAndroidGradlePlugin).toBe(true);
  });

  // Scoping, not an oversight: the plugin defaults both to true, which would
  // newly upload every React Native .so debug symbol on each dispatch build.
  // Flipping them on is a deliberate decision, so pin the current one.
  it('keeps native symbol upload off, leaving this scoped to the mapping file', async () => {
    const config = await loadAppConfigWithEnv({ SENTRY_AUTH_TOKEN: 'test-token' });
    const options = pluginOptions<SentryPluginOptions>(config, '@sentry/react-native/expo');
    expect(options.experimental_android?.uploadNativeSymbols).toBe(false);
    expect(options.experimental_android?.autoUploadNativeSymbols).toBe(false);
  });

  // ci.yml's "Native config (prebuild)" job prebuilds both platforms with zero
  // secrets. The plugin entry must be absent there, not present-and-unconfigured,
  // or that job starts failing on a missing auth token.
  it('omits the plugin entirely when no auth token is set', async () => {
    const config = await loadAppConfigWithEnv({ SENTRY_AUTH_TOKEN: undefined });
    const entryNames = (config.plugins ?? []).map((plugin) =>
      Array.isArray(plugin) ? plugin[0] : plugin
    );
    expect(entryNames).not.toContain('@sentry/react-native/expo');
  });

  // This is what sentry.gradle's --org/--project args and the generated
  // sentry.properties defaults.project value are built from. Nothing else in
  // this file reads organization/project, so a partial rename of the Sentry
  // project slug would leave every other assertion here green.
  it('names the renamed Sentry project, whose slug the upload URL is built from', async () => {
    const config = await loadAppConfigWithEnv({ SENTRY_AUTH_TOKEN: 'test-token' });
    const options = pluginOptions<SentryPluginOptions>(config, '@sentry/react-native/expo');
    expect(options.organization).toBe('kangentic');
    expect(options.project).toBe('mobile');
  });
});
