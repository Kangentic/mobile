#!/usr/bin/env node
/**
 * Syncs brand assets from the @kangentic/branding devDependency into this
 * repo. Single-purpose and zero-dep (node builtins only). It:
 *
 *   1. Copies the mobile icon PNGs into assets/brand/ (app icon, Android
 *      adaptive layers, splash mark).
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
