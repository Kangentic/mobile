#!/usr/bin/env node
/**
 * Syncs brand assets from the @kangentic/branding devDependency into this
 * repo. Single-purpose and zero-dep (node builtins only). It:
 *
 *   1. Copies the mobile icon PNGs into assets/brand/ (app icon, Android
 *      adaptive layers, splash mark, the iOS Board tab rasters).
 *   2. Inlines the brandmark SVG XML as exported string constants in
 *      src/brand/brandmarkXml.generated.ts (for SvgXml rendering with no
 *      asset loader or network).
 *   3. Parses the Overseer mascot frames (pure <rect> pixel grids) and the
 *      assets/mascot/animations.json motion manifest into typed frame and
 *      sequence data in src/brand/overseerFrames.generated.ts, mapping each
 *      rect's fill hex to a semantic role. An unknown fill hex, or a manifest
 *      value this script does not know how to render (an unknown frame
 *      compositing mode, an idle bias other than "square", a reducedMotion
 *      target other than "rest", an inverted millisecond window, a one-shot
 *      carrying a random idle or repeat gap) FAILS the run (drift guard
 *      against an upstream change slipping in silently). The frame and
 *      sequence lists themselves come from the manifest, so a new pose or
 *      sequence upstream needs no edit here.
 *
 *      The manifest's per-sequence `mountFrames` is deliberately NOT consumed.
 *      It tells a CSS player which frame divs to stack (a sequence also rests on
 *      restFrame under reduced motion, even when its clip never names it), and
 *      Overseer.tsx is not that shape: it renders exactly one frame at a time
 *      from overseerFrames[frameName] and rests on OVERSEER_REST_FRAME, so it
 *      satisfies the mount contract structurally. Nothing to wire.
 *
 *   4. Parses the activity status marks (assets/activity/*.svg) and their
 *      assets/activity/activity.json contract into typed shape data in
 *      src/brand/activityMarks.generated.ts - structured elements rather than
 *      inlined XML, because the working mark's stroke-dashoffset is animated and
 *      an animated prop needs an addressable node. Same hard-fail discipline: an
 *      SVG element the renderer cannot draw, a reducedMotion or motion value it
 *      does not implement, a dash that does not close its outline (the
 *      pathLength trap), or an SVG that disagrees with the manifest all FAIL.
 *
 * Usage:
 *   node scripts/syncBranding.mjs          Regenerate outputs in place.
 *   node scripts/syncBranding.mjs --check  Regenerate to a temp dir and diff
 *                                          against the committed outputs;
 *                                          exits nonzero on any drift.
 *
 * Run after an @kangentic/branding upgrade, then commit the regenerated
 * outputs. The check mode runs as a step in the `Lint (ESLint)` CI job.
 */
import { Buffer } from 'node:buffer';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const brandingRoot = join(repoRoot, 'node_modules', '@kangentic', 'branding');

/** PNG copies: branding package path -> repo path (both relative). */
const PNG_COPIES = [
  { source: join('resources', 'mobile', 'ios-appstore-1024.png'), destination: join('assets', 'brand', 'icon.png') },
  {
    source: join('resources', 'mobile', 'android-adaptive-foreground.png'),
    destination: join('assets', 'brand', 'adaptive-icon-foreground.png'),
  },
  {
    source: join('resources', 'mobile', 'android-adaptive-background.png'),
    destination: join('assets', 'brand', 'adaptive-icon-background.png'),
  },
  // A dedicated mobile splash source as of v2.4.0. It replaced a borrowed
  // desktop icon-512, so the displayed-size reasoning that justified that
  // borrow no longer applies: the branding package now sizes this one.
  { source: join('resources', 'mobile', 'splash-1024.png'), destination: join('assets', 'brand', 'splash-icon.png') },
  {
    source: join('resources', 'mobile', 'ios-appstore-1024-dark.png'),
    destination: join('assets', 'brand', 'icon-dark.png'),
  },
  {
    source: join('resources', 'mobile', 'ios-appstore-1024-tinted.png'),
    destination: join('assets', 'brand', 'icon-tinted.png'),
  },
  {
    source: join('resources', 'mobile', 'android-adaptive-monochrome.png'),
    destination: join('assets', 'brand', 'adaptive-icon-monochrome.png'),
  },
  {
    source: join('resources', 'mobile', 'notification-icon.png'),
    destination: join('assets', 'brand', 'notification-icon.png'),
  },
  // android-feature-graphic-1024x500.png is a Play Console upload, not a
  // bundled asset - deliberately absent from this table.
  //
  // The iOS Board tab rasters, as of v2.6.0. iOS needs a real UIImage for a tab
  // bar item, and SF Symbols has no kanban glyph, so this repo used to rasterise
  // its own copy of lucide SquareKanban; the package owns the glyph now.
  //
  // The destination names are Metro's scale family, NOT the upstream filenames:
  // one `require('kanban-tab.png')` resolves the @2x/@3x siblings by name, so
  // 25/50/75 must land as unsuffixed/@2x/@3x. A missing @3x does not error -
  // Metro serves the 1x and the icon goes soft on every modern iPhone.
  //
  // These are TEMPLATE images: UIKit discards their colour and paints the bar's
  // tint through the alpha channel, so they are copied byte-for-byte and never
  // composited onto a background, which would turn the whole tab slot into a
  // tinted block.
  { source: join('resources', 'mobile', 'kanban-tab-25.png'), destination: join('assets', 'brand', 'kanban-tab.png') },
  { source: join('resources', 'mobile', 'kanban-tab-50.png'), destination: join('assets', 'brand', 'kanban-tab@2x.png') },
  { source: join('resources', 'mobile', 'kanban-tab-75.png'), destination: join('assets', 'brand', 'kanban-tab@3x.png') },
];

/**
 * Brandmark SVGs inlined as string constants. These four cover the planned
 * Brandmark component variants (full, small size tier, strict mono, themed
 * mono-amber); brandmark-filled.svg exists in the package but has no
 * consumer here.
 */
const BRANDMARK_SOURCES = [
  { file: 'brandmark.svg', constantName: 'brandmarkXml' },
  { file: 'brandmark-small.svg', constantName: 'brandmarkSmallXml' },
  { file: 'brandmark-mono.svg', constantName: 'brandmarkMonoXml' },
  { file: 'brandmark-mono-amber.svg', constantName: 'brandmarkMonoAmberXml' },
];

/**
 * The activity marks this app renders, and only those.
 *
 * The package ships nine. The four `terminal-*` and four `control-*` marks
 * serve the desktop's Command Terminal and its pause/stop controls, which have
 * no surface here yet; inlining them would put geometry in the bundle that
 * nothing draws. Same reason BRANDMARK_SOURCES omits brandmark-filled.svg.
 * Adding a mark here is all it takes when a consumer appears.
 */
const ACTIVITY_MARKS = ['agent-idle', 'agent-working'];

/**
 * The SVG elements the activity renderer knows how to draw as react-native-svg
 * components. `<g>` is unwrapped rather than listed: upstream uses it purely to
 * hang a motion's CSS class on (`kng-spin` today, `kng-march` before 2.8.0), and
 * this renderer expresses that animation as animated props instead. Note the
 * class is never read, so a mark that changes primitive is invisible here - the
 * manifest's `motion` field is what this script goes by. Any other element fails
 * the run, because a shape this script silently skipped would ship as a mark
 * missing part of its glyph.
 */
const KNOWN_ACTIVITY_ELEMENTS = new Set(['rect', 'circle', 'path']);

/**
 * The reduced-motion renderings AgentStatusIcon implements. Upstream's contract
 * is that reduced motion is a RENDERING, not a mute button: 'keep-dash' rests
 * holding its arc, 'drop-dash' sheds the dash entirely (a frozen 65/35 outline
 * reads as torn rather than as at rest), 'static' never moved. A new value
 * needs a deliberate branch in the component, not a silent pass-through.
 */
const KNOWN_ACTIVITY_REST_RENDERINGS = new Set(['static', 'keep-dash', 'drop-dash']);

/**
 * The motions the component implements, mapped to the CSS property each one
 * animates upstream. Both are a dashed circle travelling one full cycle per
 * period and differ only in the primitive that moves it, so they share every
 * geometric check below and diverge on the property assertion alone.
 *
 * 2.8.0 moved agent-working (and both control rings) from the march to the
 * spin: stroke-dashoffset is a paint property the desktop's Chromium cannot
 * composite, so its indicators froze for as long as the renderer's main thread
 * was blocked. On a pathLength=100 circle a dash-offset shift of d is exactly a
 * rotation of d percent of 360 degrees, so the two render identically, and the
 * spin's duration moved 1200 -> 1400 to match the march so marks of different
 * primitives stay in lockstep.
 *
 * A motion absent from this table stops the run rather than shipping a mark
 * that quietly holds still, so adding one is a deliberate renderer change in
 * AgentStatusIcon. `blink` (an opacity, added in 2.8.0 for terminal-working) is
 * deliberately missing: ACTIVITY_MARKS does not sync that mark, so nothing here
 * can select it.
 */
const ACTIVITY_MOTION_PROPERTIES = { march: 'stroke-dashoffset', spin: 'transform' };
const KNOWN_ACTIVITY_MOTIONS = new Set([null, ...Object.keys(ACTIVITY_MOTION_PROPERTIES)]);

/**
 * Tolerance for the dash-length check below. The manifest rounds its user-unit
 * dash to 4 decimals, so a correct pair can sit ~1e-4 off the true arc length;
 * this is loose enough to accept that and tight enough that a ratio dash (which
 * misses by ~43 units on the agent ring) cannot pass.
 */
const DASH_LENGTH_EPSILON = 0.01;

/**
 * The mascot's three-fill palette, mapped to semantic roles. Any other fill in
 * a frame is a hard failure: it means the brand palette changed and the
 * mobile role mapping (and probably the theme tokens) need a deliberate pass.
 */
const ROLE_BY_FILL = {
  '#e8a33d': 'body',
  '#24201b': 'ink',
  '#fdfbf7': 'highlight',
};

const GENERATED_HEADER = [
  '/**',
  ' * GENERATED FILE. Do not hand-edit. Regenerate with: node scripts/syncBranding.mjs',
  ' * Source: the @kangentic/branding package (assets change there, never here).',
  ' * This file carries brand asset data, the one sanctioned exception to the',
  ' * "hex values live only in src/components/theme/tokens.ts" rule.',
  ' */',
].join('\n');

function escapeForTemplateLiteral(text) {
  return text.replaceAll('\\', '\\\\').replaceAll('`', '\\`').replaceAll('${', '\\${');
}

function buildBrandmarkModule() {
  const sections = [GENERATED_HEADER, ''];
  for (const { file, constantName } of BRANDMARK_SOURCES) {
    const svgPath = join(brandingRoot, 'assets', file);
    const svgXml = readFileSync(svgPath, 'utf8').trim();
    if (!svgXml.startsWith('<svg')) {
      throw new Error(`syncBranding: ${file} does not look like an SVG (starts with ${svgXml.slice(0, 20)})`);
    }
    sections.push(`/** Inlined XML of @kangentic/branding assets/${file}. */`);
    sections.push(`export const ${constantName} = \`${escapeForTemplateLiteral(svgXml)}\`;`);
    sections.push('');
  }
  return sections.join('\n');
}

function parseSvgAttributes(attributeText) {
  const attributes = {};
  const attributePattern = /([a-zA-Z-]+)="([^"]*)"/g;
  let match;
  while ((match = attributePattern.exec(attributeText)) !== null) {
    attributes[match[1]] = match[2];
  }
  return attributes;
}

function parseIntegerAttribute(attributes, name, fallback, context) {
  const rawValue = attributes[name];
  if (rawValue === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`syncBranding: ${context} is missing required attribute "${name}"`);
  }
  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed)) {
    throw new Error(`syncBranding: ${context} attribute "${name}"="${rawValue}" is not an integer (pixel grids are integral)`);
  }
  return parsed;
}

/**
 * The activity sibling of parseIntegerAttribute. These are stroked vector
 * glyphs, not pixel grids, so their coordinates are not held to the integer
 * rule parseIntegerAttribute enforces for the mascot. The needs-you envelope
 * (18 x 16 as of 2.7.1, pixel-hinted so its outline extrema land on integers)
 * happens to be all-integer today, but that is a fact about this asset, not a
 * contract this parser enforces: flaps, prompts and control interiors are
 * still deliberately fractional, and a future candidate box may be too.
 */
function parseFloatAttribute(attributes, name, fallback, context) {
  const rawValue = attributes[name];
  if (rawValue === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`syncBranding: ${context} is missing required attribute "${name}"`);
  }
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    throw new Error(`syncBranding: ${context} attribute "${name}"="${rawValue}" is not a finite number`);
  }
  return parsed;
}

/** Numbers land in generated source, so round away float noise deterministically. */
function roundToFourDecimals(value) {
  return Number(value.toFixed(4));
}

function parseOverseerFrame(file) {
  const svgPath = join(brandingRoot, 'assets', 'mascot', file);
  if (!existsSync(svgPath)) {
    throw new Error(`syncBranding: animations.json references ${file}, but it does not exist at ${svgPath}. Run npm install first.`);
  }
  const svgXml = readFileSync(svgPath, 'utf8');

  const svgTagMatch = /<svg\b([^>]*)>/.exec(svgXml);
  if (svgTagMatch === null) throw new Error(`syncBranding: ${file} has no <svg> root element`);
  const svgAttributes = parseSvgAttributes(svgTagMatch[1]);
  const gridColumns = parseIntegerAttribute(svgAttributes, 'width', undefined, `${file} <svg>`);
  const gridRows = parseIntegerAttribute(svgAttributes, 'height', undefined, `${file} <svg>`);

  const rects = [];
  const rectPattern = /<rect\b([^>]*)\/>/g;
  let rectMatch;
  while ((rectMatch = rectPattern.exec(svgXml)) !== null) {
    const attributes = parseSvgAttributes(rectMatch[1]);
    const context = `${file} <rect ${rectMatch[1].trim()}>`;
    const fill = attributes.fill;
    const role = ROLE_BY_FILL[fill];
    if (role === undefined) {
      throw new Error(
        `syncBranding: unknown mascot fill "${fill}" in ${file}. ` +
          `Known fills: ${Object.keys(ROLE_BY_FILL).join(', ')}. ` +
          'The brand palette changed; update ROLE_BY_FILL (and review the theme tokens) deliberately.',
      );
    }
    const rect = {
      x: parseIntegerAttribute(attributes, 'x', 0, context),
      y: parseIntegerAttribute(attributes, 'y', 0, context),
      width: parseIntegerAttribute(attributes, 'width', undefined, context),
      height: parseIntegerAttribute(attributes, 'height', undefined, context),
      role,
    };
    if (rect.x < 0 || rect.y < 0 || rect.x + rect.width > gridColumns || rect.y + rect.height > gridRows) {
      throw new Error(`syncBranding: ${context} exceeds the ${gridColumns}x${gridRows} grid`);
    }
    rects.push(rect);
  }
  if (rects.length === 0) throw new Error(`syncBranding: ${file} contains no <rect> elements`);
  return { gridColumns, gridRows, rects };
}

/** Single-quoted TS string literal, escaped. Frame/sequence names are simple kebab-case, but escape defensively. */
function quoteString(value) {
  return `'${value.replaceAll('\\', '\\\\').replaceAll("'", "\\'")}'`;
}

/**
 * The frame compositing modes this renderer knows about. Every one of them
 * ships a COMPLETE pixel grid, which is why Overseer.tsx can swap whole frames
 * with no layering logic. A mode that ships a partial patch would need a
 * deliberate compositing change in the renderer, so an unknown value fails
 * here rather than rendering a half-drawn mascot.
 */
const KNOWN_FRAME_COMPOSITING = new Set(['base', 'overlay', 'exclusive']);

function readOverseerManifest() {
  const manifestPath = join(brandingRoot, 'assets', 'mascot', 'animations.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`syncBranding: missing ${manifestPath}. Run npm install first.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (parseError) {
    throw new Error(`syncBranding: ${manifestPath} is not valid JSON: ${parseError.message}`);
  }
  // Every other failure in this script names the file and the field. Reading a
  // missing top-level key would otherwise surface as a bare TypeError from
  // whichever line happened to destructure it first.
  for (const requiredKey of ['grid', 'restFrame', 'frames', 'sequences']) {
    if (manifest[requiredKey] === undefined) {
      throw new Error(`syncBranding: ${manifestPath} is missing the required top-level "${requiredKey}" key`);
    }
  }
  return manifest;
}

/**
 * A millisecond window the runtime draws a random gap from. The runner feeds
 * the result straight to setTimeout, where an inverted window becomes a zero
 * delay: on a looping sequence that is a tight setState loop, not a slow one.
 */
function assertMillisecondWindow(context, minimumMs, maximumMs) {
  if (!(minimumMs >= 0) || !(maximumMs >= minimumMs)) {
    throw new Error(`syncBranding: ${context} window is ${minimumMs}-${maximumMs}ms, expected 0 <= min <= max`);
  }
}

/**
 * Every value the runtime clip runner (Overseer.tsx) interprets is validated
 * here: the frames it swaps to, the durations and millisecond windows it feeds
 * setTimeout, the reroll probability, and the reduced-motion target the runner
 * hardcodes. A manifest value this script does not know how to render FAILS
 * the run rather than degrading silently - the same drift guard ROLE_BY_FILL
 * applies to the pixel data, applied to the motion data.
 */
function validateOverseerSequence(sequenceName, sequence, frameNames) {
  if (typeof sequence.loop !== 'boolean') {
    throw new Error(`syncBranding: sequence "${sequenceName}" declares a non-boolean loop (${sequence.loop})`);
  }
  if (sequence.reducedMotion !== 'rest') {
    throw new Error(
      `syncBranding: sequence "${sequenceName}" declares reducedMotion "${sequence.reducedMotion}", expected "rest". ` +
        'A new reduced-motion target needs a deliberate runner change in Overseer.tsx, not a silent pass-through.',
    );
  }
  // An empty clip is only meaningful as the "none" sentinel, which is a
  // one-shot. Looping over nothing renders as a permanent rest frame: an
  // animation that silently does nothing rather than erroring.
  if (sequence.loop && sequence.clip.length === 0) {
    throw new Error(`syncBranding: sequence "${sequenceName}" loops over an empty clip, which never animates`);
  }
  for (const step of sequence.clip) {
    if (!frameNames.has(step.frame)) {
      throw new Error(`syncBranding: sequence "${sequenceName}" clip references unknown frame "${step.frame}"`);
    }
    if (!(step.durationMs > 0)) {
      throw new Error(`syncBranding: sequence "${sequenceName}" clip step "${step.frame}" has a non-positive durationMs`);
    }
  }
  if (sequence.idle !== undefined) {
    if (sequence.idle.bias !== 'square') {
      throw new Error(
        `syncBranding: sequence "${sequenceName}" idle.bias is "${sequence.idle.bias}", expected "square". ` +
          'The runtime draw formula (minMs + (maxMs - minMs) * random^2) is bias-specific; update it deliberately.',
      );
    }
    if (!frameNames.has(sequence.idle.frame)) {
      throw new Error(`syncBranding: sequence "${sequenceName}" idle references unknown frame "${sequence.idle.frame}"`);
    }
    assertMillisecondWindow(`sequence "${sequenceName}" idle`, sequence.idle.minMs, sequence.idle.maxMs);
  }
  if (sequence.repeat !== undefined) {
    if (!(sequence.repeat.chance > 0 && sequence.repeat.chance <= 1)) {
      throw new Error(
        `syncBranding: sequence "${sequenceName}" repeat.chance is ${sequence.repeat.chance}, ` +
          'expected a probability in (0, 1]',
      );
    }
    assertMillisecondWindow(`sequence "${sequenceName}" repeat gap`, sequence.repeat.gapMinMs, sequence.repeat.gapMaxMs);
  }
  // A one-shot publishes a fixed total in overseerOneShotDurationMs, and
  // screens navigate on it: PairingConfirmScreen holds the success state for
  // exactly that long before replacing the route. An idle gap or a repeat
  // reroll is a random draw the clip sum cannot express, so a one-shot
  // carrying either would silently make that published total a lie.
  for (const randomPolicyName of ['idle', 'repeat']) {
    if (!sequence.loop && sequence[randomPolicyName] !== undefined) {
      throw new Error(
        `syncBranding: one-shot sequence "${sequenceName}" declares "${randomPolicyName}", a random gap its ` +
          'published overseerOneShotDurationMs total cannot express. Make it a loop, or drop the policy.',
      );
    }
  }
}

function buildOverseerModule() {
  const manifest = readOverseerManifest();

  const frameEntries = Object.entries(manifest.frames);
  if (frameEntries.length === 0) throw new Error('syncBranding: animations.json declares no frames');
  const parsedFrames = frameEntries.map(([frameName, frame]) => {
    if (!KNOWN_FRAME_COMPOSITING.has(frame.compositing)) {
      throw new Error(
        `syncBranding: frame "${frameName}" declares compositing "${frame.compositing}", expected one of ` +
          `${[...KNOWN_FRAME_COMPOSITING].join(', ')}. Overseer.tsx swaps whole frames, so a mode that ships ` +
          'a partial patch needs a deliberate layering change there, not a silent render as a full frame.',
      );
    }
    return { frameName, file: frame.file, ...parseOverseerFrame(frame.file) };
  });

  const [firstFrame] = parsedFrames;
  for (const frame of parsedFrames) {
    if (frame.gridColumns !== firstFrame.gridColumns || frame.gridRows !== firstFrame.gridRows) {
      throw new Error(
        `syncBranding: mascot frames disagree on grid size (${frame.file} is ` +
          `${frame.gridColumns}x${frame.gridRows}, ${firstFrame.file} is ${firstFrame.gridColumns}x${firstFrame.gridRows})`,
      );
    }
  }
  if (manifest.grid.columns !== firstFrame.gridColumns || manifest.grid.rows !== firstFrame.gridRows) {
    throw new Error(
      `syncBranding: animations.json grid (${manifest.grid.columns}x${manifest.grid.rows}) disagrees with the mascot ` +
        `SVGs (${firstFrame.gridColumns}x${firstFrame.gridRows})`,
    );
  }
  if (!Object.prototype.hasOwnProperty.call(manifest.frames, manifest.restFrame)) {
    throw new Error(`syncBranding: animations.json restFrame "${manifest.restFrame}" is not a declared frame`);
  }

  const frameNames = new Set(parsedFrames.map((frame) => frame.frameName));
  const sequenceEntries = Object.entries(manifest.sequences);
  if (sequenceEntries.length === 0) throw new Error('syncBranding: animations.json declares no sequences');
  for (const [sequenceName, sequence] of sequenceEntries) {
    validateOverseerSequence(sequenceName, sequence, frameNames);
  }
  const oneShotSequenceEntries = sequenceEntries.filter(([, sequence]) => sequence.loop === false);

  const lines = [
    GENERATED_HEADER,
    '',
    '/**',
    ' * The Overseer mascot as typed pixel-grid frame data, parsed from the pure',
    ' * <rect> mascot SVGs, plus its motion sequences, parsed from',
    ' * @kangentic/branding/assets/mascot/animations.json. Roles map to brand',
    ' * colors at render time (body = brand amber, ink = brand ink, highlight =',
    ' * brand cream), so no consumer ever touches a hex value, and sequence',
    ' * timings arrive with the assets so they cannot hand-drift locally.',
    ' */',
    '',
    "export type OverseerRectRole = 'body' | 'ink' | 'highlight';",
    '',
    'export interface OverseerFrameRect {',
    '  x: number;',
    '  y: number;',
    '  width: number;',
    '  height: number;',
    '  role: OverseerRectRole;',
    '}',
    '',
    `export type OverseerFrameName = ${parsedFrames.map((frame) => quoteString(frame.frameName)).join(' | ')};`,
    '',
    `export type OverseerAnimation = ${sequenceEntries.map(([sequenceName]) => quoteString(sequenceName)).join(' | ')};`,
    '',
    '/** One-shots only: a loop has no total duration, and asking for one is a bug. */',
    `export type OverseerOneShotAnimation = ${oneShotSequenceEntries.map(([sequenceName]) => quoteString(sequenceName)).join(' | ')};`,
    '',
    `export const OVERSEER_GRID_COLUMNS = ${firstFrame.gridColumns};`,
    `export const OVERSEER_GRID_ROWS = ${firstFrame.gridRows};`,
    `export const OVERSEER_REST_FRAME: OverseerFrameName = ${quoteString(manifest.restFrame)};`,
    '',
    'export const overseerFrames: Record<OverseerFrameName, readonly OverseerFrameRect[]> = {',
  ];
  for (const frame of parsedFrames) {
    lines.push(`  ${quoteString(frame.frameName)}: [`);
    for (const rect of frame.rects) {
      lines.push(`    { x: ${rect.x}, y: ${rect.y}, width: ${rect.width}, height: ${rect.height}, role: '${rect.role}' },`);
    }
    lines.push('  ],');
  }
  lines.push('};');
  lines.push('');

  lines.push(
    'export interface OverseerClipStep {',
    '  frame: OverseerFrameName;',
    '  durationMs: number;',
    '}',
    '',
    'export interface OverseerIdlePolicy {',
    '  frame: OverseerFrameName;',
    '  minMs: number;',
    '  maxMs: number;',
    '}',
    '',
    'export interface OverseerRepeatPolicy {',
    '  chance: number;',
    '  gapMinMs: number;',
    '  gapMaxMs: number;',
    '}',
    '',
    'export interface OverseerSequence {',
    '  loop: boolean;',
    '  clip: readonly OverseerClipStep[];',
    '  /** Gap before each clip pass, drawn squared-bias: minMs + (maxMs - minMs) * random^2. */',
    '  idle?: OverseerIdlePolicy;',
    '  repeat?: OverseerRepeatPolicy;',
    '}',
    '',
    'export const overseerSequences: Record<OverseerAnimation, OverseerSequence> = {',
  );
  for (const [sequenceName, sequence] of sequenceEntries) {
    lines.push(`  ${quoteString(sequenceName)}: {`);
    lines.push(`    loop: ${sequence.loop},`);
    if (sequence.clip.length === 0) {
      lines.push('    clip: [],');
    } else {
      lines.push('    clip: [');
      for (const step of sequence.clip) {
        lines.push(`      { frame: ${quoteString(step.frame)}, durationMs: ${step.durationMs} },`);
      }
      lines.push('    ],');
    }
    if (sequence.idle !== undefined) {
      lines.push(
        `    idle: { frame: ${quoteString(sequence.idle.frame)}, minMs: ${sequence.idle.minMs}, maxMs: ${sequence.idle.maxMs} },`,
      );
    }
    if (sequence.repeat !== undefined) {
      lines.push(
        `    repeat: { chance: ${sequence.repeat.chance}, gapMinMs: ${sequence.repeat.gapMinMs}, gapMaxMs: ${sequence.repeat.gapMaxMs} },`,
      );
    }
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');

  lines.push(
    '/** Total playback time of a one-shot sequence (the sum of its clip). A loop has none. */',
    'export const overseerOneShotDurationMs: Record<OverseerOneShotAnimation, number> = {',
  );
  for (const [sequenceName, sequence] of oneShotSequenceEntries) {
    const totalMs = sequence.clip.reduce((sum, step) => sum + step.durationMs, 0);
    lines.push(`  ${quoteString(sequenceName)}: ${totalMs},`);
  }
  lines.push('};');
  lines.push('');

  return lines.join('\n');
}

function readActivityManifest() {
  const manifestPath = join(brandingRoot, 'assets', 'activity', 'activity.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`syncBranding: missing ${manifestPath}. Run npm install first.`);
  }
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch (parseError) {
    throw new Error(`syncBranding: ${manifestPath} is not valid JSON: ${parseError.message}`);
  }
  for (const requiredKey of ['grid', 'floors', 'motion', 'marks']) {
    if (manifest[requiredKey] === undefined) {
      throw new Error(`syncBranding: ${manifestPath} is missing the required top-level "${requiredKey}" key`);
    }
    // A non-null object, not merely present. Every check below indexes into
    // these, so a null or a scalar would surface as a bare TypeError from deep
    // inside the parse instead of a named error pointing at the bad key.
    if (manifest[requiredKey] === null || typeof manifest[requiredKey] !== 'object') {
      throw new Error(
        `syncBranding: ${manifestPath} top-level "${requiredKey}" is ${JSON.stringify(manifest[requiredKey])}, expected an object`,
      );
    }
  }
  // grid.pathLength is the denominator the ratio dash is expressed over, and
  // the whole user-unit derivation below rests on it, so it is checked here
  // rather than assumed at the point of division.
  if (!(manifest.grid.pathLength > 0)) {
    throw new Error(`syncBranding: activity.json grid.pathLength is ${manifest.grid.pathLength}, expected a positive number`);
  }
  if (typeof manifest.grid.viewBox !== 'string') {
    throw new Error(`syncBranding: activity.json grid.viewBox is ${manifest.grid.viewBox}, expected a string`);
  }
  // Four single-space-separated numbers, because the consumer parses this
  // string POSITIONALLY: AgentStatusIcon derives the below-floor dot's centre
  // with `ACTIVITY_VIEW_BOX.split(' ').map(Number)`. Comma separators and
  // repeated spaces are both legal SVG and would pass the bare string check
  // above, then reach the component as NaN coordinates - an invisible dot,
  // with nothing failing anywhere between here and the screen.
  const viewBoxParts = manifest.grid.viewBox.split(' ').map(Number);
  if (viewBoxParts.length !== 4 || viewBoxParts.some((part) => !Number.isFinite(part))) {
    throw new Error(
      `syncBranding: activity.json grid.viewBox "${manifest.grid.viewBox}" is not four space-separated numbers. ` +
        'AgentStatusIcon splits this string on single spaces to derive the mark grid, so any other form silently ' +
        'becomes NaN coordinates rather than failing.',
    );
  }
  if (!(manifest.grid.strokeWidth > 0)) {
    throw new Error(`syncBranding: activity.json grid.strokeWidth is ${manifest.grid.strokeWidth}, expected a positive number`);
  }
  for (const floorName of ['indicator', 'control']) {
    if (!(manifest.floors[floorName] > 0)) {
      throw new Error(`syncBranding: activity.json floors.${floorName} is ${manifest.floors[floorName]}, expected a positive number`);
    }
  }
  return manifest;
}

/** A `"42.4115 14.1372"` dash field as two positive numbers. */
function parseActivityDashPair(markName, fieldName, rawValue) {
  if (typeof rawValue !== 'string') {
    throw new Error(`syncBranding: mark "${markName}" is missing the required "${fieldName}" field`);
  }
  const parts = rawValue.trim().split(/\s+/).map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part) || part <= 0)) {
    throw new Error(`syncBranding: mark "${markName}" ${fieldName} "${rawValue}" is not two positive numbers`);
  }
  return parts;
}

/**
 * One activity mark as typed shape data, parsed from its SVG and cross-checked
 * against its activity.json entry. The two shipped representations must agree:
 * a mark whose SVG and manifest disagree is drift inside the package, and it
 * would otherwise land here as a glyph that renders subtly wrong.
 */
function parseActivityMark(markName, manifest) {
  const mark = manifest.marks[markName];
  if (mark === undefined) {
    throw new Error(`syncBranding: activity.json declares no mark "${markName}"`);
  }
  if (typeof mark.file !== 'string') {
    throw new Error(`syncBranding: mark "${markName}" is missing the required "file" field`);
  }
  const { file } = mark;
  const svgPath = join(brandingRoot, 'assets', 'activity', file);
  if (!existsSync(svgPath)) {
    throw new Error(`syncBranding: activity.json references ${file}, but it does not exist at ${svgPath}. Run npm install first.`);
  }
  const svgXml = readFileSync(svgPath, 'utf8');

  // currentColor only. A hex here would bake one consumer's palette into all
  // three: desktop, mobile and web deliberately carry different status tokens.
  const hexColorMatch = /#[0-9a-fA-F]{3,8}\b/.exec(svgXml);
  if (hexColorMatch !== null) {
    throw new Error(`syncBranding: ${file} carries the hex color "${hexColorMatch[0]}"; activity marks are currentColor only`);
  }

  const svgTagMatch = /<svg\b([^>]*)>/.exec(svgXml);
  if (svgTagMatch === null) throw new Error(`syncBranding: ${file} has no <svg> root element`);
  const rootAttributes = parseSvgAttributes(svgTagMatch[1]);
  if (rootAttributes.viewBox !== manifest.grid.viewBox) {
    throw new Error(
      `syncBranding: ${file} viewBox "${rootAttributes.viewBox}" disagrees with activity.json grid.viewBox "${manifest.grid.viewBox}"`,
    );
  }
  if (Number(rootAttributes['stroke-width']) !== manifest.grid.strokeWidth) {
    throw new Error(
      `syncBranding: ${file} stroke-width "${rootAttributes['stroke-width']}" disagrees with activity.json ` +
        `grid.strokeWidth ${manifest.grid.strokeWidth}`,
    );
  }
  if (rootAttributes.stroke !== 'currentColor') {
    throw new Error(`syncBranding: ${file} root stroke is "${rootAttributes.stroke}", expected "currentColor"`);
  }
  // Presence-checked here rather than left to the point of use. These two are
  // read off the root because AgentStatusIcon applies one stroke style to the
  // whole mark set, and buildActivityModule hands them straight to
  // quoteString, which on undefined throws a bare TypeError naming neither the
  // file nor the attribute. The run fails either way, so this buys a legible
  // error during exactly the upstream bump this module exists to make readable.
  for (const strokeStyleAttribute of ['stroke-linecap', 'stroke-linejoin']) {
    if (rootAttributes[strokeStyleAttribute] === undefined) {
      throw new Error(`syncBranding: ${file} root is missing the required attribute "${strokeStyleAttribute}"`);
    }
  }
  if (!KNOWN_ACTIVITY_REST_RENDERINGS.has(mark.reducedMotion)) {
    throw new Error(
      `syncBranding: mark "${markName}" declares reducedMotion "${mark.reducedMotion}", expected one of ` +
        `${[...KNOWN_ACTIVITY_REST_RENDERINGS].join(', ')}. Reduced motion is a rendering, not a mute button, so a ` +
        'new value needs a deliberate branch in AgentStatusIcon rather than a silent pass-through.',
    );
  }
  // The SVG's data-rest attribute restates the manifest's reducedMotion for the
  // CSS player's benefit. If they disagree, one of them is stale.
  if (rootAttributes['data-rest'] !== mark.reducedMotion) {
    throw new Error(
      `syncBranding: ${file} data-rest="${rootAttributes['data-rest']}" disagrees with activity.json reducedMotion ` +
        `"${mark.reducedMotion}" for mark "${markName}"`,
    );
  }
  const expectedFloor = markName.startsWith('control-') ? manifest.floors.control : manifest.floors.indicator;
  if (mark.minPx !== expectedFloor) {
    throw new Error(
      `syncBranding: mark "${markName}" declares minPx ${mark.minPx}, but its role's floor in activity.json is ${expectedFloor}`,
    );
  }

  const bodyStart = svgTagMatch.index + svgTagMatch[0].length;
  const bodyEnd = svgXml.lastIndexOf('</svg>');
  if (bodyEnd < bodyStart) throw new Error(`syncBranding: ${file} has no closing </svg>`);

  const elements = [];
  const elementPattern = /<([a-zA-Z]+)\b([^>]*?)\s*\/?>/g;
  let elementMatch;
  while ((elementMatch = elementPattern.exec(svgXml.slice(bodyStart, bodyEnd))) !== null) {
    const [, tagName, attributeText] = elementMatch;
    // Unwrapped rather than drawn - see KNOWN_ACTIVITY_ELEMENTS.
    if (tagName === 'g') continue;
    if (!KNOWN_ACTIVITY_ELEMENTS.has(tagName)) {
      throw new Error(
        `syncBranding: ${file} contains a <${tagName}> element, which the activity renderer cannot draw. ` +
          `Known elements: ${[...KNOWN_ACTIVITY_ELEMENTS].join(', ')}. Teach AgentStatusIcon the element ` +
          'deliberately rather than shipping a mark missing part of its glyph.',
      );
    }
    elements.push({ tagName, attributes: parseSvgAttributes(attributeText), context: `${file} <${tagName}>` });
  }
  if (elements.length === 0) throw new Error(`syncBranding: ${file} contains no drawable elements`);

  // The SVG says WHICH outline is dashed; the manifest says with what. The
  // committed stroke-dasharray is the pathLength RATIO, which react-native-svg
  // does not honour, so its value is deliberately never read.
  const dashedElements = elements.filter((element) => element.attributes['stroke-dasharray'] !== undefined);
  const declaredMotion = mark.motion ?? null;
  if (!KNOWN_ACTIVITY_MOTIONS.has(declaredMotion)) {
    throw new Error(
      `syncBranding: mark "${markName}" declares motion "${declaredMotion}", expected one of ` +
        `${[...KNOWN_ACTIVITY_MOTIONS].map((motion) => String(motion)).join(', ')}. AgentStatusIcon implements those ` +
        'motions only, so a new one must stop the run rather than render a mark that quietly holds still.',
    );
  }

  // undefined exactly when the mark declares no motion, because
  // KNOWN_ACTIVITY_MOTIONS is derived from this table plus null.
  const expectedProperty = declaredMotion === null ? undefined : ACTIVITY_MOTION_PROPERTIES[declaredMotion];

  let march;
  let spin;
  let dashUserUnits;
  if (expectedProperty !== undefined) {
    if (dashedElements.length !== 1) {
      throw new Error(
        `syncBranding: mark "${markName}" animates, but ${dashedElements.length} of its elements carry a ` +
          `stroke-dasharray. The ${declaredMotion} animates exactly one outline.`,
      );
    }
    const [dashedElement] = dashedElements;
    if (dashedElement.tagName !== 'circle') {
      throw new Error(
        `syncBranding: mark "${markName}" animates a <${dashedElement.tagName}>, but the user-unit dash can only be ` +
          'verified against a circle (2*pi*r). That check is the only mechanical proof the shipped dash is in user ' +
          'units rather than the pathLength ratio, so re-derive the period deliberately instead of loosening this. ' +
          'A spinning mark is still a dashed circle, so it earns no exemption.',
      );
    }
    dashUserUnits = parseActivityDashPair(markName, 'dashUserUnits', mark.dashUserUnits);
    const ratioDash = parseActivityDashPair(markName, 'dash', mark.dash);
    const ratioTotal = ratioDash[0] + ratioDash[1];
    if (ratioTotal !== manifest.grid.pathLength) {
      throw new Error(
        `syncBranding: mark "${markName}" dash "${mark.dash}" sums to ${ratioTotal}, expected grid.pathLength ` +
          `${manifest.grid.pathLength}. The user-unit period is derived from that equivalence.`,
      );
    }
    // One full dash cycle in user units. The march's CSS keyframe travels
    // stroke-dashoffset to -pathLength; because the ratio dash sums to
    // pathLength, the user-unit equivalent is exactly the user-unit dash sum.
    // Derived for EVERY animated motion, not just the march that consumes it:
    // the closure check below is the only mechanical proof the shipped dash is
    // in user units, and a spinning mark is just as able to ship the ratio form.
    const periodUserUnits = roundToFourDecimals(dashUserUnits[0] + dashUserUnits[1]);
    const radius = parseFloatAttribute(dashedElement.attributes, 'r', undefined, dashedElement.context);
    const circumference = 2 * Math.PI * radius;
    if (Math.abs(periodUserUnits - circumference) > DASH_LENGTH_EPSILON) {
      throw new Error(
        `syncBranding: mark "${markName}" dashUserUnits "${mark.dashUserUnits}" sums to ${periodUserUnits}, but its ` +
          `r=${radius} circle is ${roundToFourDecimals(circumference)} user units around. A dash that does not close ` +
          'the outline means the ratio form leaked through: react-native-svg ignores pathLength, so a "75" dash ' +
          'covers a 56-unit circle entirely and the motion disappears.',
      );
    }
    const motionSpec = manifest.motion[declaredMotion];
    if (motionSpec === undefined) {
      throw new Error(`syncBranding: activity.json declares no motion "${declaredMotion}" for mark "${markName}"`);
    }
    if (!(motionSpec.durationMs > 0)) {
      throw new Error(`syncBranding: activity.json motion.${declaredMotion}.durationMs is ${motionSpec.durationMs}, expected positive`);
    }
    if (motionSpec.timing !== 'linear') {
      throw new Error(
        `syncBranding: activity.json motion.${declaredMotion}.timing is "${motionSpec.timing}", expected "linear". ` +
          'AgentStatusIcon drives Easing.linear; another curve needs a deliberate change there.',
      );
    }
    if (motionSpec.property !== expectedProperty) {
      throw new Error(
        `syncBranding: activity.json motion.${declaredMotion}.property is "${motionSpec.property}", expected ` +
          `"${expectedProperty}". Which primitive a mark gets is decided by geometry rather than taste, so a motion ` +
          'that changed property is a redrawn mark, not a rename.',
      );
    }
    // The spin carries no periodUserUnits: it travels 360 degrees, not an arc
    // length, so a dash-travel distance would be a number nothing could use.
    // It is still derived above, because the closure check needs it.
    if (declaredMotion === 'march') {
      march = { durationMs: motionSpec.durationMs, periodUserUnits };
    } else {
      spin = { durationMs: motionSpec.durationMs };
    }
  } else if (dashedElements.length !== 0) {
    throw new Error(
      `syncBranding: mark "${markName}" declares no motion, but ${dashedElements.length} of its elements carry a ` +
        'stroke-dasharray. A static mark holding a dash would render as a torn outline.',
    );
  }

  const shapes = elements.map((element) => {
    const { tagName, attributes, context } = element;
    if (tagName === 'rect') {
      return {
        kind: 'rect',
        x: parseFloatAttribute(attributes, 'x', 0, context),
        y: parseFloatAttribute(attributes, 'y', 0, context),
        width: parseFloatAttribute(attributes, 'width', undefined, context),
        height: parseFloatAttribute(attributes, 'height', undefined, context),
        rx: parseFloatAttribute(attributes, 'rx', 0, context),
      };
    }
    if (tagName === 'circle') {
      return {
        kind: 'circle',
        cx: parseFloatAttribute(attributes, 'cx', undefined, context),
        cy: parseFloatAttribute(attributes, 'cy', undefined, context),
        r: parseFloatAttribute(attributes, 'r', undefined, context),
        dash: attributes['stroke-dasharray'] !== undefined ? dashUserUnits : undefined,
      };
    }
    const pathData = attributes.d;
    if (pathData === undefined || pathData.trim() === '') {
      throw new Error(`syncBranding: ${context} is missing required attribute "d"`);
    }
    return { kind: 'path', d: pathData };
  });

  return {
    markName,
    shapes,
    march,
    spin,
    restRendering: mark.reducedMotion,
    minPx: mark.minPx,
    strokeLinecap: rootAttributes['stroke-linecap'],
    strokeLinejoin: rootAttributes['stroke-linejoin'],
  };
}

function activityShapeLiteral(shape) {
  if (shape.kind === 'rect') {
    return `{ kind: 'rect', x: ${shape.x}, y: ${shape.y}, width: ${shape.width}, height: ${shape.height}, rx: ${shape.rx} }`;
  }
  if (shape.kind === 'circle') {
    const dash = shape.dash === undefined ? '' : `, dash: [${shape.dash[0]}, ${shape.dash[1]}]`;
    return `{ kind: 'circle', cx: ${shape.cx}, cy: ${shape.cy}, r: ${shape.r}${dash} }`;
  }
  return `{ kind: 'path', d: ${quoteString(shape.d)} }`;
}

function buildActivityModule() {
  const manifest = readActivityManifest();
  const parsedMarks = ACTIVITY_MARKS.map((markName) => parseActivityMark(markName, manifest));

  const [firstMark] = parsedMarks;
  for (const mark of parsedMarks) {
    if (mark.strokeLinecap !== firstMark.strokeLinecap || mark.strokeLinejoin !== firstMark.strokeLinejoin) {
      throw new Error(
        `syncBranding: activity marks disagree on stroke style ("${mark.markName}" is ${mark.strokeLinecap}/` +
          `${mark.strokeLinejoin}, "${firstMark.markName}" is ${firstMark.strokeLinecap}/${firstMark.strokeLinejoin}). ` +
          'AgentStatusIcon applies one stroke style to the whole set.',
      );
    }
  }

  const lines = [
    GENERATED_HEADER,
    '',
    '/**',
    ' * The activity status marks as typed shape data, parsed from',
    ' * @kangentic/branding/assets/activity/*.svg and its activity.json contract.',
    ' * Structured elements rather than inlined XML, because the working mark',
    ' * MOVES: the spin animates a transform matrix on a group around its ring,',
    ' * and an animated prop needs a real addressable node, which an SvgXml blob',
    ' * cannot give.',
    ' *',
    ' * Every mark is currentColor, so the consumer supplies the tone and no hex',
    ' * appears here. Dashes are the manifest\'s USER-UNIT form, never the',
    ' * pathLength ratio: react-native-svg does not honour pathLength, and a "75"',
    ' * dash covers the 56-unit agent ring entirely, so the motion disappears.',
    ' * pathLength is dropped by construction - this module emits typed',
    ' * attributes rather than passing SVG through.',
    ' */',
    '',
    `export type ActivityMarkName = ${parsedMarks.map((mark) => quoteString(mark.markName)).join(' | ')};`,
    '',
    '/** How a mark renders when the OS asks for reduced motion. */',
    `export type ActivityRestRendering = ${[...KNOWN_ACTIVITY_REST_RENDERINGS].map(quoteString).join(' | ')};`,
    '',
    'export interface ActivityRectShape {',
    "  kind: 'rect';",
    '  x: number;',
    '  y: number;',
    '  width: number;',
    '  height: number;',
    '  rx: number;',
    '}',
    '',
    'export interface ActivityCircleShape {',
    "  kind: 'circle';",
    '  cx: number;',
    '  cy: number;',
    '  r: number;',
    '  /** The user-unit stroke dash, present only on the outline that animates. */',
    '  dash?: readonly [number, number];',
    '}',
    '',
    'export interface ActivityPathShape {',
    "  kind: 'path';",
    '  d: string;',
    '}',
    '',
    'export type ActivityShape = ActivityRectShape | ActivityCircleShape | ActivityPathShape;',
    '',
    'export interface ActivityMarchMotion {',
    '  durationMs: number;',
    '  /** One full dash cycle in user units: how far the offset travels per pass. */',
    '  periodUserUnits: number;',
    '}',
    '',
    '/**',
    ' * One full turn per period. There is no distance to carry the way the march',
    ' * has one: a rotation travels 360 degrees whatever the outline measures.',
    ' */',
    'export interface ActivitySpinMotion {',
    '  durationMs: number;',
    '}',
    '',
    'export interface ActivityMark {',
    '  shapes: readonly ActivityShape[];',
    '  /** Present only on a marching mark. Mutually exclusive with `spin`. */',
    '  march?: ActivityMarchMotion;',
    '  /** Present only on a spinning mark. Mutually exclusive with `march`. */',
    '  spin?: ActivitySpinMotion;',
    '  restRendering: ActivityRestRendering;',
    '  /** Below this rendered size, draw a dot instead of the mark. */',
    '  minPx: number;',
    '}',
    '',
    `export const ACTIVITY_VIEW_BOX = ${quoteString(manifest.grid.viewBox)};`,
    `export const ACTIVITY_STROKE_WIDTH = ${manifest.grid.strokeWidth};`,
    `export const ACTIVITY_STROKE_LINECAP = ${quoteString(firstMark.strokeLinecap)};`,
    `export const ACTIVITY_STROKE_LINEJOIN = ${quoteString(firstMark.strokeLinejoin)};`,
    '',
    'export const activityMarks: Record<ActivityMarkName, ActivityMark> = {',
  ];
  for (const mark of parsedMarks) {
    lines.push(`  ${quoteString(mark.markName)}: {`);
    lines.push('    shapes: [');
    for (const shape of mark.shapes) {
      lines.push(`      ${activityShapeLiteral(shape)},`);
    }
    lines.push('    ],');
    if (mark.march !== undefined) {
      lines.push(`    march: { durationMs: ${mark.march.durationMs}, periodUserUnits: ${mark.march.periodUserUnits} },`);
    }
    if (mark.spin !== undefined) {
      lines.push(`    spin: { durationMs: ${mark.spin.durationMs} },`);
    }
    lines.push(`    restRendering: ${quoteString(mark.restRendering)},`);
    lines.push(`    minPx: ${mark.minPx},`);
    lines.push('  },');
  }
  lines.push('};');
  lines.push('');

  return lines.join('\n');
}

/** Every output as { repoRelativePath, kind, content } (content is a Buffer). */
function buildOutputs() {
  const outputs = [];
  for (const { source, destination } of PNG_COPIES) {
    const sourcePath = join(brandingRoot, source);
    if (!existsSync(sourcePath)) {
      throw new Error(`syncBranding: missing branding source ${sourcePath}. Run npm install first.`);
    }
    outputs.push({ repoRelativePath: destination, content: readFileSync(sourcePath) });
  }
  outputs.push({ repoRelativePath: join('src', 'brand', 'brandmarkXml.generated.ts'), content: Buffer.from(buildBrandmarkModule(), 'utf8') });
  outputs.push({ repoRelativePath: join('src', 'brand', 'overseerFrames.generated.ts'), content: Buffer.from(buildOverseerModule(), 'utf8') });
  outputs.push({ repoRelativePath: join('src', 'brand', 'activityMarks.generated.ts'), content: Buffer.from(buildActivityModule(), 'utf8') });
  return outputs;
}

function writeOutputs(outputs, targetRoot) {
  for (const output of outputs) {
    const outputPath = join(targetRoot, output.repoRelativePath);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, output.content);
  }
}

/** Text outputs compare newline-normalized so a CRLF checkout never reads as drift. */
function contentsMatch(expected, actual, repoRelativePath) {
  if (repoRelativePath.endsWith('.ts')) {
    return expected.toString('utf8').replaceAll('\r\n', '\n') === actual.toString('utf8').replaceAll('\r\n', '\n');
  }
  return expected.equals(actual);
}

function runCheck(outputs) {
  const tempRoot = mkdtempSync(join(tmpdir(), 'kangentic-branding-check-'));
  try {
    writeOutputs(outputs, tempRoot);
    const driftedPaths = [];
    for (const output of outputs) {
      const committedPath = join(repoRoot, output.repoRelativePath);
      const regeneratedPath = join(tempRoot, output.repoRelativePath);
      if (!existsSync(committedPath)) {
        driftedPaths.push(`${output.repoRelativePath} (missing)`);
        continue;
      }
      if (!contentsMatch(readFileSync(regeneratedPath), readFileSync(committedPath), output.repoRelativePath)) {
        driftedPaths.push(output.repoRelativePath);
      }
    }
    if (driftedPaths.length > 0) {
      process.stderr.write('syncBranding --check: outputs have drifted from @kangentic/branding:\n');
      for (const driftedPath of driftedPaths) {
        process.stderr.write(`  ${driftedPath}\n`);
      }
      process.stderr.write('Run: npm run sync:branding (then commit the regenerated outputs)\n');
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`syncBranding --check: ${outputs.length} outputs in sync\n`);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

const isCheckMode = process.argv.includes('--check');
const outputs = buildOutputs();
if (isCheckMode) {
  runCheck(outputs);
} else {
  writeOutputs(outputs, repoRoot);
  for (const output of outputs) {
    process.stdout.write(`Wrote ${output.repoRelativePath} (${output.content.length} bytes)\n`);
  }
}
