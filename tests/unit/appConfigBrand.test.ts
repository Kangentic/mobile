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
 */
async function loadAppConfigWithE2eFlag(flagValue: string | undefined): Promise<ExpoConfig> {
  const originalFlag = process.env.EXPO_PUBLIC_KANGENTIC_E2E;
  if (flagValue === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_E2E;
  else process.env.EXPO_PUBLIC_KANGENTIC_E2E = flagValue;
  try {
    vi.resetModules();
    const freshModule = await import('../../app.config');
    return freshModule.default;
  } finally {
    if (originalFlag === undefined) delete process.env.EXPO_PUBLIC_KANGENTIC_E2E;
    else process.env.EXPO_PUBLIC_KANGENTIC_E2E = originalFlag;
  }
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
      expect(entry.NSPrivacyCollectedDataTypePurposes).toEqual(['NSPrivacyCollectedDataTypePurposeAppFunctionality']);
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
