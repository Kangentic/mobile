/**
 * computeSheetDescriptionBounds is the extracted, pure height math behind
 * CreateTaskSheet's and EditTaskSheet's multiline description field: it
 * fills whatever the sheet's SHEET_MAX_HEIGHT_FRACTION budget leaves after
 * every OTHER fixed row (title, title field, an optional column-chips row,
 * the action button, and paddings/inset), floored at three lines so the
 * field never collapses to nothing.
 *
 * Assertions here are derived from the intent described in the function's
 * own doc comment and Sheet.tsx's layout (fixed rows: title, title field,
 * optional chips row, action button, paddings, inset), not by re-deriving
 * the implementation's formula - see the delta/floor/golden cases below.
 */
import { describe, expect, it } from 'vitest';
import { computeSheetDescriptionBounds, SHEET_MAX_HEIGHT_FRACTION } from '@/components/sheetLayout';
import { darkTerminalTheme } from '@/components/theme/tokens';

describe('computeSheetDescriptionBounds', () => {
  it('the floor is exactly three body lines plus two vertical paddings', () => {
    const { descriptionMinHeight } = computeSheetDescriptionBounds({
      theme: darkTerminalTheme,
      windowHeight: 800,
      bottomInset: 0,
      hasColumnChipsRow: false,
    });

    expect(descriptionMinHeight).toBe(darkTerminalTheme.typography.body.lineHeight * 3 + darkTerminalTheme.spacing.sm * 2);
  });

  it('never returns a max below the min, even on a tiny window (the Math.max floor)', () => {
    const tinyWindow = { theme: darkTerminalTheme, windowHeight: 100, bottomInset: 0 };

    const withChips = computeSheetDescriptionBounds({ ...tinyWindow, hasColumnChipsRow: true });
    const withoutChips = computeSheetDescriptionBounds({ ...tinyWindow, hasColumnChipsRow: false });

    expect(withChips.descriptionMaxHeight).toBe(withChips.descriptionMinHeight);
    expect(withoutChips.descriptionMaxHeight).toBe(withoutChips.descriptionMinHeight);
  });

  it('a taller window raises the max, never the min', () => {
    const shortWindow = computeSheetDescriptionBounds({
      theme: darkTerminalTheme,
      windowHeight: 700,
      bottomInset: 0,
      hasColumnChipsRow: false,
    });
    const tallWindow = computeSheetDescriptionBounds({
      theme: darkTerminalTheme,
      windowHeight: 900,
      bottomInset: 0,
      hasColumnChipsRow: false,
    });

    expect(tallWindow.descriptionMaxHeight).toBeGreaterThan(shortWindow.descriptionMaxHeight);
    expect(tallWindow.descriptionMinHeight).toBe(shortWindow.descriptionMinHeight);
  });

  it('CreateTaskSheet (hasColumnChipsRow: true) reserves exactly one extra touch-height row plus one gap versus EditTaskSheet (false)', () => {
    const withChips = computeSheetDescriptionBounds({
      theme: darkTerminalTheme,
      windowHeight: 800,
      bottomInset: 0,
      hasColumnChipsRow: true,
    });
    const withoutChips = computeSheetDescriptionBounds({
      theme: darkTerminalTheme,
      windowHeight: 800,
      bottomInset: 0,
      hasColumnChipsRow: false,
    });

    const extraChipsRowReservation = darkTerminalTheme.minTouchSize + darkTerminalTheme.spacing.sm;
    expect(withoutChips.descriptionMaxHeight - withChips.descriptionMaxHeight).toBe(extraChipsRowReservation);
  });

  it('a larger bottom safe-area inset reduces the max by exactly that amount', () => {
    const noInset = computeSheetDescriptionBounds({
      theme: darkTerminalTheme,
      windowHeight: 800,
      bottomInset: 0,
      hasColumnChipsRow: false,
    });
    const withInset = computeSheetDescriptionBounds({
      theme: darkTerminalTheme,
      windowHeight: 800,
      bottomInset: 34,
      hasColumnChipsRow: false,
    });

    expect(noInset.descriptionMaxHeight - withInset.descriptionMaxHeight).toBe(34);
  });

  it('reproduces the CreateTaskSheet formula (hasColumnChipsRow: true) against the dark terminal theme', () => {
    // Independently derived from Sheet's actual fixed rows (not copied from
    // the implementation): paddingTop(lg=16) + title lineHeight(24) +
    // title marginBottom(md=12) + title field(minTouchSize=44) + gap(sm=8)
    // + gap to next row(sm=8) + chips row(minTouchSize=44) + chips gap(sm=8)
    // + action button(minTouchSize=44) + paddingBottom(lg=16) + inset(0) +
    // safety buffer(md=12) = 236 reserved chrome; window 800 * 0.75 = 600;
    // 600 - 236 = 364, well above the 76 floor.
    const { descriptionMaxHeight, descriptionMinHeight } = computeSheetDescriptionBounds({
      theme: darkTerminalTheme,
      windowHeight: 800,
      bottomInset: 0,
      hasColumnChipsRow: true,
    });

    expect(descriptionMinHeight).toBe(76);
    expect(descriptionMaxHeight).toBe(800 * SHEET_MAX_HEIGHT_FRACTION - 236);
    expect(descriptionMaxHeight).toBe(364);
  });

  it('reproduces the EditTaskSheet formula (hasColumnChipsRow: false) against the dark terminal theme', () => {
    // Same fixed rows as CreateTaskSheet minus the chips row and its gap
    // (44 + 8 = 52 less reserved chrome): 236 - 52 = 184 reserved;
    // 600 - 184 = 416.
    const { descriptionMaxHeight, descriptionMinHeight } = computeSheetDescriptionBounds({
      theme: darkTerminalTheme,
      windowHeight: 800,
      bottomInset: 0,
      hasColumnChipsRow: false,
    });

    expect(descriptionMinHeight).toBe(76);
    expect(descriptionMaxHeight).toBe(800 * SHEET_MAX_HEIGHT_FRACTION - 184);
    expect(descriptionMaxHeight).toBe(416);
  });
});
