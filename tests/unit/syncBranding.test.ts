/**
 * scripts/syncBranding.mjs regenerates assets/brand/*.png from the
 * @kangentic/branding package. `npm run sync:branding:check` (the "Brand
 * assets in sync" CI step) proves each declared output's CONTENT still
 * matches its branding-package source; it has no opinion on the declared
 * output SET. Deleting an entry from PNG_COPIES, or pointing app.config.ts
 * at a filename nothing regenerates, passes that check cleanly, and the
 * asset then silently rots the next time @kangentic/branding is upgraded.
 *
 * (The last describe block, the activity guards, is the one exception to "never
 * run the script": it runs a scratch COPY of the script, beside a scratch copy of
 * the branding package, as a child process. The copy resolves its repo root from
 * its own location, so it reads and writes only the scratch tree and the real
 * working tree is never touched.)
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
import { spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

interface GeneratorRun {
  exitStatus: number | null;
  stderr: string;
  /** Whether the run got far enough to write the activity module into the scratch tree. */
  wroteActivityModule: boolean;
  /** The activity module the run wrote, or null when it threw before writing. */
  activityModuleSource: string | null;
}

/**
 * Runs the REAL generator against a scratch copy of the branding package whose
 * activity SVGs the caller has rewritten. Everything is a copy: the script is
 * copied to `<scratch>/scripts/` so its repo-root lookup (`..` from its own
 * location) lands in the scratch tree, and the package to
 * `<scratch>/node_modules/@kangentic/branding`. The real working tree is never
 * read as a target or written.
 */
function runGeneratorAgainstScratchPackage(rewriteActivityAssets: (activityDirectory: string) => void): GeneratorRun {
  const scratchRoot = mkdtempSync(join(tmpdir(), 'kangentic-syncbranding-test-'));
  try {
    mkdirSync(join(scratchRoot, 'scripts'));
    copyFileSync(repoPath('scripts/syncBranding.mjs'), join(scratchRoot, 'scripts', 'syncBranding.mjs'));
    const scratchPackageRoot = join(scratchRoot, 'node_modules', '@kangentic', 'branding');
    cpSync(repoPath('node_modules/@kangentic/branding'), scratchPackageRoot, { recursive: true, dereference: true });
    rewriteActivityAssets(join(scratchPackageRoot, 'assets', 'activity'));

    const result = spawnSync(process.execPath, [join(scratchRoot, 'scripts', 'syncBranding.mjs')], {
      cwd: scratchRoot,
      encoding: 'utf8',
      timeout: 30_000,
    });
    const activityModulePath = join(scratchRoot, 'src', 'brand', 'activityMarks.generated.ts');
    const wroteActivityModule = existsSync(activityModulePath);
    return {
      exitStatus: result.status,
      stderr: result.stderr,
      wroteActivityModule,
      activityModuleSource: wroteActivityModule ? readFileSync(activityModulePath, 'utf8') : null,
    };
  } finally {
    rmSync(scratchRoot, { recursive: true, force: true });
  }
}

/** Rewrites one activity SVG in place, and fails loudly if the rewrite changed nothing (a vacuous fixture). */
function rewriteActivitySvg(activityDirectory: string, fileName: string, transform: (source: string) => string): void {
  const svgPath = join(activityDirectory, fileName);
  const original = readFileSync(svgPath, 'utf8');
  const rewritten = transform(original);
  if (rewritten === original) throw new Error(`the fixture rewrite of ${fileName} changed nothing; the case would test nothing`);
  writeFileSync(svgPath, rewritten);
}

/**
 * The generator's hard-fail guards for the activity marks. `--check` proves the
 * committed output matches what the INSTALLED package generates, so it can only
 * ever exercise the happy path; a guard that stopped firing would pass it
 * forever and the next upstream bump would ship a mark the renderer draws
 * wrongly (a square outlined instead of filled, a square spinning with its ring).
 * Each case here feeds the real generator a rewritten SVG and asserts it STOPS,
 * naming the file, rather than emitting anything.
 */
describe('syncBranding.mjs activity guards (the real generator against rewritten svgs)', () => {
  const GENERATOR_TEST_TIMEOUT_MS = 30_000;

  /**
   * The control for every case below: an unmodified scratch copy generates the
   * committed module byte for byte (line endings aside). Without it a failure
   * below could be the harness (a missing file in the scratch tree) rather than
   * the guard under test.
   */
  it(
    'generates the committed activity module from an untouched scratch copy (the control)',
    () => {
      const run = runGeneratorAgainstScratchPackage(() => undefined);

      expect(run.stderr).toBe('');
      expect(run.exitStatus).toBe(0);
      expect(run.wroteActivityModule).toBe(true);
      const committedSource = readFileSync(repoPath('src/brand/activityMarks.generated.ts'), 'utf8');
      expect(run.activityModuleSource?.replaceAll('\r\n', '\n')).toBe(committedSource.replaceAll('\r\n', '\n'));
    },
    GENERATOR_TEST_TIMEOUT_MS,
  );

  /**
   * A filled shape is exactly `fill="currentColor" stroke="none"`. Anything else
   * on a rect is a paint the renderer does not know, and drawing it as an outline
   * would ship the stop square hollow.
   */
  it.each([
    { label: 'a named fill colour', paint: 'fill="red" stroke="none"' },
    { label: 'a fill with no stroke override', paint: 'fill="currentColor"' },
    { label: 'a stroke with no fill', paint: 'stroke="currentColor"' },
    { label: 'an explicit fill none', paint: 'fill="none" stroke="none"' },
  ])(
    'refuses a rect painted with $label',
    ({ paint }) => {
      const run = runGeneratorAgainstScratchPackage((activityDirectory) => {
        rewriteActivitySvg(activityDirectory, 'control-stop-idle.svg', (source) =>
          source.replace('fill="currentColor" stroke="none"', paint),
        );
      });

      expect(run.exitStatus).not.toBe(0);
      expect(run.stderr).toContain('control-stop-idle.svg <rect> paints');
      expect(run.stderr).toContain('fill="currentColor" stroke="none"');
      expect(run.wroteActivityModule, 'a refused mark must not leave a partial module behind').toBe(false);
    },
    GENERATOR_TEST_TIMEOUT_MS,
  );

  it.each([
    { label: 'a path with a fill', file: 'terminal-idle.svg', element: '<path>', from: '<path d="M12.5 14.5 H16.5"/>', to: '<path d="M12.5 14.5 H16.5" fill="currentColor"/>' },
    { label: 'a path with a stroke', file: 'terminal-new.svg', element: '<path>', from: '<path d="M12 8.5 V15.5"/>', to: '<path d="M12 8.5 V15.5" stroke="red"/>' },
    { label: 'a circle with a stroke', file: 'control-stop-idle.svg', element: '<circle>', from: '<circle cx="12" cy="12" r="10"', to: '<circle cx="12" cy="12" r="10" stroke="red"' },
  ])(
    'refuses $label, since only a rect may carry its own paint',
    ({ file, element, from, to }) => {
      const run = runGeneratorAgainstScratchPackage((activityDirectory) => {
        rewriteActivitySvg(activityDirectory, file, (source) => source.replace(from, to));
      });

      expect(run.exitStatus).not.toBe(0);
      expect(run.stderr).toContain(`${file} ${element} carries its own fill or stroke`);
      expect(run.wroteActivityModule).toBe(false);
    },
    GENERATOR_TEST_TIMEOUT_MS,
  );

  /**
   * The renderer turns exactly the shapes inside the motion's `<g>`. A static
   * shape in it would spin with the ring (the stop square rotating), so the
   * generator refuses rather than emit a mark that animates its own square.
   */
  it(
    'refuses a static shape inside the motion group (the stop square spinning with its ring)',
    () => {
      const run = runGeneratorAgainstScratchPackage((activityDirectory) => {
        rewriteActivitySvg(activityDirectory, 'control-stop-working.svg', (source) => {
          const squareMarkup = /<rect\b[^>]*\/>/.exec(source)?.[0];
          if (squareMarkup === undefined) throw new Error('control-stop-working.svg has no <rect>; the fixture cannot move it');
          return source.replace(squareMarkup, '').replace('</g>', `${squareMarkup}</g>`);
        });
      });

      expect(run.exitStatus).not.toBe(0);
      expect(run.stderr).toContain('control-stop-working.svg <rect> is inside the motion group');
      expect(run.stderr).toContain("it is not the mark's moving outline");
      expect(run.wroteActivityModule).toBe(false);
    },
    GENERATOR_TEST_TIMEOUT_MS,
  );

  it(
    'refuses a moving outline that sits OUTSIDE the motion group (a working ring that holds still)',
    () => {
      const run = runGeneratorAgainstScratchPackage((activityDirectory) => {
        rewriteActivitySvg(activityDirectory, 'agent-working.svg', (source) =>
          source.replace('<g class="kng-spin">', '').replace('</g>', ''),
        );
      });

      expect(run.exitStatus).not.toBe(0);
      expect(run.stderr).toContain('agent-working.svg <circle> is outside the motion group');
      expect(run.stderr).toContain("it is the mark's moving outline");
      expect(run.wroteActivityModule).toBe(false);
    },
    GENERATOR_TEST_TIMEOUT_MS,
  );

  it.each([
    { label: 'an unclosed group', file: 'agent-working.svg', transform: (source: string) => source.replace('</g>', '') },
    { label: 'a stray closing tag', file: 'agent-idle.svg', transform: (source: string) => source.replace('</svg>', '</g></svg>') },
  ])(
    'refuses $label as an unbalanced <g>',
    ({ file, transform }) => {
      const run = runGeneratorAgainstScratchPackage((activityDirectory) => {
        rewriteActivitySvg(activityDirectory, file, transform);
      });

      expect(run.exitStatus).not.toBe(0);
      expect(run.stderr).toContain(`${file} has an unbalanced <g> element`);
      expect(run.wroteActivityModule).toBe(false);
    },
    GENERATOR_TEST_TIMEOUT_MS,
  );
});
