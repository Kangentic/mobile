/**
 * Covers the custom iOS Board tab icon: the committed PNGs, and the lucide
 * geometry they are generated from.
 *
 * Two failure modes worth mechanising, both silent:
 *
 *   A MISSING OR MIS-SIZED PNG. The asset is committed rather than built in CI,
 *   deliberately (see scripts/buildTabIcons.mjs), which means nothing at build
 *   time would notice it being deleted, truncated, or regenerated at the wrong
 *   size. Metro resolves @2x/@3x from a single require, so a missing @3x does
 *   not error - it silently serves a 25px image to a 3x screen and the tab icon
 *   goes soft. On a store screenshot that reads as a low-quality app.
 *
 *   DRIFT FROM LUCIDE. The path data is COPIED into the build script rather
 *   than imported, because the lucide module exports a React component and
 *   importing it would pull React Native into a build script. A copy cannot
 *   follow a lucide upgrade, so this asserts the copy still matches the
 *   installed package. Without it the tab icon would quietly diverge from the
 *   board's own column chips, which is exactly the consistency this icon exists
 *   to buy.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { readPngSize } from '../../scripts/storeScreenshots.mjs';
import { ICON_NAME, LUCIDE_SQUARE_KANBAN, POINT_SIZE, SCALES, outputPath } from '../../scripts/buildTabIcons.mjs';

const lucideSource = readFileSync(
  fileURLToPath(new URL('../../node_modules/lucide-react-native/dist/esm/icons/square-kanban.mjs', import.meta.url)),
  'utf8',
);

describe('the committed Board tab icon PNGs', () => {
  it('generates one asset per Metro scale', () => {
    // Non-vacuity guard: the per-scale assertions below iterate this list, so an
    // empty or truncated SCALES would pass while checking nothing.
    expect(SCALES).toEqual([1, 2, 3]);
  });

  it.each([1, 2, 3])('exists at %sx and is exactly the right pixel size', (scale) => {
    const path = outputPath(ICON_NAME, scale);
    expect(existsSync(path), `${path} is missing. Run: node scripts/buildTabIcons.mjs`).toBe(true);

    const expectedPixels = POINT_SIZE * scale;
    expect(readPngSize(readFileSync(path))).toEqual({ width: expectedPixels, height: expectedPixels });
  });

  it('names the 1x asset without a suffix, so Metro can resolve the family', () => {
    // `require('./board-kanban.png')` is what the layout asks for. Metro finds
    // the @2x/@3x siblings from that name, so the unsuffixed file is the entry
    // point and renaming it breaks all three.
    expect(outputPath(ICON_NAME, 1).endsWith('board-kanban.png')).toBe(true);
    expect(outputPath(ICON_NAME, 2).endsWith('board-kanban@2x.png')).toBe(true);
    expect(outputPath(ICON_NAME, 3).endsWith('board-kanban@3x.png')).toBe(true);
  });
});

describe('the copied lucide geometry', () => {
  it('reads the installed lucide icon at all', () => {
    // Non-vacuity guard: every comparison below is a substring check against
    // this source, and all of them pass trivially if the file were empty or the
    // path silently wrong.
    expect(lucideSource).toContain('SquareKanban');
    expect(lucideSource.length).toBeGreaterThan(100);
  });

  it.each(LUCIDE_SQUARE_KANBAN.bars.map((bar) => bar.d))('still matches lucide on the %s lane', (pathData) => {
    expect(
      lucideSource.includes(`"${pathData}"`),
      `lucide no longer draws "${pathData}". The tab icon has drifted from the icon set the rest of the app uses - ` +
        're-copy the path data from square-kanban.mjs and re-run scripts/buildTabIcons.mjs.',
    ).toBe(true);
  });

  it('still matches lucide on the surrounding rect', () => {
    const { rect } = LUCIDE_SQUARE_KANBAN;
    for (const [attribute, value] of Object.entries(rect)) {
      expect(
        lucideSource.includes(`${attribute}: "${value}"`),
        `lucide's rect no longer has ${attribute}="${value}".`,
      ).toBe(true);
    }
  });

  it('keeps the stroke width lucide draws at', () => {
    // 2 is lucide's own stroke width on a 24 viewBox. It was reviewed at this
    // weight against the sparkles glyph on the Agents tab and chosen
    // deliberately, so a change here is a design decision, not a tidy-up.
    expect(LUCIDE_SQUARE_KANBAN.strokeWidth).toBe(2);
    expect(LUCIDE_SQUARE_KANBAN.viewBox).toBe(24);
  });
});
