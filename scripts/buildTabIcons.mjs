#!/usr/bin/env node
/**
 * Rasterises the custom iOS tab-bar icons from lucide path data.
 *
 *   node scripts/buildTabIcons.mjs [--check]
 *
 *     --check   verify the committed PNGs match what this script would emit,
 *               and exit non-zero if they do not. For CI.
 *
 * WHY A CUSTOM ICON EXISTS AT ALL
 *
 * The bottom tabs are expo-router `NativeTabs`, and the rule everywhere else in
 * this file's neighbourhood is that a tab bar is PLATFORM chrome: iOS gets an
 * SF Symbol, Android gets a Material symbol, and neither borrows the lucide set
 * the rest of the app uses. The Board tab is a deliberate exception, and it is
 * worth stating why so nobody "fixes" it back.
 *
 * SF Symbols has no kanban glyph. Not a near miss - the concept is absent. The
 * catalogue was searched for `kanban`, `board`, `column` and `lane` against the
 * exact symbol set our SDK types against (`sf-symbols-typescript`, which is what
 * `Icon`'s `sf` prop is typed to), and the only `column` hits are
 * `building.columns`, a bank facade. The nearest available shapes are generic
 * split rectangles - `rectangle.split.3x1` and friends - which read as "split
 * view", not "a board of tasks in lanes". Android's Material `view_kanban` has
 * no equivalent, so matching the two platforms means bringing an icon.
 *
 * lucide's `SquareKanban` is the source because it IS the app's icon language:
 * board column chips, task cards and prompt cards are all lucide, deliberately,
 * so they match the desktop app (see .claude/rules/ui-conventions.md). Copying
 * its path data rather than hand-drawing keeps the tab icon and the content
 * icons the same family, and the copy is exact - see LUCIDE_SQUARE_KANBAN.
 *
 * WHY PNG, AND WHY THREE OF THEM
 *
 * A native tab bar renders a real UIImage. It cannot take a React component, so
 * `react-native-svg` (which this app has) is no help here: it draws into the JS
 * view tree, and UITabBarItem is not in it. Metro resolves `@2x`/`@3x` siblings
 * automatically from a single `require`, so one require yields the right asset
 * per device.
 *
 * The PNGs are COMMITTED, and this script is not part of the build. CI never
 * needs the rasteriser, and a broken or unavailable native binary can never
 * silently ship a missing icon - the assets are either in the tree or they are
 * not. `--check` is what keeps them honest.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Resvg } from '@resvg/resvg-js';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT_DIRECTORY = join(repositoryRoot, 'assets', 'tab-icons');

/**
 * Apple's documented tab-bar icon size. Rendered at 1x/2x/3x so iOS picks the
 * exact pixels for the device instead of resampling, which on a 2px-stroke
 * glyph is the difference between crisp and furry.
 *
 * If the glyph reads optically heavier or lighter than the `sparkles` SF Symbol
 * on the Agents tab, THIS is the number to change - not the stroke width. The
 * only way to judge it is a capture on a real simulator, so change it and look
 * at store/screenshots/ios/iphone-6.9/01-agents.png rather than reasoning about
 * it.
 */
export const POINT_SIZE = 25;
export const SCALES = [1, 2, 3];
export const ICON_NAME = 'board-kanban';

/**
 * lucide `SquareKanban`, copied verbatim from
 * node_modules/lucide-react-native/dist/esm/icons/square-kanban.mjs.
 *
 * Kept as data rather than imported because that module exports a React
 * component, not geometry - importing it here would pull React Native into a
 * build script. The trade is that a lucide upgrade will not update this
 * automatically, which the drift test in tests/unit/tabIcons.test.ts covers by
 * comparing these values against the installed package.
 */
export const LUCIDE_SQUARE_KANBAN = {
  viewBox: 24,
  strokeWidth: 2,
  rect: { x: 3, y: 3, width: 18, height: 18, rx: 2 },
  bars: [
    { d: 'M8 7v7' },
    { d: 'M12 7v4' },
    { d: 'M16 7v9' },
  ],
};

/**
 * Black on transparent, deliberately.
 *
 * The icon is handed to iOS as a TEMPLATE image (`renderingMode="template"` on
 * the Icon), which discards colour entirely and keeps only the alpha channel,
 * then fills it with the tab bar's tint. So the paint colour here is arbitrary
 * and the ALPHA is the whole payload: anti-aliased edges become soft tinted
 * edges, and a stray opaque background would become a tinted block.
 */
function buildSvg({ viewBox, strokeWidth, rect, bars }) {
  const paths = bars.map((bar) => `  <path d="${bar.d}" />`).join('\n');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${viewBox} ${viewBox}" width="${viewBox}" height="${viewBox}" fill="none" stroke="#000000" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
  <rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" rx="${rect.rx}" />
${paths}
</svg>
`;
}

function renderPng(svg, pixelSize) {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: pixelSize },
    // Transparent, so the alpha channel carries only the glyph. A background
    // here would render as a filled tinted square in the tab bar.
    background: 'rgba(0, 0, 0, 0)',
    shapeRendering: 2,
    imageRendering: 0,
  });
  return resvg.render().asPng();
}

/** `icon.png`, `icon@2x.png`, `icon@3x.png` - the suffixes Metro resolves. */
export function outputPath(name, scale) {
  return join(OUTPUT_DIRECTORY, scale === 1 ? `${name}.png` : `${name}@${scale}x.png`);
}

function digest(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 12);
}

function main() {
  const checkOnly = process.argv.includes('--check');
  const svg = buildSvg(LUCIDE_SQUARE_KANBAN);
  const name = ICON_NAME;

  if (!checkOnly) mkdirSync(OUTPUT_DIRECTORY, { recursive: true });

  let drifted = false;
  for (const scale of SCALES) {
    const pixelSize = POINT_SIZE * scale;
    const png = renderPng(svg, pixelSize);
    const path = outputPath(name, scale);

    if (checkOnly) {
      if (!existsSync(path)) {
        console.error(`[tab-icons] MISSING ${path}`);
        drifted = true;
        continue;
      }
      const committed = readFileSync(path);
      if (digest(committed) !== digest(png)) {
        console.error(`[tab-icons] STALE ${path} (committed ${digest(committed)}, expected ${digest(png)})`);
        drifted = true;
        continue;
      }
      console.log(`[tab-icons] ok ${path} (${pixelSize}x${pixelSize})`);
      continue;
    }

    writeFileSync(path, png);
    console.log(`[tab-icons] wrote ${path} (${pixelSize}x${pixelSize}, ${digest(png)})`);
  }

  if (drifted) {
    console.error('[tab-icons] Committed icons do not match this script. Run: node scripts/buildTabIcons.mjs');
    process.exitCode = 1;
  }
}

// Only when RUN, never when imported. The unit test imports this module for the
// lucide geometry and the output paths, and an unguarded call would rasterise
// three PNGs as a side effect of running the test suite.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main();
}
