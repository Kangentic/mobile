/**
 * Shape and invariants of the generated activity mark data
 * (src/brand/activityMarks.generated.ts, produced by scripts/syncBranding.mjs
 * from @kangentic/branding's assets/activity/).
 *
 * The assertions that matter here compare the generated output against the
 * PACKAGE MANIFEST rather than against typed literals, because the failure this
 * file exists to catch is the generator reading the wrong field. `activity.json`
 * ships every dash twice - as a `pathLength`-relative ratio (`"75 25"`) and in
 * user units (`"42.4115 14.1372"`) - and react-native-svg does not honour
 * `pathLength`. Take the ratio and a 75-unit dash covers the 56-unit agent ring
 * completely: the icon renders as a solid circle and the motion silently
 * disappears. Nothing about that looks broken in a diff, a typecheck, or a
 * snapshot, which is why it is pinned against the source of truth.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_STROKE_LINECAP,
  ACTIVITY_STROKE_LINEJOIN,
  ACTIVITY_STROKE_WIDTH,
  ACTIVITY_VIEW_BOX,
  activityMarks,
  type ActivityCircleShape,
  type ActivityMarkName,
  type ActivityPathShape,
  type ActivityRectShape,
} from '@/brand/activityMarks.generated';

interface ActivityManifestMark {
  file: string;
  /** The mark's role family ('envelope', 'ring', 'terminal', 'control-stop', ...): what the floors are keyed on upstream. */
  silhouette: string;
  dash?: string;
  dashUserUnits?: string;
  reducedMotion: string;
  minPx: number;
  motion: string | null;
  /** 'attention', 'active' or 'rest': which of the surface's tokens tints it. */
  tone: string;
}

interface ActivityManifest {
  grid: { viewBox: string; inkBox: number; strokeWidth: number; pathLength: number };
  floors: { indicator: number; control: number };
  motion: Record<string, { durationMs: number; timing: string; property: string }>;
  marks: Record<string, ActivityManifestMark>;
}

const manifest = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../node_modules/@kangentic/branding/assets/activity/activity.json', import.meta.url)),
    'utf8',
  ),
) as ActivityManifest;

// activity.json does not carry stroke-linecap/stroke-linejoin: the generator
// reads those off the SVG root, not the manifest. So the cross-check for them
// has to read the SVG source directly, the same way the manifest is read above.
const workingMarkSvgSource = readFileSync(
  fileURLToPath(new URL('../../node_modules/@kangentic/branding/assets/activity/agent-working.svg', import.meta.url)),
  'utf8',
);
const idleMarkSvgSource = readFileSync(
  fileURLToPath(new URL('../../node_modules/@kangentic/branding/assets/activity/agent-idle.svg', import.meta.url)),
  'utf8',
);

/** Reads a `name="value"` attribute off the raw <svg> root markup. */
function svgRootAttribute(svgSource: string, attributeName: string): string {
  const match = svgSource.match(new RegExp(`${attributeName}="([^"]+)"`));
  if (match === null) throw new Error(`${attributeName} is missing from the svg source; cannot cross-check it`);
  return match[1];
}

/**
 * The raw <rect .../> markup from an activity SVG source, isolated from the
 * rest of the document. Attribute lookups MUST be scoped to this substring
 * rather than run against the whole svgSource the way svgRootAttribute does:
 * the <svg> root's own viewBox="0 0 24 24" embeds "0 0 24 24", so an
 * unanchored `x="..."` or `width="..."` search on the full source matches
 * inside the root tag first and silently cross-checks the wrong element.
 */
function svgRectMarkup(svgSource: string): string {
  const match = svgSource.match(/<rect\s+[^>]*\/>/);
  if (match === null) throw new Error('no <rect> element in the svg source; cannot cross-check it');
  return match[0];
}

/** Reads a numeric `name="value"` attribute off a single element's isolated markup. */
function elementNumberAttribute(elementMarkup: string, attributeName: string): number {
  const match = elementMarkup.match(new RegExp(`${attributeName}="([^"]+)"`));
  if (match === null) throw new Error(`${attributeName} is missing from "${elementMarkup}"; cannot cross-check it`);
  return Number(match[1]);
}

const MARK_NAMES = Object.keys(activityMarks) as ActivityMarkName[];
const KNOWN_REST_RENDERINGS = new Set(['static', 'keep-dash', 'drop-dash']);

/**
 * The eight marks the app draws, and no others. The package ships eleven; the
 * rest are left out on purpose, each for a reason that is a design decision and
 * not an oversight (scripts/syncBranding.mjs, ACTIVITY_MARKS):
 *
 * - `terminal-working` has a `blink` (an opacity), and the approved design draws
 *   a working terminal STATIC, because a blink on every working row would be an
 *   animation that never stops (motion-conventions.md).
 * - `control-pause-*` is not drawn: the phone's Pause is a sheet row, not the
 *   desktop's ring control.
 */
const EXPECTED_MARK_NAMES = [
  'agent-approval',
  'agent-idle',
  'agent-question',
  'agent-working',
  'control-stop-idle',
  'control-stop-working',
  'terminal-idle',
  'terminal-new',
];

/** The raw markup of a mark's upstream SVG, resolved through the manifest's own `file` field. */
function svgSourceFor(markName: ActivityMarkName): string {
  return readFileSync(
    fileURLToPath(new URL(`../../node_modules/@kangentic/branding/assets/activity/${manifest.marks[markName].file}`, import.meta.url)),
    'utf8',
  );
}

interface UpstreamElement {
  tagName: 'rect' | 'circle' | 'path';
  attributes: Record<string, string>;
  /** Whether the element sits inside the `<g>` the motion's class hangs on (`kng-spin`). */
  insideMotionGroup: boolean;
}

/**
 * Every drawable element of a mark's upstream SVG, in document order, parsed
 * independently of the generator under test: this is the source of truth the
 * generated shapes are compared against, so it must not share the generator's
 * parsing.
 */
function upstreamElements(markName: ActivityMarkName): UpstreamElement[] {
  const svgSource = svgSourceFor(markName);
  const groupMatch = /<g\b[^>]*>[\s\S]*?<\/g>/.exec(svgSource);
  const groupStart = groupMatch === null ? -1 : groupMatch.index;
  const groupEnd = groupMatch === null ? -1 : groupMatch.index + groupMatch[0].length;
  const elements: UpstreamElement[] = [];
  for (const elementMatch of svgSource.matchAll(/<(rect|circle|path)\b([^>]*?)\/?>/g)) {
    const attributes: Record<string, string> = {};
    for (const attributeMatch of elementMatch[2].matchAll(/([a-zA-Z-]+)="([^"]*)"/g)) {
      attributes[attributeMatch[1]] = attributeMatch[2];
    }
    elements.push({
      tagName: elementMatch[1] as UpstreamElement['tagName'],
      attributes,
      insideMotionGroup: groupMatch !== null && elementMatch.index > groupStart && elementMatch.index < groupEnd,
    });
  }
  return elements;
}

function upstreamNumber(element: UpstreamElement, attributeName: string, fallback?: number): number {
  const rawValue = element.attributes[attributeName];
  if (rawValue === undefined) {
    if (fallback !== undefined) return fallback;
    throw new Error(`<${element.tagName}> has no ${attributeName} attribute in the upstream svg; cannot cross-check it`);
  }
  return Number(rawValue);
}

/** The rect shapes of a generated mark, in order. */
function rectShapes(markName: ActivityMarkName): ActivityRectShape[] {
  return activityMarks[markName].shapes.filter((shape): shape is ActivityRectShape => shape.kind === 'rect');
}

/** The shapes a renderer moves with the mark's motion. */
function movingShapes(markName: ActivityMarkName) {
  return activityMarks[markName].shapes.filter((shape) => shape.moving === true);
}

/** The dashed outline of an animated mark, as the only circle carrying a dash. */
function dashedCircle(markName: ActivityMarkName): ActivityCircleShape {
  const dashed = activityMarks[markName].shapes.filter(
    (shape): shape is ActivityCircleShape => shape.kind === 'circle' && shape.dash !== undefined,
  );
  expect(dashed.length, `${markName} must have exactly one dashed outline`).toBe(1);
  return dashed[0];
}

function parseManifestDash(rawValue: string): number[] {
  return rawValue.trim().split(/\s+/).map(Number);
}

describe('activityMarks', () => {
  it('reads the branding manifest at all', () => {
    // Non-vacuity guard: every cross-check below compares against this object,
    // and all of them would pass trivially against an empty or wrong-shaped one.
    expect(manifest.grid.pathLength).toBe(100);
    expect(Object.keys(manifest.marks).length).toBe(11);
  });

  it('generates exactly the eight marks the app draws, and deliberately not terminal-working or the pause controls', () => {
    expect([...MARK_NAMES].sort()).toEqual(EXPECTED_MARK_NAMES);
    // The omissions are decisions, so they are pinned by name: a package bump
    // or a generator edit that quietly started shipping a blinking terminal
    // would otherwise only show up as extra bytes in the bundle.
    for (const omittedMarkName of ['terminal-working', 'control-pause-idle', 'control-pause-working']) {
      expect(MARK_NAMES, `${omittedMarkName} must stay unsynced`).not.toContain(omittedMarkName);
      // ...while still existing upstream, so "unsynced" is a choice and not a missing file.
      expect(Object.keys(manifest.marks), `${omittedMarkName} exists in the package`).toContain(omittedMarkName);
    }
    // And every one of the eight is a real manifest entry, not a name the
    // generator invented.
    for (const markName of EXPECTED_MARK_NAMES) expect(Object.keys(manifest.marks)).toContain(markName);
  });

  it('carries the manifest grid, not a restated one', () => {
    expect(ACTIVITY_VIEW_BOX).toBe(manifest.grid.viewBox);
    expect(ACTIVITY_STROKE_WIDTH).toBe(manifest.grid.strokeWidth);
    // stroke-linecap/stroke-linejoin have no manifest field, so cross-check
    // both source SVGs agree with each other AND with the generated constant.
    // Dropping either ships butt-capped, mitred strokes on marks drawn for
    // round ones, and nothing about that shows up in a typecheck or a diff.
    const workingMarkStrokeLinecap = svgRootAttribute(workingMarkSvgSource, 'stroke-linecap');
    const workingMarkStrokeLinejoin = svgRootAttribute(workingMarkSvgSource, 'stroke-linejoin');
    expect(workingMarkStrokeLinecap).toBe(svgRootAttribute(idleMarkSvgSource, 'stroke-linecap'));
    expect(workingMarkStrokeLinejoin).toBe(svgRootAttribute(idleMarkSvgSource, 'stroke-linejoin'));
    expect(ACTIVITY_STROKE_LINECAP).toBe(workingMarkStrokeLinecap);
    expect(ACTIVITY_STROKE_LINEJOIN).toBe(workingMarkStrokeLinejoin);
  });

  it('gives every mark drawable shapes and a known rest rendering', () => {
    for (const markName of MARK_NAMES) {
      const mark = activityMarks[markName];
      expect(mark.shapes.length, `${markName} shapes`).toBeGreaterThan(0);
      expect(KNOWN_REST_RENDERINGS.has(mark.restRendering), `${markName} restRendering ${mark.restRendering}`).toBe(true);
      expect(mark.restRendering, `${markName} restRendering`).toBe(manifest.marks[markName].reducedMotion);
      expect(mark.minPx, `${markName} minPx`).toBe(manifest.marks[markName].minPx);
    }
  });

  /**
   * The generator picks which timing field to emit off the manifest's `motion`
   * string, and nothing else re-checks that it picked the right one. Emitting
   * `march` for a mark that declares `spin` would still typecheck, still carry
   * the right duration, and still render a ring - one that walks its dash
   * instead of turning, diverging from the desktop and the website with every
   * gate green. Upstream now ships a third primitive (`blink`) too, so the
   * mapping has more than one way to be wrong.
   */
  it('emits the timing field its declared motion selects, and only that one', () => {
    for (const markName of MARK_NAMES) {
      const mark = activityMarks[markName];
      const declaredMotion = manifest.marks[markName].motion;
      expect(mark.march !== undefined, `${markName} march for motion ${declaredMotion}`).toBe(
        declaredMotion === 'march',
      );
      expect(mark.spin !== undefined, `${markName} spin for motion ${declaredMotion}`).toBe(
        declaredMotion === 'spin',
      );
    }
  });

  it('keeps each mark on its role\'s floor: the control floor for the stop controls, the indicator floor for the rest', () => {
    // Indicators (the agent marks and the terminal silhouettes) hold at 12px;
    // the stop controls are tap targets and hold at 16px. Below its floor
    // AgentStatusIcon draws a dot instead of the mark. The role comes from the
    // manifest's own silhouette, not from the mark's name, so this and the
    // generator derive it from different fields.
    expect(manifest.floors).toEqual({ indicator: 12, control: 16 });
    const controlMarkNames = MARK_NAMES.filter((markName) => manifest.marks[markName].silhouette.startsWith('control-'));
    // Non-vacuity: the filter must actually find both stop controls.
    expect(controlMarkNames.sort()).toEqual(['control-stop-idle', 'control-stop-working']);
    for (const markName of MARK_NAMES) {
      const expectedFloor = controlMarkNames.includes(markName) ? manifest.floors.control : manifest.floors.indicator;
      expect(activityMarks[markName].minPx, `${markName} minPx`).toBe(expectedFloor);
      expect(activityMarks[markName].minPx, `${markName} minPx against its manifest entry`).toBe(manifest.marks[markName].minPx);
    }
  });

  /**
   * The seam between the generator and AgentStatusIcon: a renderer moves exactly
   * the shapes flagged `moving`, and the generator derives the flag from which
   * `<g>` the upstream SVG put a shape in. Compared element by element against
   * the SVG, parsed independently, for every mark, so a mark added later is
   * covered without anyone remembering to extend a list.
   */
  it.each(EXPECTED_MARK_NAMES as ActivityMarkName[])('%s matches its upstream svg element by element', (markName) => {
    const upstream = upstreamElements(markName);
    const generated = activityMarks[markName].shapes;

    // Non-vacuity: a regex that found nothing would compare two empty lists.
    expect(upstream.length, `${markName} upstream elements`).toBeGreaterThan(0);
    expect(generated.map((shape) => shape.kind)).toEqual(upstream.map((element) => element.tagName));

    generated.forEach((shape, shapeIndex) => {
      const element = upstream[shapeIndex];
      const context = `${markName} shape ${shapeIndex} (${shape.kind})`;
      expect(shape.moving === true, `${context} moving`).toBe(element.insideMotionGroup);
      if (shape.kind === 'rect') {
        expect(shape.x, `${context} x`).toBe(upstreamNumber(element, 'x', 0));
        expect(shape.y, `${context} y`).toBe(upstreamNumber(element, 'y', 0));
        expect(shape.width, `${context} width`).toBe(upstreamNumber(element, 'width'));
        expect(shape.height, `${context} height`).toBe(upstreamNumber(element, 'height'));
        expect(shape.rx, `${context} rx`).toBe(upstreamNumber(element, 'rx', 0));
        // Filled is exactly `fill="currentColor" stroke="none"`: the stop square.
        expect(shape.filled === true, `${context} filled`).toBe(element.attributes.fill === 'currentColor' && element.attributes.stroke === 'none');
      } else if (shape.kind === 'circle') {
        expect(shape.cx, `${context} cx`).toBe(upstreamNumber(element, 'cx'));
        expect(shape.cy, `${context} cy`).toBe(upstreamNumber(element, 'cy'));
        expect(shape.r, `${context} r`).toBe(upstreamNumber(element, 'r'));
        expect(shape.dash !== undefined, `${context} dashed`).toBe(element.attributes['stroke-dasharray'] !== undefined);
      } else {
        expect(shape.d, `${context} d`).toBe(element.attributes.d);
      }
    });
  });

  it('flags a shape moving only on an animated mark, and then only its one dashed outline', () => {
    for (const markName of MARK_NAMES) {
      const declaredMotion = manifest.marks[markName].motion;
      const moving = movingShapes(markName);
      if (declaredMotion === null) {
        expect(moving, `${markName} is static, so nothing in it may move`).toEqual([]);
        continue;
      }
      expect(moving.length, `${markName} moves exactly one shape`).toBe(1);
      expect(moving[0].kind).toBe('circle');
      expect(moving[0].kind === 'circle' && moving[0].dash !== undefined, `${markName} moves its dashed outline`).toBe(true);
    }
  });

  it('draws a filled shape on the stop controls only', () => {
    const marksWithFilledShape = MARK_NAMES.filter((markName) =>
      activityMarks[markName].shapes.some((shape) => shape.kind === 'rect' && shape.filled === true),
    );
    expect(marksWithFilledShape.sort()).toEqual(['control-stop-idle', 'control-stop-working']);
  });
});

describe('the terminal silhouettes (terminal-idle, terminal-new)', () => {
  const terminalMarkNames = ['terminal-idle', 'terminal-new'] as const;

  /** An outlined window, then the glyph's two strokes: a prompt and an underscore, or a plus. */
  it.each(terminalMarkNames)('%s is the upstream outline: a rounded window and two stroked paths, verbatim', (markName) => {
    const upstream = upstreamElements(markName);
    const [windowRect] = rectShapes(markName);
    const upstreamRect = upstream.find((element) => element.tagName === 'rect');
    if (upstreamRect === undefined) throw new Error(`${markName} has no <rect> upstream; cannot cross-check it`);

    expect(activityMarks[markName].shapes.map((shape) => shape.kind)).toEqual(['rect', 'path', 'path']);
    expect(windowRect).toMatchObject({
      x: upstreamNumber(upstreamRect, 'x'),
      y: upstreamNumber(upstreamRect, 'y'),
      width: upstreamNumber(upstreamRect, 'width'),
      height: upstreamNumber(upstreamRect, 'height'),
      rx: upstreamNumber(upstreamRect, 'rx'),
    });
    const generatedPaths = activityMarks[markName].shapes.flatMap((shape) => (shape.kind === 'path' ? [shape.d] : []));
    const upstreamPaths = upstream.flatMap((element) => (element.tagName === 'path' ? [element.attributes.d] : []));
    expect(generatedPaths).toEqual(upstreamPaths);
    // The window is an outline: filling it would paint a solid block under the glyph.
    expect(windowRect.filled).toBeUndefined();
  });

  it('draws the window centred on the grid with the same 18 x 18 box in both marks, so they swap without a jump', () => {
    const [, , gridWidth, gridHeight] = ACTIVITY_VIEW_BOX.split(' ').map(Number);
    const [idleWindow] = rectShapes('terminal-idle');
    const [newWindow] = rectShapes('terminal-new');

    expect(newWindow).toEqual(idleWindow);
    expect(idleWindow.x + idleWindow.width / 2).toBe(gridWidth / 2);
    expect(idleWindow.y + idleWindow.height / 2).toBe(gridHeight / 2);
    expect(idleWindow.width).toBe(manifest.grid.inkBox);
    expect(idleWindow.height).toBe(manifest.grid.inkBox);
  });

  /**
   * terminal-working is the one terminal mark with a blink, and the app draws a
   * working terminal with terminal-idle's shapes, static, in the working tone.
   * So neither synced terminal mark may carry any motion at all.
   */
  it.each(terminalMarkNames)('%s is static: no dash, no spin, no march, nothing moving', (markName) => {
    const mark = activityMarks[markName];
    expect(mark.spin).toBeUndefined();
    expect(mark.march).toBeUndefined();
    expect(mark.restRendering).toBe('static');
    expect(manifest.marks[markName].motion).toBeNull();
    expect(movingShapes(markName)).toEqual([]);
    for (const shape of mark.shapes) {
      if (shape.kind === 'circle') expect(shape.dash).toBeUndefined();
    }
  });
});

describe('the stop control (control-stop-idle, control-stop-working)', () => {
  const [, , gridWidth, gridHeight] = ACTIVITY_VIEW_BOX.split(' ').map(Number);

  /** The one circle of a stop mark: its ring. */
  function ringOf(markName: 'control-stop-idle' | 'control-stop-working'): ActivityCircleShape {
    const rings = activityMarks[markName].shapes.filter((shape): shape is ActivityCircleShape => shape.kind === 'circle');
    expect(rings.length, `${markName} must have exactly one ring`).toBe(1);
    return rings[0];
  }

  /** The one rect of a stop mark: its square. */
  function squareOf(markName: 'control-stop-idle' | 'control-stop-working'): ActivityRectShape {
    const squares = rectShapes(markName);
    expect(squares.length, `${markName} must have exactly one square`).toBe(1);
    return squares[0];
  }

  describe('working', () => {
    it('spins at the manifest duration and does not also march', () => {
      const spin = activityMarks['control-stop-working'].spin;
      expect(spin, 'control-stop-working must spin').toBeDefined();
      expect(spin?.durationMs).toBe(manifest.motion.spin.durationMs);
      expect(manifest.marks['control-stop-working'].motion).toBe('spin');
      expect(activityMarks['control-stop-working'].march).toBeUndefined();
      expect(activityMarks['control-stop-working'].restRendering).toBe('keep-dash');
    });

    /**
     * THE assertion that makes the stop control readable: the ring turns and the
     * square holds still. The renderer moves exactly the shapes flagged
     * `moving`, so a square flagged too would spin with its ring, and a ring
     * left unflagged would hold still while the control claims to be working.
     */
    it('moves its ring and only its ring: the filled square holds still', () => {
      const ring = ringOf('control-stop-working');
      const square = squareOf('control-stop-working');

      expect(ring.moving).toBe(true);
      expect(square.moving).toBeUndefined();
      expect(movingShapes('control-stop-working')).toEqual([ring]);
      expect(square.filled).toBe(true);
    });

    it('draws the ring on the grid centre, the premise the spin transform relies on', () => {
      const ring = ringOf('control-stop-working');
      expect(ring.cx).toBe(gridWidth / 2);
      expect(ring.cy).toBe(gridHeight / 2);
    });

    it('takes the user-unit dash and closes the r=10 ring with one cycle', () => {
      const ring = ringOf('control-stop-working');
      const manifestMark = manifest.marks['control-stop-working'];
      expect(ring.r).toBe(10);
      expect(ring.dash, 'the ring must carry the dash').toBeDefined();

      expect([...(ring.dash ?? [])]).toEqual(parseManifestDash(manifestMark.dashUserUnits ?? ''));
      expect([...(ring.dash ?? [])]).not.toEqual(parseManifestDash(manifestMark.dash ?? ''));
      const dashCycle = (ring.dash ?? [0, 0])[0] + (ring.dash ?? [0, 0])[1];
      expect(dashCycle).toBeCloseTo(2 * Math.PI * ring.r, 3);
      // Roughly three quarters inked, so the arc reads as an arc.
      expect((ring.dash ?? [0, 0])[0] / dashCycle).toBeCloseTo(0.75, 2);
    });
  });

  describe('idle', () => {
    it('is static: a solid ring, with no dash and no motion of either kind', () => {
      const mark = activityMarks['control-stop-idle'];
      const ring = ringOf('control-stop-idle');

      expect(ring.dash, 'an idle ring is solid, not torn').toBeUndefined();
      expect(ring.r).toBe(10);
      expect(ring.cx).toBe(gridWidth / 2);
      expect(ring.cy).toBe(gridHeight / 2);
      expect(mark.spin).toBeUndefined();
      expect(mark.march).toBeUndefined();
      expect(mark.restRendering).toBe('static');
      expect(manifest.marks['control-stop-idle'].motion).toBeNull();
      expect(movingShapes('control-stop-idle')).toEqual([]);
    });

    it('draws a filled square, not an outlined one', () => {
      const square = squareOf('control-stop-idle');
      expect(square.filled).toBe(true);
      expect(square.moving).toBeUndefined();
    });
  });

  describe('square', () => {
    it('is the same in both states, so working and idle swap without the square jumping', () => {
      expect(squareOf('control-stop-working')).toEqual(squareOf('control-stop-idle'));
    });

    it('takes its geometry verbatim from the upstream svg and sits centred inside the ring', () => {
      for (const markName of ['control-stop-idle', 'control-stop-working'] as const) {
        const square = squareOf(markName);
        const upstreamRect = upstreamElements(markName).find((element) => element.tagName === 'rect');
        if (upstreamRect === undefined) throw new Error(`${markName} has no <rect> upstream; cannot cross-check it`);

        expect(square.x, `${markName} x`).toBe(upstreamNumber(upstreamRect, 'x'));
        expect(square.y, `${markName} y`).toBe(upstreamNumber(upstreamRect, 'y'));
        expect(square.width, `${markName} width`).toBe(upstreamNumber(upstreamRect, 'width'));
        expect(square.height, `${markName} height`).toBe(upstreamNumber(upstreamRect, 'height'));
        expect(square.rx, `${markName} rx`).toBe(upstreamNumber(upstreamRect, 'rx'));
        // A square, centred on the ring, and strictly inside it (clear of the stroke).
        expect(square.width).toBe(square.height);
        expect(square.x + square.width / 2).toBeCloseTo(gridWidth / 2, 5);
        expect(square.y + square.height / 2).toBeCloseTo(gridHeight / 2, 5);
        expect(square.width / 2 + ACTIVITY_STROKE_WIDTH / 2).toBeLessThan(ringOf(markName).r);
      }
    });
  });
});

/**
 * Every point a path's commands land on, in absolute user units. Enough for the
 * two wait marks, which upstream draws with absolute M, L, H, V, A and Z only
 * (2.12.0's ACTIVITY gate bounds such outlines exactly); a relative command
 * throws rather than being misread.
 */
function pathEndpoints(pathData: string): { x: number; y: number }[] {
  const points: { x: number; y: number }[] = [];
  let currentX = 0;
  let currentY = 0;
  for (const commandMatch of pathData.matchAll(/([A-Za-z])([^A-Za-z]*)/g)) {
    const command = commandMatch[1];
    const values = commandMatch[2].trim().length > 0 ? commandMatch[2].trim().split(/[\s,]+/).map(Number) : [];
    switch (command) {
      case 'M':
      case 'L':
        [currentX, currentY] = values;
        break;
      case 'H':
        [currentX] = values;
        break;
      case 'V':
        [currentY] = values;
        break;
      case 'A':
        currentX = values[5];
        currentY = values[6];
        break;
      case 'Z':
        continue;
      default:
        throw new Error(`pathEndpoints does not read the "${command}" command`);
    }
    points.push({ x: currentX, y: currentY });
  }
  return points;
}

function endpointExtents(pathData: string): { minX: number; maxX: number; minY: number; maxY: number } {
  const points = pathEndpoints(pathData);
  return {
    minX: Math.min(...points.map((point) => point.x)),
    maxX: Math.max(...points.map((point) => point.x)),
    minY: Math.min(...points.map((point) => point.y)),
    maxY: Math.max(...points.map((point) => point.y)),
  };
}

describe('the wait marks (agent-question, agent-approval)', () => {
  const waitMarkNames = ['agent-question', 'agent-approval'] as const;

  /** One stroked path each, verbatim: the bubble and the crested shield. */
  it.each(waitMarkNames)('%s is the upstream outline: one stroked path, verbatim', (markName) => {
    const upstream = upstreamElements(markName);
    expect(upstream.map((element) => element.tagName)).toEqual(['path']);
    expect(activityMarks[markName].shapes).toEqual([{ kind: 'path', d: upstream[0].attributes.d }]);
  });

  it.each(waitMarkNames)('%s is static, in the attention tone, at the indicator floor', (markName) => {
    const mark = activityMarks[markName];
    expect(mark.spin).toBeUndefined();
    expect(mark.march).toBeUndefined();
    expect(mark.restRendering).toBe('static');
    expect(movingShapes(markName)).toEqual([]);
    expect(manifest.marks[markName].motion).toBeNull();
    expect(manifest.marks[markName].tone).toBe('attention');
    expect(mark.minPx).toBe(manifest.floors.indicator);
  });

  /** The one path a wait mark is drawn with. */
  function waitMarkPath(markName: (typeof waitMarkNames)[number]): string {
    const [shape] = activityMarks[markName].shapes;
    if (shape?.kind !== 'path') throw new Error(`${markName} is not drawn as a single path`);
    return shape.d;
  }

  it('draws the bubble inside the 18 slot, centred on the grid', () => {
    const [, , gridWidth, gridHeight] = ACTIVITY_VIEW_BOX.split(' ').map(Number);
    const extents = endpointExtents(waitMarkPath('agent-question'));
    expect(extents.maxX - extents.minX).toBe(manifest.grid.inkBox);
    expect(extents.maxY - extents.minY).toBe(manifest.grid.inkBox);
    expect((extents.minX + extents.maxX) / 2).toBe(gridWidth / 2);
    expect((extents.minY + extents.maxY) / 2).toBe(gridHeight / 2);
  });

  /**
   * The shield is the one indicator taller than the 18 slot, by a unit at the
   * peak and the point (branding 2.12.0, a recorded overshoot). It shares the
   * grid and is drawn at the same size as its siblings, never scaled down to
   * fit, so its ink is 18 x 20 on the same 24-unit viewBox.
   */
  it('draws the shield 18 wide and 20 tall on the same grid, centred', () => {
    const [, , gridWidth, gridHeight] = ACTIVITY_VIEW_BOX.split(' ').map(Number);
    const extents = endpointExtents(waitMarkPath('agent-approval'));
    expect(extents.maxX - extents.minX).toBe(18);
    expect(extents.maxY - extents.minY).toBe(20);
    expect((extents.minX + extents.maxX) / 2).toBe(gridWidth / 2);
    expect((extents.minY + extents.maxY) / 2).toBe(gridHeight / 2);
  });
});

describe('the needs-you envelope (agent-idle)', () => {
  it('is static, with no dash and no motion of either kind', () => {
    const mark = activityMarks['agent-idle'];
    expect(mark.march).toBeUndefined();
    expect(mark.spin).toBeUndefined();
    expect(mark.restRendering).toBe('static');
    for (const shape of mark.shapes) {
      if (shape.kind === 'circle') expect(shape.dash, 'a static mark must carry no dash').toBeUndefined();
    }
  });

  /**
   * The NON-SQUARE box is the 2.6.0 correction (kangentic-branding PR #10): the
   * square 18x18 envelope read as a photo placeholder rather than an envelope on
   * a real task card. An envelope's aspect is its identity, so this is geometry
   * with a reason, not an arbitrary number. 2.6.0 landed it at 18 x 14.4; 2.7.1
   * (PR #16) moved it to 18 x 16, because at devicePixelRatio 1 the body's y
   * edges sat at 4.8 / 19.2, the only axis-aligned edges in the set off the
   * integer lattice, so the body rendered softer than its neighbours in the
   * 14-16px band AgentStatusIcon actually renders at. That is a pixel-lattice
   * fix, not a reversal of the 2.6.0 aspect correction: the aspect stayed
   * non-square throughout, and the flap's diagonal apex is still deliberately
   * fractional (see parseFloatAttribute in scripts/syncBranding.mjs).
   */
  it('keeps the corrected 18 x 16 aspect rather than a square', () => {
    const [envelopeBody] = activityMarks['agent-idle'].shapes.filter(
      (shape): shape is ActivityRectShape => shape.kind === 'rect',
    );
    expect(envelopeBody.width).toBe(18);
    expect(envelopeBody.height).toBe(16);
    expect(envelopeBody.height).not.toBe(envelopeBody.width);
    // Centred in the 24 grid: 3 to 21 across, and vertically centred on 12.
    expect(envelopeBody.x).toBe(3);
    expect(envelopeBody.y + envelopeBody.height / 2).toBeCloseTo(12, 5);
    // The 2.7.1 pixel-hinting fix: both y edges land on the integer lattice.
    expect(Number.isInteger(envelopeBody.y)).toBe(true);
    expect(Number.isInteger(envelopeBody.y + envelopeBody.height)).toBe(true);
  });

  /**
   * The rect is the shape 2.7.1 actually re-hinted, so it is the one most
   * exposed to literal drift: the assertions above pin x/width/height/the
   * integer lattice as hand-typed numbers, the exact pattern this file's own
   * header warns against ("compare the generated output against the source
   * of truth rather than typed literals"). rx in particular is asserted
   * nowhere else; a generator that dropped it ships square corners and
   * every other assertion in this describe block stays green.
   */
  it('takes the rect verbatim from the upstream asset: x, y, width, height and rx', () => {
    const [envelopeBody] = activityMarks['agent-idle'].shapes.filter(
      (shape): shape is ActivityRectShape => shape.kind === 'rect',
    );
    const upstreamRect = svgRectMarkup(idleMarkSvgSource);

    expect(envelopeBody.x).toBe(elementNumberAttribute(upstreamRect, 'x'));
    expect(envelopeBody.y).toBe(elementNumberAttribute(upstreamRect, 'y'));
    expect(envelopeBody.width).toBe(elementNumberAttribute(upstreamRect, 'width'));
    expect(envelopeBody.height).toBe(elementNumberAttribute(upstreamRect, 'height'));
    expect(envelopeBody.rx).toBe(elementNumberAttribute(upstreamRect, 'rx'));
  });

  it('draws the flap as a path over the envelope body', () => {
    const kinds = activityMarks['agent-idle'].shapes.map((shape) => shape.kind);
    expect(kinds).toEqual(['rect', 'path']);
  });

  /**
   * The flap is the one shape whose whole geometry is a string, so a generator
   * that rewrote, rounded or truncated it would still typecheck, still emit a
   * path, and still satisfy the kind check above. It moved in 2.7.1 alongside
   * the body (7.5 to 7) and nothing pinned it, so pin it against the asset the
   * same way the dashes are pinned against the manifest.
   */
  it('takes the flap path verbatim from the upstream asset', () => {
    const upstreamFlap = idleMarkSvgSource.match(/<path\s+d="([^"]+)"/);
    if (upstreamFlap === null) throw new Error('agent-idle.svg has no flap path; cannot cross-check it');

    const flaps = activityMarks['agent-idle'].shapes.filter(
      (shape): shape is ActivityPathShape => shape.kind === 'path',
    );
    expect(flaps.length, 'agent-idle must have exactly one flap path').toBe(1);
    expect(flaps[0].d).toBe(upstreamFlap[1]);
  });

  it('lands the flap ends on the body lattice, meeting its left and right edges', () => {
    const [flap] = activityMarks['agent-idle'].shapes.filter(
      (shape): shape is ActivityPathShape => shape.kind === 'path',
    );
    const [envelopeBody] = activityMarks['agent-idle'].shapes.filter(
      (shape): shape is ActivityRectShape => shape.kind === 'rect',
    );
    const flapPoints = [...flap.d.matchAll(/(-?[\d.]+)\s+(-?[\d.]+)/g)].map(([, xValue, yValue]) => ({
      x: Number(xValue),
      y: Number(yValue),
    }));
    expect(flapPoints.length, 'the flap is a three-point polyline').toBe(3);

    const [flapStart, , flapEnd] = flapPoints;
    // Same pixel-lattice fix as the body: 2.7.1 moved these off 7.5 onto 7.
    expect(Number.isInteger(flapStart.y)).toBe(true);
    expect(flapEnd.y).toBe(flapStart.y);
    // ...and they still span the body, so the flap reads as part of the envelope.
    expect(flapStart.x).toBe(envelopeBody.x);
    expect(flapEnd.x).toBe(envelopeBody.x + envelopeBody.width);
  });
});

describe('the working ring (agent-working)', () => {
  it('spins a transform at the manifest duration', () => {
    const spin = activityMarks['agent-working'].spin;
    expect(spin, 'agent-working must spin').toBeDefined();
    if (spin === undefined) return;
    expect(spin.durationMs).toBe(manifest.motion.spin.durationMs);
    expect(manifest.motion.spin.property).toBe('transform');
    expect(manifest.marks['agent-working'].motion).toBe('spin');
    // Exclusive, not additive: 2.8.0 MOVED the ring off the dash offset. A mark
    // carrying both would mean the generator emitted a motion it did not select
    // and AgentStatusIcon would drive two animations over one outline.
    expect(activityMarks['agent-working'].march, 'a spinning mark must not also march').toBeUndefined();
  });

  /**
   * The ring is the lone shape of a lone-ring mark, and it sits inside the
   * upstream `kng-spin` group, so the generator flags it `moving`. The renderer
   * turns exactly the flagged shapes (the stop control relies on this to hold
   * its square still), so an unflagged ring would be a working mark that does
   * not turn.
   */
  it('flags its one ring as the moving shape', () => {
    const shapes = activityMarks['agent-working'].shapes;
    expect(shapes).toHaveLength(1);
    expect(shapes[0].kind).toBe('circle');
    expect(shapes[0].moving).toBe(true);
    expect(movingShapes('agent-working')).toEqual(shapes);
  });

  /**
   * Why the swap is a no-op to look at. `stroke-dashoffset` is a paint property
   * the desktop's Chromium cannot composite, so its indicators froze whenever
   * the renderer's main thread blocked; a transform composites. The durations
   * are asserted EQUAL rather than as the literal 1400 because that equality is
   * the point of the upstream change: marks on different primitives have to
   * stay in lockstep, and spin moved 1200 -> 1400 to get there.
   */
  it('shares one period with the march, so mixed primitives stay in lockstep', () => {
    expect(manifest.motion.spin.durationMs).toBe(manifest.motion.march.durationMs);
    expect(manifest.motion.spin.timing).toBe(manifest.motion.march.timing);
    // Different primitives, though - that is the whole change.
    expect(manifest.motion.spin.property).not.toBe(manifest.motion.march.property);
  });

  /**
   * THE assertion in this file. The generated dash must be the user-unit pair,
   * and must NOT be the pathLength ratio the SVG itself carries.
   */
  it('takes the user-unit dash, not the pathLength ratio', () => {
    const { dash } = dashedCircle('agent-working');
    const manifestMark = manifest.marks['agent-working'];
    expect(manifestMark.dashUserUnits, 'the manifest must ship a user-unit dash').toBeDefined();
    expect(manifestMark.dash, 'the manifest must ship a ratio dash too').toBeDefined();

    expect([...(dash ?? [])]).toEqual(parseManifestDash(manifestMark.dashUserUnits ?? ''));
    expect([...(dash ?? [])]).not.toEqual(parseManifestDash(manifestMark.dash ?? ''));
  });

  /**
   * A dash cycle that does not close the outline is exactly what the ratio form
   * looks like once pathLength is ignored, so this measures the geometry rather
   * than trusting the field name.
   */
  it('closes the ring: one dash cycle equals its circumference', () => {
    const circle = dashedCircle('agent-working');
    const dashCycle = (circle.dash ?? [0, 0])[0] + (circle.dash ?? [0, 0])[1];
    const circumference = 2 * Math.PI * circle.r;

    // The spin carries no periodUserUnits to cross-check - it travels 360
    // degrees, not an arc length - so the generated dash IS the check now.
    // Keep it: the generator runs the same closure guard, and a spinning mark
    // that shipped the ratio form would render as a solid ring turning
    // invisibly, which looks like nothing being wrong at all.
    expect(dashCycle).toBeCloseTo(circumference, 3);
    // And the ratio form provably would NOT have: it overshoots by ~43 units,
    // covering the whole ring, which is how the motion vanishes.
    const ratioCycle = parseManifestDash(manifest.marks['agent-working'].dash ?? '').reduce((sum, part) => sum + part, 0);
    expect(ratioCycle).toBeGreaterThan(circumference * 1.5);
  });

  it('leaves roughly three quarters of the ring inked, so the arc reads as an arc', () => {
    const circle = dashedCircle('agent-working');
    const [inked, gap] = circle.dash ?? [0, 0];
    expect(inked / (inked + gap)).toBeCloseTo(0.75, 2);
    expect(gap).toBeGreaterThan(0);
  });

  it('rests holding its arc under reduced motion rather than closing to a solid ring', () => {
    // 'keep-dash', not 'drop-dash': the spinner keeps its 3/4 arc at rest. A
    // solid ring is what this component used to render, and it read as a
    // different state rather than as a paused one.
    expect(activityMarks['agent-working'].restRendering).toBe('keep-dash');
  });

  /**
   * A PREMISE PIN, and since 2026-08-29 a load-bearing one.
   *
   * AgentStatusIcon no longer rotates an <G> about a per-mark origin. The spin
   * is a transform on the wrapping native view, which pivots about the VIEW's
   * centre - that is, the viewBox centre - because driving an SVG `matrix` prop
   * per frame cost roughly 8 percentage points of CPU per icon (see the
   * REACT-NATIVE-5 section of docs/developer-guide.md). Rotating the whole
   * <Svg> is exact only while every spinning mark is drawn at the grid centre,
   * which is also upstream's own rule (activity.css's
   * `.kng-spin { transform-origin: 12px 12px }`).
   *
   * So this is the assertion that stops an off-centre spinning mark from
   * shipping a visibly wobbling ring. It is checked for EVERY mark carrying a
   * spin rather than for agent-working alone, because the cost of the check is
   * nil and a new mark is exactly the change that would break the premise.
   *
   * It still cannot prove the component WIRES the transform correctly - a
   * rotation of 0 turns is the identity for any origin, and the Reanimated mock
   * renders at 0. That half is only observable on a real device.
   */
  it('draws every spinning mark on the grid centre, the premise the view transform relies on', () => {
    const [, , gridWidth, gridHeight] = ACTIVITY_VIEW_BOX.split(' ').map(Number);
    const spinningMarkNames = (Object.keys(activityMarks) as ActivityMarkName[]).filter(
      (markName) => activityMarks[markName].spin !== undefined,
    );

    // Guards the guard: a filter that silently matched nothing would pass this
    // test forever while asserting about no marks at all.
    expect(spinningMarkNames).toContain('agent-working');

    for (const markName of spinningMarkNames) {
      const circle = dashedCircle(markName);
      expect({ mark: markName, cx: circle.cx, cy: circle.cy }).toEqual({
        mark: markName,
        cx: gridWidth / 2,
        cy: gridHeight / 2,
      });
    }
  });
});
