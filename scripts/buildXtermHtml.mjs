#!/usr/bin/env node
/**
 * Generates src/terminal/xterm.html: a fully self-contained, offline,
 * CSP-locked page that hosts xterm.js for the raw-terminal mirror. Inlines
 * xterm's JS and CSS from the @xterm/xterm devDependency plus the RN <->
 * WebView bridge glue, so the WebView never touches the network.
 *
 * Run after editing any module under scripts/xterm-page/ (or after an
 * @xterm/xterm upgrade), then commit the regenerated asset:
 *   node scripts/buildXtermHtml.mjs
 *
 * The bridge protocol (message shapes) is defined in
 * src/terminal/terminalBridge.ts; the glue implements the same contract by
 * hand because this page cannot import TypeScript.
 *
 * EDITING THE GLUE: it lives as plain .js files under scripts/xterm-page/,
 * concatenated IN PAGE_MODULE_ORDER into one IIFE (prelude and postlude
 * below). The files are page-scope fragments, not Node modules:
 *  - No import/export and no Node APIs; browser globals only.
 *  - Top-level var declarations are shared across ALL modules (one lexical
 *    scope), which is how state.js and gestureState.js serve everything else.
 *  - Function declarations hoist across the whole IIFE, so call order across
 *    files is fine; only statements that RUN at load are order-sensitive
 *    (state first, bootstrap last).
 *  - Keep the existing var-based, WebView-conservative style.
 * Each module is syntax-compiled individually below, so a typo fails the
 * build naming the module and line rather than shipping a page that never
 * posts 'ready'.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const xtermJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'lib', 'xterm.js'), 'utf8');
const xtermCss = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'utf8');
const xtermFitJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'addon-fit', 'lib', 'addon-fit.js'), 'utf8');
const xtermWebglJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'addon-webgl', 'lib', 'addon-webgl.js'), 'utf8');
// @xterm/headless ships a CJS-only bundle (assigns to `exports`, no UMD); the
// wrapper below fakes `exports` and captures the module as a page global. It
// backs the clean feed: a PARSER-ONLY second terminal (no renderer at all),
// far cheaper than a hidden DOM terminal for the same job. The frame is read
// straight from the parsed buffer as PLAIN CELL TEXT (translateToString), so
// no escape sequence can ever leak into the reading view.
const xtermHeadlessJs = readFileSync(join(repoRoot, 'node_modules', '@xterm', 'headless', 'lib-headless', 'xterm-headless.js'), 'utf8');
const xtermVersion = JSON.parse(readFileSync(join(repoRoot, 'node_modules', '@xterm', 'xterm', 'package.json'), 'utf8')).version;

/**
 * The glue's emission order. Concatenation order is BEHAVIOR: top-level state
 * must be declared before the load-time statements that read it, and the
 * bootstrap's listeners go last. Everything between is hoisted function
 * declarations, kept in reading order.
 */
const PAGE_MODULE_ORDER = [
  'state.js',
  'domHelpers.js',
  'fontGeometry.js',
  'followPan.js',
  'modes.js',
  'historyScroll.js',
  'webglRenderer.js',
  'cleanFeed.js',
  'lifecycle.js',
  'heightFit.js',
  'panClamp.js',
  'refit.js',
  'dispatch.js',
  'gestureState.js',
  'probe.js',
  'bootstrap.js',
];

const pageModulesDir = join(repoRoot, 'scripts', 'xterm-page');
const onDisk = readdirSync(pageModulesDir).filter((name) => name.endsWith('.js')).sort();
const inManifest = [...PAGE_MODULE_ORDER].sort();
if (JSON.stringify(onDisk) !== JSON.stringify(inManifest)) {
  throw new Error(
    `scripts/xterm-page/ and PAGE_MODULE_ORDER disagree.\n  on disk:  ${onDisk.join(', ')}\n  manifest: ${inManifest.join(', ')}`,
  );
}

const GLUE_PRELUDE = "\n(function () {\n  'use strict';\n";
const GLUE_POSTLUDE = '})();\n';

let glueBody = '';
for (const moduleName of PAGE_MODULE_ORDER) {
  const moduleSource = readFileSync(join(pageModulesDir, moduleName), 'utf8');
  // Compile each module alone (never run it) so a syntax error names the
  // module and the line within it, not an offset into the concatenation.
  try {
    new Function(moduleSource);
  } catch (moduleSyntaxError) {
    throw new Error(`scripts/xterm-page/${moduleName} does not parse: ${moduleSyntaxError.message}`);
  }
  glueBody += moduleSource;
}

const bridgeGlue = GLUE_PRELUDE + glueBody + GLUE_POSTLUDE;

/**
 * Build stamp, written into BOTH the page and a TypeScript constant.
 *
 * xterm.html is a Metro ASSET, cached on the device by content hash and not
 * covered by Fast Refresh, so a reload can leave a stale page running against a
 * fresh JS bundle. That failure is silent and looks exactly like a fix that did
 * not work: three separate investigations here chased already-fixed bugs
 * because of it. Comparing the id the page reports against the id the bundle
 * expects turns it into a one-line verdict (see the `term` commands in
 * scripts/mobileInspect.mjs).
 *
 * The hash covers the glue with its placeholder still in place, which keeps it
 * a pure function of the authored source rather than of itself.
 */
const buildId = createHash('sha256').update(bridgeGlue).digest('hex').slice(0, 12);
const stampedGlue = bridgeGlue.replace('__XTERM_BUILD_ID__', buildId);
if (stampedGlue === bridgeGlue) {
  throw new Error('build id placeholder __XTERM_BUILD_ID__ missing from the bridge glue');
}

// Compile the assembled glue too (never run it): the per-module checks cannot
// see a construct left dangling ACROSS files, e.g. a brace opened in one
// module and closed in the next after a bad split.
try {
  new Function(stampedGlue);
} catch (glueSyntaxError) {
  throw new Error(`bridge glue does not parse: ${glueSyntaxError.message}`);
}

const html = `<!DOCTYPE html>
<!-- GENERATED FILE - do not hand-edit. Regenerate with: node scripts/buildXtermHtml.mjs (xterm ${xtermVersion}, build ${buildId}) -->
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline';">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<style>
${xtermCss}
html, body { margin: 0; padding: 0; background: #000000; height: 100%; overflow: hidden; }
/* The grid fills the phone HEIGHT (autoFitFontToScreen sizes the font to the row
   count) and is pinned top/left: column 0, row 0 start at the top-left corner. A
   wide grid overflows the width and pans right inside #scroll-container (follow-
   the-cursor tracks the active column); a grid taller than the viewport pans down.
   width:max-content keeps the terminal its natural grid width so the overflow is
   real and scrollable rather than wrapped. */
/* Horizontal pans, vertical deliberately does NOT. A one-finger vertical drag
   is history scrolling (consumeHistoryDrag), so the container must not consume
   it as a pan first: with overflow-y auto the browser swallowed the gesture
   whenever zoom had made the grid taller than the screen, and history stopped
   responding. The cost is that the bottom of a zoomed-in frame cannot be
   dragged to, which is the accepted trade for one finger and no modes. */
#scroll-container { width: 100%; height: 100%; overflow-x: auto; overflow-y: hidden; -webkit-overflow-scrolling: touch; }
/* Auto side margins CENTRE a grid narrower than the screen and do nothing to a
   wider one, which is exactly the split we want. The font is fitted to the
   pane's HEIGHT, so a grid whose aspect is taller than the pane's cannot fill
   the width at any font size - the leftover is inherent, not a bug. Pinned
   left it all piles up on the right and reads as a terminal cut short; split
   evenly it reads as a margin. When the grid IS wider, auto margins compute to
   zero, the overflow stays real, and the pan logic is untouched. The VERTICAL
   half of that split is padding-top, set from the measured grid by
   centerGridVertically (it needs the painted height, which no CSS rule has). */
/* translateZ(0) keeps the grid on its own compositor layer - see
   applyVerticalOffset, whose inline transform preserves it. Without the
   promotion, Android WebView sometimes skips recompositing a fully repainted
   canvas (a black terminal until a 1px scroll invalidates the layer). */
#terminal { width: max-content; margin: 0 auto; transform: translateZ(0); }
</style>
</head>
<body>
<div id="scroll-container"><div id="terminal"></div></div>
<script>
${xtermJs}
</script>
<script>
${xtermFitJs}
</script>
<script>
${xtermWebglJs}
</script>
<script>
var HeadlessXterm = (function () { var exports = {}; ${xtermHeadlessJs}
return exports; })();
</script>
<script>
${stampedGlue}
</script>
</body>
</html>
`;

const outputPath = join(repoRoot, 'src', 'terminal', 'xterm.html');
writeFileSync(outputPath, html);

const buildIdPath = join(repoRoot, 'src', 'terminal', 'xtermBuildId.ts');
writeFileSync(
  buildIdPath,
  `/**
 * GENERATED FILE - do not hand-edit. Regenerate with: node scripts/buildXtermHtml.mjs
 *
 * The build id baked into src/terminal/xterm.html by the same run that wrote
 * this file. The JS bundle carries this constant; the WebView reports the one
 * in the page it actually loaded. A mismatch means the device is running a
 * STALE terminal asset (Metro caches xterm.html by content hash and Fast
 * Refresh does not cover assets), which otherwise presents as a fix that did
 * not take.
 */
export const XTERM_BUILD_ID = '${buildId}';
`,
);

process.stdout.write(
  `Wrote ${outputPath} (xterm ${xtermVersion}, ${(html.length / 1024).toFixed(0)} KiB, build ${buildId})\n`,
);
