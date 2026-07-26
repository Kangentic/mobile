/**
 * Parity between app.config.ts and the brand foundations, plus a guard on the
 * hand-bumped release version fields. The Expo config loader cannot import
 * the tokens module (it transpiles only the config file itself), so the
 * config inlines the background hex; this test is the mechanical guard that
 * keeps the inline value equal to the token.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import appConfig from '../../app.config';
import { darkTerminalTheme } from '@/components/theme/tokens';

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
