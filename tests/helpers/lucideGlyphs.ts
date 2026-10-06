import type { LucideIcon } from 'lucide-react-native';
import type { TestInstance } from 'test-renderer';

/**
 * Every host SVG a lucide glyph draws inside `root`. RNTL 14 has no
 * composite-type query (UNSAFE_getByType is gone) and every lucide icon renders
 * the same react-native-svg host shape, so "an SVG is there" could not tell one
 * glyph from another. What does is the class lucide stamps on each icon's root,
 * `lucide-<kebab-case icon name>`, which is the icon's own identity just as the
 * old by-type query used it. Matched as a whole class token, so
 * `lucide-git-pull-request` never matches `lucide-git-pull-request-closed`.
 * Lucide hands its `color` prop to that host root as `stroke`.
 *
 * The kebab-casing splits only before an uppercase letter, which is right for
 * every glyph the suites use today. A name with a letter-to-digit boundary
 * (lucide's `Layers2` is `lucide-layers-2`) would need that boundary split too;
 * a miss shows up as "found 0", never as a false pass.
 */
export function lucideGlyphs(root: TestInstance, glyph: LucideIcon): TestInstance[] {
  const iconName = glyph.displayName;
  if (iconName === undefined) throw new Error('A lucide icon always carries a displayName.');
  const glyphClass = `lucide-${iconName.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()}`;
  return root.queryAll(
    (node) => typeof node.props.className === 'string' && node.props.className.split(' ').includes(glyphClass),
  );
}

/** The one glyph of this type under `root`; like the by-type query it replaces, none or several is an error. */
export function getLucideGlyph(root: TestInstance, glyph: LucideIcon): TestInstance {
  const glyphs = lucideGlyphs(root, glyph);
  if (glyphs.length !== 1) {
    throw new Error(`expected exactly one ${glyph.displayName} glyph, found ${glyphs.length}`);
  }
  return glyphs[0];
}
