/**
 * Pure color math: hex parsing, WCAG luminance/contrast, and channel mixing.
 * These utilities underpin the palette contrast tests and the per-project
 * accent guardrails, so their edge cases are locked here.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio, hexWithAlpha, mixHex, parseHexColor, relativeLuminance } from '@/components/theme/color';

describe('parseHexColor', () => {
  it('parses six-digit hex into 0-255 channels', () => {
    expect(parseHexColor('#e8a33d')).toEqual({ red: 232, green: 163, blue: 61 });
    expect(parseHexColor('#000000')).toEqual({ red: 0, green: 0, blue: 0 });
    expect(parseHexColor('#ffffff')).toEqual({ red: 255, green: 255, blue: 255 });
  });

  it('is case-insensitive', () => {
    expect(parseHexColor('#E8A33D')).toEqual({ red: 232, green: 163, blue: 61 });
  });

  it('parses three-digit shorthand by doubling each digit', () => {
    expect(parseHexColor('#fff')).toEqual({ red: 255, green: 255, blue: 255 });
    expect(parseHexColor('#a3c')).toEqual({ red: 170, green: 51, blue: 204 });
  });

  it('returns null for anything that is not a plain hex color', () => {
    expect(parseHexColor('')).toBeNull();
    expect(parseHexColor('red')).toBeNull();
    expect(parseHexColor('e8a33d')).toBeNull();
    expect(parseHexColor('#e8a33d00')).toBeNull();
    expect(parseHexColor('#12345')).toBeNull();
    expect(parseHexColor('#gggggg')).toBeNull();
    expect(parseHexColor('rgb(1, 2, 3)')).toBeNull();
  });
});

describe('relativeLuminance', () => {
  it('is 0 for black and 1 for white', () => {
    expect(relativeLuminance({ red: 0, green: 0, blue: 0 })).toBe(0);
    expect(relativeLuminance({ red: 255, green: 255, blue: 255 })).toBeCloseTo(1, 10);
  });

  it('weights green heaviest per the WCAG coefficients', () => {
    const greenLuminance = relativeLuminance({ red: 0, green: 255, blue: 0 });
    const redLuminance = relativeLuminance({ red: 255, green: 0, blue: 0 });
    const blueLuminance = relativeLuminance({ red: 0, green: 0, blue: 255 });
    expect(greenLuminance).toBeGreaterThan(redLuminance);
    expect(redLuminance).toBeGreaterThan(blueLuminance);
  });
});

describe('contrastRatio', () => {
  const white = { red: 255, green: 255, blue: 255 };
  const black = { red: 0, green: 0, blue: 0 };

  it('is 21 for white on black and 1 for identical colors', () => {
    expect(contrastRatio(white, black)).toBeCloseTo(21, 5);
    expect(contrastRatio(white, white)).toBeCloseTo(1, 10);
  });

  it('is symmetric in its arguments', () => {
    const amber = { red: 232, green: 163, blue: 61 };
    expect(contrastRatio(amber, black)).toBeCloseTo(contrastRatio(black, amber), 10);
  });
});

describe('mixHex', () => {
  it('returns the normalized endpoints at amount 0 and 1', () => {
    expect(mixHex('#E8A33D', '#ffffff', 0)).toBe('#e8a33d');
    expect(mixHex('#e8a33d', '#FFFFFF', 1)).toBe('#ffffff');
  });

  it('mixes per channel at the midpoint', () => {
    expect(mixHex('#000000', '#ffffff', 0.5)).toBe('#808080');
    expect(mixHex('#ff0000', '#0000ff', 0.5)).toBe('#800080');
  });

  it('throws on unparseable colors', () => {
    expect(() => mixHex('nope', '#ffffff', 0.5)).toThrow(/valid hex colors/);
    expect(() => mixHex('#ffffff', 'nope', 0.5)).toThrow(/valid hex colors/);
  });

  it('throws on an out-of-range or non-finite amount', () => {
    expect(() => mixHex('#000000', '#ffffff', -0.1)).toThrow(/amount in \[0, 1\]/);
    expect(() => mixHex('#000000', '#ffffff', 1.1)).toThrow(/amount in \[0, 1\]/);
    expect(() => mixHex('#000000', '#ffffff', Number.NaN)).toThrow(/amount in \[0, 1\]/);
  });
});

describe('hexWithAlpha', () => {
  /**
   * Mutation seen failing: swapping red and green in the template string
   * (`rgba(${color.green}, ${color.red}, ...)`) turns the expected
   * "rgba(57, 135, 229, 0.1)" into "rgba(135, 57, 229, 0.1)".
   */
  it('writes the channels in red, green, blue order with the alpha last', () => {
    expect(hexWithAlpha('#3987e5', 0.1)).toBe('rgba(57, 135, 229, 0.1)');
  });

  it('reads shorthand and uppercase hex the way parseHexColor does', () => {
    expect(hexWithAlpha('#a3c', 0.5)).toBe('rgba(170, 51, 204, 0.5)');
    expect(hexWithAlpha('#E8A33D', 0.25)).toBe('rgba(232, 163, 61, 0.25)');
  });

  it('accepts the two ends of the alpha range', () => {
    expect(hexWithAlpha('#000000', 0)).toBe('rgba(0, 0, 0, 0)');
    expect(hexWithAlpha('#ffffff', 1)).toBe('rgba(255, 255, 255, 1)');
  });

  /**
   * Mutation seen failing: dropping `!Number.isFinite(alpha) ||` from the guard.
   * NaN passes both range comparisons, so the NaN line is the one that fails
   * ("expected [Function] to throw an error").
   */
  it('throws on an alpha outside [0, 1] or not a number', () => {
    expect(() => hexWithAlpha('#3987e5', 1.5)).toThrow(/alpha in \[0, 1\]/);
    expect(() => hexWithAlpha('#3987e5', -0.1)).toThrow(/alpha in \[0, 1\]/);
    expect(() => hexWithAlpha('#3987e5', Number.NaN)).toThrow(/alpha in \[0, 1\]/);
  });

  it('throws on a color that is not a plain hex color', () => {
    expect(() => hexWithAlpha('#zzz', 0.5)).toThrow(/valid hex color/);
    expect(() => hexWithAlpha('red', 0.5)).toThrow(/valid hex color/);
  });
});
