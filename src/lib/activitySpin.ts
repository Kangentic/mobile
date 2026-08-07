/**
 * The rotation an @kangentic/branding `spin` mark turns through, as an SVG
 * transform matrix.
 *
 * This exists as a matrix rather than as a `rotation` prop because of what
 * react-native-svg actually accepts on the New Architecture. Its Fabric group
 * component declares exactly one transform prop - `matrix?: ReadonlyArray<Float>`
 * (see GroupNativeComponent.d.ts) - and `rotation`/`originX`/`originY` are
 * JS-side conveniences that extractProps folds into that matrix AT RENDER TIME.
 * Reanimated writes animated props straight to the shadow node, which knows
 * only `matrix`, so animating `rotation` would set a prop nothing reads and the
 * ring would sit still. The already-proven march works for the same reason in
 * reverse: `strokeDashoffset` IS a native prop on the circle.
 *
 * The origin is passed in USER UNITS because there is no CSS here: unlike the
 * web, react-native-svg has no `transform-origin` and ignores `pathLength`, so
 * a percentage would have nothing to resolve against.
 */

/**
 * A rotation of `turns` full turns about (centerX, centerY), as SVG's
 * `matrix(a, b, c, d, e, f)`.
 *
 * Positive turns rotate CLOCKWISE on screen, because SVG's y axis points down.
 * That direction is not a preference: it matches the march this replaced, whose
 * stroke-dashoffset travels to -periodUserUnits and so walks the ink forward
 * along the circle's own clockwise path. A sign flip here would still look like
 * a working spinner while turning the opposite way to the desktop and the
 * website, which is exactly the drift the shared package exists to prevent.
 */
export function spinMatrixAboutPoint(
  turns: number,
  centerX: number,
  centerY: number,
): readonly [number, number, number, number, number, number] {
  'worklet';
  const radians = turns * 2 * Math.PI;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  // translate(center) . rotate(radians) . translate(-center), expanded.
  return [
    cosine,
    sine,
    -sine,
    cosine,
    centerX - centerX * cosine + centerY * sine,
    centerY - centerX * sine - centerY * cosine,
  ];
}
