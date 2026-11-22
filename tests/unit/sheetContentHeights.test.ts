import { describe, expect, it } from 'vitest';
import {
  alignHeightToTextLineGrid,
  clampSheetContentHeight,
  CREATE_SHEET_RESERVED_HEIGHT,
  DESCRIPTION_FLOOR_HEIGHT,
  EDIT_SHEET_RESERVED_HEIGHT,
  estimatedEarlierRowHeight,
  LIST_FLOOR_HEIGHT,
  MOVE_SHEET_RESERVED_HEIGHT,
  PICKER_FILTER_EXTRA_HEIGHT,
  PICKER_SHEET_RESERVED_HEIGHT,
  SHEET_CONTENT_CEILING,
  SHEET_KEYBOARD_ALLOWANCE,
  terminalsSheetReservedHeight,
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

    it('keeps the Terminals sheet\'s Earlier list at the ceiling with nothing running', () => {
      expect(
        clampSheetContentHeight({
          windowHeight: TESTER_WINDOW_HEIGHT,
          reservedHeight: terminalsSheetReservedHeight(0) + TESTER_BOTTOM_INSET,
          floorHeight: LIST_FLOOR_HEIGHT,
        }),
      ).toBe(SHEET_CONTENT_CEILING);
    });

    it('shrinks the Earlier list under four running terminals so the whole sheet still fits', () => {
      const reservedHeight = terminalsSheetReservedHeight(4) + TESTER_BOTTOM_INSET;
      const cap = clampSheetContentHeight({ windowHeight: TESTER_WINDOW_HEIGHT, reservedHeight, floorHeight: LIST_FLOOR_HEIGHT });

      expect(cap).toBe(251);
      expect(cap + reservedHeight).toBeLessThanOrEqual(TESTER_WINDOW_HEIGHT);
    });

    it('still fits the whole Terminals sheet at a large OS font scale', () => {
      const fontScale = 1.3;
      const reservedHeight = terminalsSheetReservedHeight(4, fontScale) + TESTER_BOTTOM_INSET;
      const cap = clampSheetContentHeight({ windowHeight: TESTER_WINDOW_HEIGHT, reservedHeight, floorHeight: LIST_FLOOR_HEIGHT });

      expect(cap).toBeLessThan(clampSheetContentHeight({
        windowHeight: TESTER_WINDOW_HEIGHT,
        reservedHeight: terminalsSheetReservedHeight(4) + TESTER_BOTTOM_INSET,
        floorHeight: LIST_FLOOR_HEIGHT,
      }));
      expect(cap + reservedHeight).toBeLessThanOrEqual(TESTER_WINDOW_HEIGHT);
    });
  });
});

/**
 * The Terminals sheet's budget around its Earlier list (protocol 0.24.0, task
 * #160), executed: the title, the stop-failure allowance, New, the rule and
 * the Earlier heading always, and the Running heading with its rows only while
 * terminals run.
 */
describe('terminalsSheetReservedHeight', () => {
  it('reserves the fixed chrome alone with nothing running', () => {
    // 70 clearance + 40 padding + 24 title + 8, 32 error + 8, 44 New + 8, 1 rule + 8, 20 heading + 8.
    expect(terminalsSheetReservedHeight(0)).toBe(271);
  });

  it('adds the Running heading and the first row together, then one row and its gap per terminal', () => {
    // 20 heading + 8, 62 row + 8 after the rows.
    expect(terminalsSheetReservedHeight(1) - terminalsSheetReservedHeight(0)).toBe(98);
    // 62 row + 4 gap.
    expect(terminalsSheetReservedHeight(2) - terminalsSheetReservedHeight(1)).toBe(66);
    expect(terminalsSheetReservedHeight(4)).toBe(567);
  });

  /**
   * A terminal row is as tall as its 44-high Stop, not its two text lines (40):
   * 8 + 44 + 8 padding, plus the raised surface's hairline border budgeted as
   * a pixel top and bottom. Mutation seen failing: the old 56-high row.
   */
  it('budgets a terminal row at its Stop control\'s touch height, not its text', () => {
    expect(terminalsSheetReservedHeight(3) - terminalsSheetReservedHeight(2)).toBe(62 + 4);
  });

  it('scales the text lines, and only them, with the OS font scale', () => {
    // Title 24, error allowance 32 and the Earlier heading's caption 16 grow by half at 1.5.
    expect(terminalsSheetReservedHeight(0, 1.5) - terminalsSheetReservedHeight(0)).toBe((24 + 32 + 16) / 2);
    // At 1.5 a row's text (36 x 1.5 + 4 = 58) outgrows the 44 Stop, so the row is
    // 16 + 58 + 2 = 76; the Running heading is 4 + 16 x 1.5 = 28; each takes its gap of 8.
    expect(terminalsSheetReservedHeight(1, 1.5) - terminalsSheetReservedHeight(0, 1.5)).toBe(28 + 8 + 76 + 8);
  });

  it('treats a negative count as none', () => {
    expect(terminalsSheetReservedHeight(-1)).toBe(terminalsSheetReservedHeight(0));
  });
});

describe('estimatedEarlierRowHeight', () => {
  it('is the padding, the two lines and the gap, and the border, rounded up to a whole point', () => {
    // 16 padding + 20 + 4 + 16, plus two 0.5 hairlines.
    expect(estimatedEarlierRowHeight(1, 0.5)).toBe(57);
  });

  it('grows only its text lines with the OS font scale', () => {
    expect(estimatedEarlierRowHeight(2, 0)).toBe(16 + 4 + 36 * 2);
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

  /**
   * DESCRIPTION_FLOOR_HEIGHT is deliberately a whole number of lines so this
   * function returns it unchanged (pinned above); that guarantee only holds
   * because alignment is a cliff at each line boundary, not a smooth
   * round-down. One point under the floor drops a WHOLE line, not one point:
   * this is the boundary the "kept a whole number of text lines" comment on
   * DESCRIPTION_FLOOR_HEIGHT depends on.
   */
  it('drops a full line, not one point, just under a line boundary', () => {
    // DESCRIPTION_FLOOR_HEIGHT (96) is 4 lines (20 each) plus 16 padding; one
    // point under that boundary (95) drops to 3 lines plus padding (76), not
    // 95 itself. A literal, like the pinned cases above, so a coordinated
    // change to BODY_LINE_HEIGHT cannot keep this green silently.
    expect(
      alignHeightToTextLineGrid({
        height: DESCRIPTION_FLOOR_HEIGHT - 1,
        lineHeight: BODY_LINE_HEIGHT,
        verticalPadding: FIELD_VERTICAL_PADDING,
      }),
    ).toBe(76);
  });
});
