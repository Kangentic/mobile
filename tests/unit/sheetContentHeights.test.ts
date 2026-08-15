import { describe, expect, it } from 'vitest';
import {
  alignHeightToTextLineGrid,
  clampSheetContentHeight,
  SHEET_CONTENT_CEILING,
  SHEET_KEYBOARD_ALLOWANCE,
} from '@/lib/sheetContentHeights';

/** The tester recording's phone: a 393x852pt iPhone with a 34pt bottom inset. */
const TESTER_WINDOW_HEIGHT = 852;
const TESTER_BOTTOM_INSET = 34;

/** Theme values the screens pass in (body line height, 2 * spacing.sm). */
const BODY_LINE_HEIGHT = 20;
const FIELD_VERTICAL_PADDING = 16;

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

  // The derivations the screens document, kept executable so a token change
  // that silently invalidates them shows up here rather than on a device.
  describe('on the tester recording phone (852pt window, 34pt inset)', () => {
    it('keeps the Move list at the ceiling (no visual change from the fixed cap)', () => {
      const moveListReservedHeight = 278 + TESTER_BOTTOM_INSET;
      expect(
        clampSheetContentHeight({
          windowHeight: TESTER_WINDOW_HEIGHT,
          reservedHeight: moveListReservedHeight,
          floorHeight: 132,
        }),
      ).toBe(SHEET_CONTENT_CEILING);
    });

    it('shrinks the Edit description so the sheet clears the keyboard', () => {
      const editReservedHeight = 278 + TESTER_BOTTOM_INSET + SHEET_KEYBOARD_ALLOWANCE;
      const cap = clampSheetContentHeight({
        windowHeight: TESTER_WINDOW_HEIGHT,
        reservedHeight: editReservedHeight,
        floorHeight: 96,
      });
      expect(cap).toBe(200);
      // The whole keyboard-up sheet now fits above the keyboard.
      expect(cap + editReservedHeight).toBeLessThanOrEqual(TESTER_WINDOW_HEIGHT);
    });

    it('shrinks the Create description so the sheet clears the keyboard', () => {
      const createReservedHeight = 332 + TESTER_BOTTOM_INSET + SHEET_KEYBOARD_ALLOWANCE;
      expect(
        clampSheetContentHeight({
          windowHeight: TESTER_WINDOW_HEIGHT,
          reservedHeight: createReservedHeight,
          floorHeight: 96,
        }),
      ).toBe(146);
    });

    it('shrinks the filtered project list so rows stay tappable over the keyboard', () => {
      const filteredPickerReservedHeight = 194 + TESTER_BOTTOM_INSET + SHEET_KEYBOARD_ALLOWANCE;
      expect(
        clampSheetContentHeight({
          windowHeight: TESTER_WINDOW_HEIGHT,
          reservedHeight: filteredPickerReservedHeight,
          floorHeight: 132,
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

  it('leaves an already aligned cap unchanged', () => {
    expect(
      alignHeightToTextLineGrid({
        height: 96,
        lineHeight: BODY_LINE_HEIGHT,
        verticalPadding: FIELD_VERTICAL_PADDING,
      }),
    ).toBe(96);
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
