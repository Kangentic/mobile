import type { Theme } from './theme/tokens';

/**
 * The sheet never grows past this fraction of the screen. Exported so a
 * sheet with its own internally-scrolling element (e.g. CreateTaskSheet's
 * description field) can size that element to fill the same budget, rather
 * than hardcoding a second, possibly-drifting copy of this number.
 *
 * Kept in this RN-free module (not Sheet.tsx) alongside
 * computeSheetDescriptionBounds so both can be unit-tested with vitest
 * without pulling in react-native (see tests/unit/sheetLayout.test.ts).
 */
export const SHEET_MAX_HEIGHT_FRACTION = 0.75;

export interface SheetDescriptionBoundsParams {
  theme: Theme;
  windowHeight: number;
  bottomInset: number;
  /** Whether this sheet has a column-chips row between the description and
   * its action button (CreateTaskSheet does, EditTaskSheet does not). */
  hasColumnChipsRow: boolean;
}

/**
 * The min/max height for a sheet's multiline description field: it fills
 * whatever this sheet's SHEET_MAX_HEIGHT_FRACTION budget leaves after the
 * OTHER fixed rows (the sheet's own title, the title field, an optional
 * column-chips row, the action button, and the sheet's own paddings) - not
 * a small fixed cap, which left a large dead gap above a short sheet
 * instead of giving a long description more visible room to read. A small
 * safety buffer absorbs the rest: this is an estimate of Sheet's actual
 * layout, not a measurement of it, and undershooting cuts off the action
 * button, which is worse than a slightly-shorter description.
 */
export function computeSheetDescriptionBounds({
  theme,
  windowHeight,
  bottomInset,
  hasColumnChipsRow,
}: SheetDescriptionBoundsParams): { descriptionMinHeight: number; descriptionMaxHeight: number } {
  const chromeEstimateSafetyBuffer = theme.spacing.md;
  const reservedChromeHeight =
    theme.spacing.lg + // Sheet's own paddingTop
    theme.typography.title.lineHeight +
    theme.spacing.md + // Sheet's own title + its marginBottom
    theme.minTouchSize + // title field
    theme.spacing.sm + // title field + gap
    theme.spacing.sm + // gap from description to the next row
    (hasColumnChipsRow ? theme.minTouchSize + theme.spacing.sm : 0) + // column chips row + gap
    theme.minTouchSize + // the sheet's action button (Create / Save)
    theme.spacing.lg + // Sheet's own paddingBottom
    bottomInset + // Sheet's paddingBottom also adds the real safe-area inset
    chromeEstimateSafetyBuffer;
  const descriptionMinHeight = theme.typography.body.lineHeight * 3 + theme.spacing.sm * 2;
  const descriptionMaxHeight = Math.max(
    windowHeight * SHEET_MAX_HEIGHT_FRACTION - reservedChromeHeight,
    descriptionMinHeight,
  );
  return { descriptionMinHeight, descriptionMaxHeight };
}
