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
 * useWindowDimensions().height and the per-sheet budgets below.
 */

/**
 * The historical fixed cap, now the ceiling. Tall phones and tablets render
 * the list sheets exactly as they did before the cap became adaptive; the
 * description boxes align the ceiling to the text line grid, so their
 * effective ceiling is 416 (pinned in the unit test).
 */
export const SHEET_CONTENT_CEILING = 420;

/**
 * Worst-case portrait iOS keyboard including the QuickType bar on an 852pt
 * window. Android keyboards are shorter, so a cap that clears this clears
 * both platforms. Screens add this to their reserved height only when the
 * sheet can actually summon a keyboard.
 */
export const SHEET_KEYBOARD_ALLOWANCE = 340;

/**
 * Per-sheet reserved-height budgets.
 *
 * These live here rather than in the screens they describe so that vitest
 * can import the real constants (this module is pure; the screens are not
 * importable without a react-native runtime) and a budget change breaks the
 * pinned derivations in tests/unit/sheetContentHeights.test.ts instead of
 * silently drifting past them. Each budget is composed from the named line
 * items below, so the arithmetic is executable rather than prose. The layout
 * a budget describes lives in its screen (src/screens/*.tsx), which imports
 * its budget from here; the safe-area bottom inset is a device value and is
 * added at each call site.
 *
 * The line items mirror rendered heights the type system cannot see:
 * theme.typography.title.lineHeight (24), the single-line TextField and
 * Button heights (44, matching theme.minTouchSize), Stack gap="sm" (8), and
 * the sheets' container padding (spacing.lg 16 top + spacing.xl 24 bottom).
 */

/** Status bar plus sheet top margin: window the sheet can never occupy. */
const SHEET_TOP_CLEARANCE = 70;
/** The sheets' container padding: spacing.lg (16) top + spacing.xl (24) bottom. */
const SHEET_CONTAINER_PADDING = 40;
/** The sheet title's line: theme.typography.title.lineHeight. */
const SHEET_TITLE_LINE = 24;
/** A single-line TextField, matching theme.minTouchSize. */
const SHEET_TEXT_FIELD = 44;
/** The confirm Button, matching theme.minTouchSize. */
const SHEET_BUTTON = 44;
/**
 * Two caption lines (16 each) for the error Text: error strings carry
 * server messages verbatim with no numberOfLines clamp, so budgeting a
 * single line would let a wrapped error push the confirm button behind the
 * keyboard again, which is the bug this module exists to prevent.
 */
const SHEET_ERROR_ALLOWANCE = 32;
/** One Stack gap="sm" between sheet children. */
const SHEET_STACK_GAP = 8;

/**
 * CreateTaskScreen, around the description box: title, title field, the
 * 46-high column-chips row (minTouchSize chips plus their 1px borders),
 * error allowance, button, and the five gaps of its six-child Stack. The
 * keyboard allowance is added at the call site: the sheet exists to type
 * into.
 */
export const CREATE_SHEET_RESERVED_HEIGHT =
  SHEET_TOP_CLEARANCE +
  SHEET_CONTAINER_PADDING +
  SHEET_TITLE_LINE +
  SHEET_TEXT_FIELD +
  46 +
  SHEET_ERROR_ALLOWANCE +
  SHEET_BUTTON +
  5 * SHEET_STACK_GAP;

/**
 * EditTaskScreen, around the description box: title, title field, error
 * allowance, button, and the four gaps of its five-child Stack. The keyboard
 * allowance is added at the call site: the sheet exists to type into.
 */
export const EDIT_SHEET_RESERVED_HEIGHT =
  SHEET_TOP_CLEARANCE +
  SHEET_CONTAINER_PADDING +
  SHEET_TITLE_LINE +
  SHEET_TEXT_FIELD +
  SHEET_ERROR_ALLOWANCE +
  SHEET_BUTTON +
  4 * SHEET_STACK_GAP;

/**
 * MoveTaskScreen, around the column list: title, the task title clamped to
 * two body lines (2 x 20), error allowance, button plus the spacing.xs (4)
 * marginTop on its wrapper, and the four gaps of its five-child Stack. No
 * keyboard allowance: the sheet has no text input.
 */
export const MOVE_SHEET_RESERVED_HEIGHT =
  SHEET_TOP_CLEARANCE +
  SHEET_CONTAINER_PADDING +
  SHEET_TITLE_LINE +
  40 +
  SHEET_ERROR_ALLOWANCE +
  SHEET_BUTTON +
  4 +
  4 * SHEET_STACK_GAP;

/**
 * ProjectPickerScreen, around the project list: title and the one gap of
 * its two-child Stack. No error line: picking a project cannot fail locally.
 */
export const PICKER_SHEET_RESERVED_HEIGHT =
  SHEET_TOP_CLEARANCE + SHEET_CONTAINER_PADDING + SHEET_TITLE_LINE + SHEET_STACK_GAP;

/**
 * What the picker's filter field adds when it shows (above SEARCH_THRESHOLD
 * projects): the field and its extra Stack gap. The keyboard allowance joins
 * at the call site in this case only, because only the filter can summon one.
 */
export const PICKER_FILTER_EXTRA_HEIGHT = SHEET_TEXT_FIELD + SHEET_STACK_GAP;

/**
 * Four body lines (4 x 20) plus the field's vertical padding (2 x spacing.sm):
 * the least description box that still invites writing. Kept a whole number
 * of text lines so alignHeightToTextLineGrid returns the floor unchanged
 * instead of rounding below it (pinned in the unit test).
 */
export const DESCRIPTION_FLOOR_HEIGHT = 96;

/** Three touch-height rows (3 x minTouchSize): the least list that still reads as a list. */
export const LIST_FLOOR_HEIGHT = 132;

export interface ClampSheetContentHeightOptions {
  /** useWindowDimensions().height at the call site. */
  windowHeight: number;
  /**
   * Everything the sheet needs outside the capped region: container padding,
   * title, gaps, fields, button, error-line allowance, safe-area bottom
   * inset, top clearance the sheet can never occupy, and the keyboard
   * allowance where a keyboard can appear. The per-sheet budgets above
   * document their sums; call sites add the device-specific parts.
   */
  reservedHeight: number;
  /**
   * The smallest useful capped region; wins over the window running out. A
   * floor above the ceiling is a caller misconfiguration: the ceiling wins
   * (pinned in the unit test).
   */
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
