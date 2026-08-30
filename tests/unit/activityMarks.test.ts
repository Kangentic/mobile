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
  dash?: string;
  dashUserUnits?: string;
  reducedMotion: string;
  minPx: number;
  motion: string | null;
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
    expect(Object.keys(manifest.marks).length).toBe(9);
  });

  it('generates the two marks AgentStatusIcon renders', () => {
    expect(MARK_NAMES.sort()).toEqual(['agent-idle', 'agent-working']);
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

  it('keeps the indicator floor at the manifest value', () => {
    // Both agent marks are indicators (12px), not controls (16px). Below the
    // floor AgentStatusIcon draws a dot instead of the mark.
    for (const markName of MARK_NAMES) {
      expect(activityMarks[markName].minPx, `${markName} minPx`).toBe(manifest.floors.indicator);
    }
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
