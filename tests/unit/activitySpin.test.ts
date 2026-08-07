/**
 * The rotation matrix behind an @kangentic/branding `spin` mark.
 *
 * This is pinned here, as pure math, because the failure it guards is invisible
 * everywhere else. A sign flip in the matrix still renders a smoothly turning
 * ring - it just turns the OPPOSITE WAY to the desktop and the website, and no
 * typecheck, snapshot or component test can tell the two apart. The component
 * tier can only prove that a matrix prop was handed to the group; whether that
 * matrix is the right rotation is this file's job.
 *
 * The assertions work on points rather than on matrix components, because
 * "(cx + r, cy) lands on (cx, cy + r)" is a claim about what the user sees and
 * a restated `[cosine, sine, -sine, cosine, ...]` would pass against a matrix
 * derived the same wrong way.
 */
import { describe, expect, it } from 'vitest';
import { spinMatrixAboutPoint } from '@/lib/activitySpin';

/** SVG's matrix(a, b, c, d, e, f) applied to a point: the renderer's own math. */
function applyMatrix(
  matrix: readonly [number, number, number, number, number, number],
  x: number,
  y: number,
): { x: number; y: number } {
  const [a, b, c, d, e, f] = matrix;
  return { x: a * x + c * y + e, y: b * x + d * y + f };
}

// The agent ring's own geometry, so the cases below are the real thing rather
// than a convenient unit circle: cx/cy 12 on the 24 grid, r 9.
const CENTER_X = 12;
const CENTER_Y = 12;
const RADIUS = 9;

describe('spinMatrixAboutPoint', () => {
  it('is the identity at rest, so a mark that is not spinning is not displaced', () => {
    // Asserted by moving points rather than by comparing the six components:
    // `-sine` is a signed negative zero at 0 turns, which is identical to draw
    // and unequal to 0 under a deep compare.
    const restMatrix = spinMatrixAboutPoint(0, CENTER_X, CENTER_Y);
    for (const [x, y] of [
      [CENTER_X + RADIUS, CENTER_Y],
      [CENTER_X, CENTER_Y - RADIUS],
      [0, 0],
      [24, 24],
    ]) {
      const moved = applyMatrix(restMatrix, x, y);
      expect(moved.x, `x of (${x}, ${y})`).toBeCloseTo(x, 10);
      expect(moved.y, `y of (${x}, ${y})`).toBeCloseTo(y, 10);
    }
  });

  it('closes the loop: one full turn lands back where it started', () => {
    // The component repeats a 0 -> 1 timing forever without reversing, so the
    // end of a pass must be indistinguishable from its start or the ring
    // visibly jumps once per period.
    const start = applyMatrix(spinMatrixAboutPoint(0, CENTER_X, CENTER_Y), CENTER_X + RADIUS, CENTER_Y);
    const end = applyMatrix(spinMatrixAboutPoint(1, CENTER_X, CENTER_Y), CENTER_X + RADIUS, CENTER_Y);

    expect(end.x).toBeCloseTo(start.x, 10);
    expect(end.y).toBeCloseTo(start.y, 10);
  });

  /**
   * THE assertion in this file. SVG's y axis points down, so a clockwise turn
   * takes 3 o'clock to 6 o'clock. That is the direction the march travelled
   * (stroke-dashoffset to -periodUserUnits walks the ink forward along the
   * circle's own clockwise path), and matching it is what makes this change the
   * visually identical swap upstream measured it to be.
   */
  it('turns clockwise: a quarter turn takes 3 o clock to 6 o clock', () => {
    const threeOClock = applyMatrix(
      spinMatrixAboutPoint(0.25, CENTER_X, CENTER_Y),
      CENTER_X + RADIUS,
      CENTER_Y,
    );

    expect(threeOClock.x).toBeCloseTo(CENTER_X, 10);
    expect(threeOClock.y).toBeCloseTo(CENTER_Y + RADIUS, 10);
    // Stated as the negative too, because a counter-clockwise matrix would put
    // the point at 12 o'clock and every other assertion here would still pass.
    expect(threeOClock.y).not.toBeCloseTo(CENTER_Y - RADIUS, 5);
  });

  it('keeps turning the same way through the second quarter', () => {
    const halfTurn = applyMatrix(spinMatrixAboutPoint(0.5, CENTER_X, CENTER_Y), CENTER_X + RADIUS, CENTER_Y);

    expect(halfTurn.x).toBeCloseTo(CENTER_X - RADIUS, 10);
    expect(halfTurn.y).toBeCloseTo(CENTER_Y, 10);
  });

  it('holds the centre fixed, so the ring turns rather than orbits', () => {
    // A rotation about the wrong origin still animates; it drags the mark
    // around the grid instead of spinning it in place.
    for (const turns of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const moved = applyMatrix(spinMatrixAboutPoint(turns, CENTER_X, CENTER_Y), CENTER_X, CENTER_Y);
      expect(moved.x, `centre at ${turns} turns`).toBeCloseTo(CENTER_X, 10);
      expect(moved.y, `centre at ${turns} turns`).toBeCloseTo(CENTER_Y, 10);
    }
  });

  it('preserves the radius, so the outline never scales or skews', () => {
    for (const turns of [0.05, 0.3, 0.6, 0.95]) {
      const moved = applyMatrix(spinMatrixAboutPoint(turns, CENTER_X, CENTER_Y), CENTER_X + RADIUS, CENTER_Y);
      const distance = Math.hypot(moved.x - CENTER_X, moved.y - CENTER_Y);
      expect(distance, `radius at ${turns} turns`).toBeCloseTo(RADIUS, 10);
    }
  });

  it('rotates about the point it is given, not about the grid origin', () => {
    // The component derives the origin from the dashed circle's own cx/cy
    // rather than from the viewBox centre, so an off-centre mark must still
    // spin in place. Pin that the parameter is actually honoured.
    const offCenterX = 5;
    const offCenterY = 7;
    const moved = applyMatrix(spinMatrixAboutPoint(0.25, offCenterX, offCenterY), offCenterX + RADIUS, offCenterY);

    expect(moved.x).toBeCloseTo(offCenterX, 10);
    expect(moved.y).toBeCloseTo(offCenterY + RADIUS, 10);
  });
});
