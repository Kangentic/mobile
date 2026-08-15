import { describe, expect, it } from 'vitest';
import {
  alignHeightToTextLineGrid,
  clampSheetContentHeight,
  CREATE_SHEET_RESERVED_HEIGHT,
  DESCRIPTION_FLOOR_HEIGHT,
  EDIT_SHEET_RESERVED_HEIGHT,
  LIST_FLOOR_HEIGHT,
  MOVE_SHEET_RESERVED_HEIGHT,
  PICKER_FILTER_EXTRA_HEIGHT,
  PICKER_SHEET_RESERVED_HEIGHT,
  SHEET_CONTENT_CEILING,
  SHEET_KEYBOARD_ALLOWANCE,
} from '@/lib/sheetContentHeights';
import { darkTerminalTheme } from '@/components/theme/tokens';

/** The tester recording's phone: a 393x852pt iPhone with a 34pt bottom inset. */
const TESTER_WINDOW_HEIGHT = 852;
const TESTER_BOTTOM_INSET = 34;

/** The real theme values the screens pass in at their call sites. */
const BODY_LINE_HEIGHT = darkTerminalTheme.typography.body.lineHeight;
const FIELD_VERTICAL_PADDING = 2 * darkTerminalTheme.spacing.sm;

describe('clampSheetContentHeight', () => {
  it('holds the ceiling when the window has room to spare', () => {
    expect(
      clampSheetContentHeight({ windowHeight: 1280, reservedHeight: 246, floorHeight: 132 }),
    ).toBe(SHEET_CONTENT_CEILING);
  });

  it('returns the available height when the window binds', () => {
    expect(
      clampSheetContentHeight({ windowHeight: 700, reservedHeight: 400, floorHeight: 132 }),
    ).toBe(300);
  });

  it('holds the floor when the window runs out', () => {
    expect(
      clampSheetContentHeight({ windowHeight: 360, reservedHeight: 300, floorHeight: 132 }),
    ).toBe(132);
  });

  it('holds the floor even when the reserve exceeds the window', () => {
    expect(
      clampSheetContentHeight({ windowHeight: 360, reservedHeight: 640, floorHeight: 96 }),
    ).toBe(96);
  });

  it('honors an explicit ceiling', () => {
    expect(
      clampSheetContentHeight({
        windowHeight: 1280,
        reservedHeight: 100,
        floorHeight: 96,
        ceilingHeight: 200,
      }),
    ).toBe(200);
  });

  it('lets the ceiling win over a misconfigured floor above it', () => {
    // A floor above the ceiling is a caller bug; the documented behavior is
    // that the ceiling wins rather than the floor blowing past it.
    expect(
      clampSheetContentHeight({
        windowHeight: 1000,
        reservedHeight: 100,
        floorHeight: 500,
        ceilingHeight: 420,
      }),
    ).toBe(420);
  });

  // The derivations the screens rely on, executed against the REAL budget
  // constants (imported above, not retyped), so a budget change that
  // invalidates them fails here rather than on a device.
  describe('on the tester recording phone (852pt window, 34pt inset)', () => {
    it('keeps the Move list at the ceiling (no visual change from the fixed cap)', () => {
      const moveListReservedHeight = MOVE_SHEET_RESERVED_HEIGHT + TESTER_BOTTOM_INSET;
      expect(
        clampSheetContentHeight({
          windowHeight: TESTER_WINDOW_HEIGHT,
          reservedHeight: moveListReservedHeight,
          floorHeight: LIST_FLOOR_HEIGHT,
        }),
      ).toBe(SHEET_CONTENT_CEILING);
    });

    it('shrinks the Edit description so the sheet clears the keyboard', () => {
      const editReservedHeight =
        EDIT_SHEET_RESERVED_HEIGHT + TESTER_BOTTOM_INSET + SHEET_KEYBOARD_ALLOWANCE;
      const cap = clampSheetContentHeight({
        windowHeight: TESTER_WINDOW_HEIGHT,
        reservedHeight: editReservedHeight,
        floorHeight: DESCRIPTION_FLOOR_HEIGHT,
      });
      expect(cap).toBe(192);
      // The whole keyboard-up sheet now fits above the keyboard.
      expect(cap + editReservedHeight).toBeLessThanOrEqual(TESTER_WINDOW_HEIGHT);
    });

    it('shrinks the Create description so the sheet clears the keyboard', () => {
      const createReservedHeight =
        CREATE_SHEET_RESERVED_HEIGHT + TESTER_BOTTOM_INSET + SHEET_KEYBOARD_ALLOWANCE;
      const cap = clampSheetContentHeight({
        windowHeight: TESTER_WINDOW_HEIGHT,
        reservedHeight: createReservedHeight,
        floorHeight: DESCRIPTION_FLOOR_HEIGHT,
      });
      expect(cap).toBe(138);
      expect(cap + createReservedHeight).toBeLessThanOrEqual(TESTER_WINDOW_HEIGHT);
    });

    it('shrinks the filtered project list so rows stay tappable over the keyboard', () => {
      const filteredPickerReservedHeight =
        PICKER_SHEET_RESERVED_HEIGHT +
        PICKER_FILTER_EXTRA_HEIGHT +
        TESTER_BOTTOM_INSET +
        SHEET_KEYBOARD_ALLOWANCE;
      expect(
        clampSheetContentHeight({
          windowHeight: TESTER_WINDOW_HEIGHT,
          reservedHeight: filteredPickerReservedHeight,
          floorHeight: LIST_FLOOR_HEIGHT,
        }),
      ).toBe(284);
    });
  });
});

describe('alignHeightToTextLineGrid', () => {
  it('rounds a cap down to a whole number of lines plus padding', () => {
    expect(
      alignHeightToTextLineGrid({
        height: 200,
        lineHeight: BODY_LINE_HEIGHT,
        verticalPadding: FIELD_VERTICAL_PADDING,
      }),
    ).toBe(196);
  });

  it('returns the description floor unchanged: the floor is a whole number of lines', () => {
    // Load-bearing: the screens align AFTER clamping, so a floor that were
    // not grid-aligned would be rounded back below itself on the smallest
    // windows, silently voiding the floor guarantee.
    expect(
      alignHeightToTextLineGrid({
        height: DESCRIPTION_FLOOR_HEIGHT,
        lineHeight: BODY_LINE_HEIGHT,
        verticalPadding: FIELD_VERTICAL_PADDING,
      }),
    ).toBe(DESCRIPTION_FLOOR_HEIGHT);
  });

  it('never returns less than one full line', () => {
    expect(
      alignHeightToTextLineGrid({
        height: 10,
        lineHeight: BODY_LINE_HEIGHT,
        verticalPadding: FIELD_VERTICAL_PADDING,
      }),
    ).toBe(BODY_LINE_HEIGHT + FIELD_VERTICAL_PADDING);
  });

  it('aligns the historical 420 ceiling down to the 416 the grid allows', () => {
    expect(
      alignHeightToTextLineGrid({
        height: SHEET_CONTENT_CEILING,
        lineHeight: BODY_LINE_HEIGHT,
        verticalPadding: FIELD_VERTICAL_PADDING,
      }),
    ).toBe(416);
  });
});
