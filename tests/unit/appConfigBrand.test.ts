/**
 * Parity between app.config.ts and the brand foundations. The Expo config
 * loader cannot import the tokens module (it transpiles only the config file
 * itself), so the config inlines the background hex; this test is the
 * mechanical guard that keeps the inline value equal to the token.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { ExpoConfig } from 'expo/config';
import appConfig from '../../app.config';
import { darkTerminalTheme } from '@/components/theme/tokens';

interface AndroidBuildProperties {
  usesCleartextTraffic?: boolean;
  extraMavenRepos?: string[];
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

function androidBuildProperties(config: ExpoConfig): AndroidBuildProperties {
  for (const plugin of config.plugins ?? []) {
    if (!Array.isArray(plugin) || plugin[0] !== 'expo-build-properties') continue;
    const options = plugin[1] as { android?: AndroidBuildProperties } | undefined;
    return options?.android ?? {};
  }
  throw new Error('expo-build-properties plugin entry not found in app.config.ts');
}

describe('app.config.ts brand parity', () => {
  it('keeps the inline root background color equal to the theme background token', () => {
    expect(appConfig.backgroundColor).toBe(darkTerminalTheme.colors.background);
  });

  it('points the app icon and Android adaptive icon at the synced brand assets', () => {
    expect(appConfig.icon).toBe('./assets/brand/icon.png');
    expect(appConfig.android?.adaptiveIcon?.foregroundImage).toBe('./assets/brand/adaptive-icon-foreground.png');
    expect(appConfig.android?.adaptiveIcon?.backgroundImage).toBe('./assets/brand/adaptive-icon-background.png');
  });

  it('keeps the ready-to-uncomment expo-splash-screen plugin block staged in the source', () => {
    // The plugin entry cannot be live until the Stage 0 native batch installs
    // expo-splash-screen (an unresolvable plugin fails config evaluation), so
    // it is staged as a comment; this guards against the block being dropped.
    const configSource = readFileSync(fileURLToPath(new URL('../../app.config.ts', import.meta.url)), 'utf8');
    expect(configSource).toContain("'expo-splash-screen'");
    expect(configSource).toContain('./assets/brand/splash-icon.png');
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
