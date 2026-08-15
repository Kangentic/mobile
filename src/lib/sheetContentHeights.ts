/**
 * Height caps for the scrollable region inside a 'fitToContents' form sheet.
 *
 * Every form sheet caps its tallest child (a column list or a multiline
 * description box) so the sheet never grows past what the window can show.
 * A fixed 420 cap shipped first and failed on small phones: with the keyboard
 * up, an 852pt window minus a 340pt keyboard cannot host 420pt of description
 * plus the sheet's chrome, so the confirm button landed behind the keyboard
 * (seen in the 2026-08-15 iOS tester recording). The cap therefore derives
 * from the window height, reserving the space the rest of the sheet and the
 * keyboard will consume, and 420 becomes the ceiling that tall windows still
 * get.
 *
 * Pure math on purpose: no react-native imports, so vitest can execute the
 * derivations (tests/unit/sheetContentHeights.test.ts). Screens feed in
 * useWindowDimensions().height and their own reserved-height sums.
 */

/**
 * The historical fixed cap, now the ceiling. Tall phones and tablets render
 * exactly as they did before the cap became adaptive.
 */
export const SHEET_CONTENT_CEILING = 420;

/**
 * Worst-case portrait iOS keyboard including the QuickType bar on an 852pt
 * window. Android keyboards are shorter, so a cap that clears this clears
 * both platforms. Screens add this to their reserved height only when the
 * sheet can actually summon a keyboard.
 */
export const SHEET_KEYBOARD_ALLOWANCE = 340;

export interface ClampSheetContentHeightOptions {
  /** useWindowDimensions().height at the call site. */
  windowHeight: number;
  /**
   * Everything the sheet needs outside the capped region: container padding,
   * title, gaps, fields, button, error-line allowance, safe-area bottom
   * inset, top clearance the sheet can never occupy, and the keyboard
   * allowance where a keyboard can appear. Each screen documents its sum
   * next to the layout it describes.
   */
  reservedHeight: number;
  /** The smallest useful capped region; wins over the window running out. */
  floorHeight: number;
  ceilingHeight?: number;
}

export function clampSheetContentHeight({
  windowHeight,
  reservedHeight,
  floorHeight,
  ceilingHeight = SHEET_CONTENT_CEILING,
}: ClampSheetContentHeightOptions): number {
  const availableHeight = windowHeight - reservedHeight;
  return Math.min(ceilingHeight, Math.max(floorHeight, availableHeight));
}

export interface AlignHeightToTextLineGridOptions {
  height: number;
  /** The field's text line height (theme.typography.body.lineHeight). */
  lineHeight: number;
  /** The field's summed top + bottom padding (2 * theme.spacing.sm). */
  verticalPadding: number;
}

/**
 * Rounds a text-box cap down to a whole number of text lines plus padding,
 * so a box that overflows clips at a line boundary instead of mid-line
 * (a half-visible line reads as broken occlusion; the tester recording's
 * "Edit clip"). Never returns less than one full line. The TextField's
 * hairline border shifts the grid by under a point, which is invisible and
 * deliberately ignored.
 *
 * List caps stay unaligned on purpose: a half-visible row is a scroll
 * affordance, not an artifact.
 */
export function alignHeightToTextLineGrid({
  height,
  lineHeight,
  verticalPadding,
}: AlignHeightToTextLineGridOptions): number {
  const wholeLineCount = Math.max(1, Math.floor((height - verticalPadding) / lineHeight));
  return wholeLineCount * lineHeight + verticalPadding;
}
