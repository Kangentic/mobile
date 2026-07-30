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
 * PNG filenames the app references equals the set PNG_COPIES declares, in
 * both directions. It does not import scripts/syncBranding.mjs
 * - the script's top level unconditionally calls writeOutputs(outputs,
 * repoRoot) outside --check mode, so importing it as a module would
 * overwrite real files in the working tree. Instead it reads the script's
 * source text and extracts the PNG_COPIES destinations structurally.
 *
 * There are TWO consumers of assets/brand, not one. app.config.ts claims the
 * OS-owned icons, and app/(tabs)/_layout.tsx requires the iOS Board tab glyph
 * (which moved here from a local rasteriser when @kangentic/branding took
 * ownership of the kanban mark). The tab glyph brings Metro's scale rule with
 * it: one `require` of the unsuffixed name resolves the @2x/@3x siblings, and a
 * missing @3x does NOT error - Metro serves the 1x and the icon goes soft on
 * every modern iPhone. So a reference to `kanban-tab.png` obliges all three
 * files, and that is asserted rather than assumed.
 *
 * The per-scale DIMENSION check at the bottom is the one thing `--check`
 * structurally cannot do. It compares each destination against its own declared
 * source, so swapping two entries' sources (25px into the @3x slot) leaves every
 * file byte-identical to what it was told to copy and reports "in sync" while
 * shipping a soft icon. This test measures the pixels instead.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { ExpoConfig } from 'expo/config';
import appConfig from '../../app.config';
import { readPngSize } from '../../scripts/storeScreenshots.mjs';

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

/** Repo-root-relative path, resolved from this test file's location. */
function repoPath(relativePath: string): string {
  return fileURLToPath(new URL(`../../${relativePath}`, import.meta.url));
}

/**
 * Every assets/brand PNG the native tab bar requires, extracted from
 * app/(tabs)/_layout.tsx's source text, expanded to the Metro scale family each
 * reference implies. Read as text for the same reason PNG_COPIES is: importing
 * the route would pull expo-router and the whole component tree into a unit test.
 */
function referencedTabIconFilenames(): string[] {
  const layoutSource = readFileSync(repoPath('app/(tabs)/_layout.tsx'), 'utf8');
  const requirePattern = /require\('(?:\.\.\/)+assets\/brand\/([^']+\.png)'\)/g;
  const filenames = new Set<string>();
  for (const match of layoutSource.matchAll(requirePattern)) {
    const [, filename] = match;
    if (/@\dx\.png$/.test(filename)) {
      throw new Error(
        `app/(tabs)/_layout.tsx requires "${filename}" directly. Require the unsuffixed name and let Metro resolve ` +
          'the scale siblings, or the 1x and 2x assets become unreachable.',
      );
    }
    // Metro resolves these from the unsuffixed name, so the reference obliges
    // all three even though only one appears in the source.
    const baseName = filename.replace(/\.png$/, '');
    filenames.add(filename);
    filenames.add(`${baseName}@2x.png`);
    filenames.add(`${baseName}@3x.png`);
  }
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

/** The Board tab glyph's scales, as the 25pt tab metric at 1x/2x/3x. */
const TAB_ICON_POINT_SIZE = 25;

describe('syncBranding.mjs PNG_COPIES', () => {
  it('declares exactly one output per assets/brand PNG, with no duplicate destination', () => {
    const syncedFilenames = syncedBrandAssetFilenames();
    // Guards the extraction itself: a regex that silently stopped matching
    // (or a destination two entries collide on, silently dropping one PNG)
    // would otherwise fail loudly only in the set-equality assertion below,
    // which would not distinguish "extraction broke" from "coverage broke".
    expect(syncedFilenames.length).toBe(11);
    expect(new Set(syncedFilenames).size).toBe(syncedFilenames.length);
  });

  it('finds the tab bar reference it is meant to expand', () => {
    // The same non-vacuity guard, for the second extractor. A require pattern
    // that silently stopped matching would leave the set-equality assertion
    // below comparing PNG_COPIES against app.config.ts alone, passing while
    // checking nothing about the tab glyph.
    expect(referencedTabIconFilenames()).toEqual(['kanban-tab.png', 'kanban-tab@2x.png', 'kanban-tab@3x.png']);
  });

  it('syncs exactly the assets/brand PNGs the app references, no more and no fewer', () => {
    const syncedFilenames = syncedBrandAssetFilenames();
    const referencedFilenames = [...referencedBrandAssetFilenames(appConfig), ...referencedTabIconFilenames()].sort();

    expect(syncedFilenames).toEqual(referencedFilenames);
  });

  /**
   * `--check` proves each destination matches the source it was TOLD to copy, so
   * it has no opinion on whether that pairing is right. Only the pixels do.
   */
  it('lands each Board tab scale at its own pixel size', () => {
    for (const [scale, filename] of [
      [1, 'kanban-tab.png'],
      [2, 'kanban-tab@2x.png'],
      [3, 'kanban-tab@3x.png'],
    ] as const) {
      const expectedPixels = TAB_ICON_POINT_SIZE * scale;
      const pngBuffer = readFileSync(repoPath(`assets/brand/${filename}`));
      expect(readPngSize(pngBuffer), `${filename} at ${scale}x`).toEqual({ width: expectedPixels, height: expectedPixels });
    }
  });

  /**
   * iOS renders the tab glyph as a TEMPLATE image: UIKit discards the colour
   * channels and paints the bar's tint through the alpha, so alpha is the entire
   * payload. An asset flattened onto a background survives every other check
   * here and turns the whole tab slot into a tinted block.
   */
  it('keeps the Board tab glyph alpha-bearing with transparent corners', () => {
    for (const filename of ['kanban-tab.png', 'kanban-tab@2x.png', 'kanban-tab@3x.png']) {
      const pngBuffer = readFileSync(repoPath(`assets/brand/${filename}`));
      // IHDR colour type sits one byte past the 8-byte height field: 6 is
      // truecolour+alpha, 4 is greyscale+alpha. 0 and 2 carry no alpha at all.
      const colorType = pngBuffer[25];
      expect([4, 6], `${filename} IHDR colour type ${colorType} carries no alpha channel`).toContain(colorType);
    }
  });
});
