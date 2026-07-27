/**
 * scripts/syncBranding.mjs regenerates assets/brand/*.png from the
 * @kangentic/branding package. `npm run sync:branding:check` (the "Brand
 * assets in sync" CI step) proves each declared output's CONTENT still
 * matches its branding-package source; it has no opinion on the declared
 * output SET. Deleting an entry from PNG_COPIES, or pointing app.config.ts
 * at a filename nothing regenerates, passes that check cleanly, and the
 * asset then silently rots the next time @kangentic/branding is upgraded.
 *
 * This test closes that gap directly: it asserts the set of assets/brand
 * PNG filenames app.config.ts references equals the set PNG_COPIES
 * declares, in both directions. It does not import scripts/syncBranding.mjs
 * - the script's top level unconditionally calls writeOutputs(outputs,
 * repoRoot) outside --check mode, so importing it as a module would
 * overwrite real files in the working tree. Instead it reads the script's
 * source text and extracts the PNG_COPIES destinations structurally.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ExpoConfig } from 'expo/config';
import appConfig from '../../app.config';

interface SplashScreenPluginOptions {
  image?: string;
}

interface NotificationsPluginOptions {
  icon?: string;
}

/** Options of a plugin entry in the CONFIGURED (`[name, options]` tuple) form. */
function pluginOptions<Options>(config: ExpoConfig, pluginName: string): Options | undefined {
  for (const plugin of config.plugins ?? []) {
    if (!Array.isArray(plugin) || plugin[0] !== pluginName) continue;
    return (plugin[1] ?? {}) as Options;
  }
  return undefined;
}

const BRAND_ASSET_PREFIX = './assets/brand/';

/** Every assets/brand/*.png filename app.config.ts actually references, deduplicated and sorted. */
function referencedBrandAssetFilenames(config: ExpoConfig): string[] {
  const filenames = new Set<string>();

  function addAssetPath(assetPath: string | undefined): void {
    if (assetPath === undefined) return;
    if (!assetPath.startsWith(BRAND_ASSET_PREFIX)) {
      throw new Error(`expected a "${BRAND_ASSET_PREFIX}" asset path, got "${assetPath}"`);
    }
    filenames.add(assetPath.slice(BRAND_ASSET_PREFIX.length));
  }

  addAssetPath(config.icon);

  const iosIcon = config.ios?.icon;
  if (typeof iosIcon === 'string') {
    addAssetPath(iosIcon);
  } else if (iosIcon !== undefined) {
    addAssetPath(iosIcon.light);
    addAssetPath(iosIcon.dark);
    addAssetPath(iosIcon.tinted);
  }

  addAssetPath(config.android?.adaptiveIcon?.foregroundImage);
  addAssetPath(config.android?.adaptiveIcon?.backgroundImage);
  addAssetPath(config.android?.adaptiveIcon?.monochromeImage);

  const splashScreenOptions = pluginOptions<SplashScreenPluginOptions>(config, 'expo-splash-screen');
  addAssetPath(splashScreenOptions?.image);

  const notificationsOptions = pluginOptions<NotificationsPluginOptions>(config, 'expo-notifications');
  addAssetPath(notificationsOptions?.icon);

  return Array.from(filenames).sort();
}

/**
 * Every destination filename PNG_COPIES declares in scripts/syncBranding.mjs,
 * extracted structurally from the source text rather than by importing the
 * script (see the file header for why import is unsafe here). The match is
 * scoped to the PNG_COPIES array body specifically, so a destination string
 * appearing in a comment or in one of the other source tables (the
 * brandmark SVGs, the mascot frames) cannot satisfy it.
 */
function syncedBrandAssetFilenames(): string[] {
  const scriptPath = fileURLToPath(new URL('../../scripts/syncBranding.mjs', import.meta.url));
  const scriptSource = readFileSync(scriptPath, 'utf8');

  const pngCopiesBlockMatch = /const PNG_COPIES = \[([\s\S]*?)\n\];/.exec(scriptSource);
  if (pngCopiesBlockMatch === null) {
    throw new Error('syncBranding.mjs: could not find the PNG_COPIES array in the script source');
  }
  const [, pngCopiesBlock] = pngCopiesBlockMatch;

  const destinationPattern = /destination:\s*join\('assets',\s*'brand',\s*'([^']+)'\)/g;
  const filenames: string[] = [];
  for (const match of pngCopiesBlock.matchAll(destinationPattern)) {
    const [, filename] = match;
    filenames.push(filename);
  }
  return filenames.sort();
}

describe('syncBranding.mjs PNG_COPIES', () => {
  it('declares exactly one output per assets/brand PNG, with no duplicate destination', () => {
    const syncedFilenames = syncedBrandAssetFilenames();
    // Guards the extraction itself: a regex that silently stopped matching
    // (or a destination two entries collide on, silently dropping one PNG)
    // would otherwise fail loudly only in the set-equality assertion below,
    // which would not distinguish "extraction broke" from "coverage broke".
    expect(syncedFilenames.length).toBe(8);
    expect(new Set(syncedFilenames).size).toBe(syncedFilenames.length);
  });

  it('syncs exactly the assets/brand PNGs app.config.ts references, no more and no fewer', () => {
    const syncedFilenames = syncedBrandAssetFilenames();
    const referencedFilenames = referencedBrandAssetFilenames(appConfig);

    expect(syncedFilenames).toEqual(referencedFilenames);
  });
});
