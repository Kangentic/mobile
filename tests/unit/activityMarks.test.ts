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
  ACTIVITY_STROKE_WIDTH,
  ACTIVITY_VIEW_BOX,
  activityMarks,
  type ActivityCircleShape,
  type ActivityMarkName,
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

const MARK_NAMES = Object.keys(activityMarks) as ActivityMarkName[];
const KNOWN_REST_RENDERINGS = new Set(['static', 'keep-dash', 'drop-dash']);

/** The dashed outline of a marching mark, as the only circle carrying a dash. */
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

  it('keeps the indicator floor at the manifest value', () => {
    // Both agent marks are indicators (12px), not controls (16px). Below the
    // floor AgentStatusIcon draws a dot instead of the mark.
    for (const markName of MARK_NAMES) {
      expect(activityMarks[markName].minPx, `${markName} minPx`).toBe(manifest.floors.indicator);
    }
  });
});

describe('the needs-you envelope (agent-idle)', () => {
  it('is static, with no dash and no march', () => {
    const mark = activityMarks['agent-idle'];
    expect(mark.march).toBeUndefined();
    expect(mark.restRendering).toBe('static');
    for (const shape of mark.shapes) {
      if (shape.kind === 'circle') expect(shape.dash, 'a static mark must carry no dash').toBeUndefined();
    }
  });

  /**
   * The 18 x 14.4 box is the 2.6.0 correction (kangentic-branding PR #10): the
   * square 18x18 envelope read as a photo placeholder rather than an envelope on
   * a real task card. An envelope's aspect is its identity, so this is geometry
   * with a reason, not an arbitrary number.
   */
  it('keeps the corrected 18 x 14.4 aspect rather than a square', () => {
    const [envelopeBody] = activityMarks['agent-idle'].shapes.filter(
      (shape): shape is ActivityRectShape => shape.kind === 'rect',
    );
    expect(envelopeBody.width).toBe(18);
    expect(envelopeBody.height).toBe(14.4);
    expect(envelopeBody.height).not.toBe(envelopeBody.width);
    // Centred in the 24 grid: 3 to 21 across, and vertically centred on 12.
    expect(envelopeBody.x).toBe(3);
    expect(envelopeBody.y + envelopeBody.height / 2).toBeCloseTo(12, 5);
  });

  it('draws the flap as a path over the envelope body', () => {
    const kinds = activityMarks['agent-idle'].shapes.map((shape) => shape.kind);
    expect(kinds).toEqual(['rect', 'path']);
  });
});

describe('the working ring (agent-working)', () => {
  it('marches on a stroke-dashoffset at the manifest duration', () => {
    const march = activityMarks['agent-working'].march;
    expect(march, 'agent-working must march').toBeDefined();
    if (march === undefined) return;
    expect(march.durationMs).toBe(manifest.motion.march.durationMs);
    expect(manifest.motion.march.property).toBe('stroke-dashoffset');
    expect(manifest.marks['agent-working'].motion).toBe('march');
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
    const march = activityMarks['agent-working'].march;
    const dashCycle = (circle.dash ?? [0, 0])[0] + (circle.dash ?? [0, 0])[1];
    const circumference = 2 * Math.PI * circle.r;

    expect(dashCycle).toBeCloseTo(circumference, 3);
    expect(march?.periodUserUnits).toBeCloseTo(circumference, 3);
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
});
