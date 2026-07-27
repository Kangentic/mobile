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
 *   3. Parses the Overseer mascot frames (pure <rect> pixel grids) into typed
 *      frame data in src/brand/overseerFrames.generated.ts, mapping each
 *      rect's fill hex to a semantic role. An unknown fill hex FAILS the run
 *      (drift guard against a brand palette change slipping in silently).
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

/** Mascot frames, in the order they appear in the generated file. */
const OVERSEER_FRAME_SOURCES = [
  { file: 'overseer.svg', frameName: 'canonical' },
  { file: 'overseer-blink.svg', frameName: 'blink' },
  { file: 'overseer-wave.svg', frameName: 'wave' },
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

function buildOverseerModule() {
  const parsedFrames = OVERSEER_FRAME_SOURCES.map(({ file, frameName }) => ({ frameName, file, ...parseOverseerFrame(file) }));

  const [firstFrame] = parsedFrames;
  for (const frame of parsedFrames) {
    if (frame.gridColumns !== firstFrame.gridColumns || frame.gridRows !== firstFrame.gridRows) {
      throw new Error(
        `syncBranding: mascot frames disagree on grid size (${frame.file} is ` +
          `${frame.gridColumns}x${frame.gridRows}, ${firstFrame.file} is ${firstFrame.gridColumns}x${firstFrame.gridRows})`,
      );
    }
  }

  const lines = [
    GENERATED_HEADER,
    '',
    '/**',
    ' * The Overseer mascot as typed pixel-grid frame data, parsed from the pure',
    " * <rect> mascot SVGs. Roles map to brand colors at render time (body = brand",
    ' * amber, ink = brand ink, highlight = brand cream), so no consumer ever',
    ' * touches a hex value.',
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
    "export type OverseerFrameName = 'canonical' | 'blink' | 'wave';",
    '',
    `export const OVERSEER_GRID_COLUMNS = ${firstFrame.gridColumns};`,
    `export const OVERSEER_GRID_ROWS = ${firstFrame.gridRows};`,
    '',
    'export const overseerFrames: Record<OverseerFrameName, readonly OverseerFrameRect[]> = {',
  ];
  for (const frame of parsedFrames) {
    lines.push(`  ${frame.frameName}: [`);
    for (const rect of frame.rects) {
      lines.push(`    { x: ${rect.x}, y: ${rect.y}, width: ${rect.width}, height: ${rect.height}, role: '${rect.role}' },`);
    }
    lines.push('  ],');
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
