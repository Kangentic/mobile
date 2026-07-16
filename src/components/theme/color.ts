/**
 * Pure color math for the design system: hex parsing, WCAG relative luminance
 * and contrast ratio, and channel mixing. Deliberately free of react-native
 * imports so vitest can exercise the palette and the per-project accent
 * guardrails without an RN runtime.
 */

export interface RgbColor {
  red: number;
  green: number;
  blue: number;
}

const HEX_LONG_PATTERN = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i;
const HEX_SHORT_PATTERN = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i;

/**
 * Parses `#rrggbb` or shorthand `#rgb` (case-insensitive) into 0-255 channels.
 * Anything else (missing hash, wrong length, alpha channels, named colors)
 * returns null; callers treat null as "not a usable color", never a fallback.
 */
export function parseHexColor(value: string): RgbColor | null {
  const longMatch = HEX_LONG_PATTERN.exec(value);
  if (longMatch !== null) {
    return {
      red: Number.parseInt(longMatch[1], 16),
      green: Number.parseInt(longMatch[2], 16),
      blue: Number.parseInt(longMatch[3], 16),
    };
  }
  const shortMatch = HEX_SHORT_PATTERN.exec(value);
  if (shortMatch !== null) {
    return {
      red: Number.parseInt(shortMatch[1] + shortMatch[1], 16),
      green: Number.parseInt(shortMatch[2] + shortMatch[2], 16),
      blue: Number.parseInt(shortMatch[3] + shortMatch[3], 16),
    };
  }
  return null;
}

function linearizeChannel(channelValue: number): number {
  const normalized = channelValue / 255;
  return normalized <= 0.03928 ? normalized / 12.92 : Math.pow((normalized + 0.055) / 1.055, 2.4);
}

/** WCAG 2.x relative luminance: 0 for black, 1 for white. */
export function relativeLuminance(color: RgbColor): number {
  return (
    0.2126 * linearizeChannel(color.red) +
    0.7152 * linearizeChannel(color.green) +
    0.0722 * linearizeChannel(color.blue)
  );
}

/**
 * WCAG 2.x contrast ratio between two colors, in the range [1, 21].
 * Symmetric: argument order does not matter.
 */
export function contrastRatio(firstColor: RgbColor, secondColor: RgbColor): number {
  const firstLuminance = relativeLuminance(firstColor);
  const secondLuminance = relativeLuminance(secondColor);
  const lighter = Math.max(firstLuminance, secondLuminance);
  const darker = Math.min(firstLuminance, secondLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

function formatChannel(channelValue: number): string {
  const clamped = Math.min(255, Math.max(0, Math.round(channelValue)));
  return clamped.toString(16).padStart(2, '0');
}

/**
 * Mixes `fromHex` toward `toHex` by `amount` (0 = pure from, 1 = pure to),
 * per channel in sRGB space, returning a normalized lowercase `#rrggbb`.
 * Throws on unparseable input or an out-of-range amount: mixing is only ever
 * called on already-validated colors, so a bad argument is a programmer error.
 */
export function mixHex(fromHex: string, toHex: string, amount: number): string {
  const fromColor = parseHexColor(fromHex);
  const toColor = parseHexColor(toHex);
  if (fromColor === null || toColor === null) {
    throw new Error(`mixHex requires valid hex colors, got "${fromHex}" and "${toHex}"`);
  }
  if (!Number.isFinite(amount) || amount < 0 || amount > 1) {
    throw new Error(`mixHex requires an amount in [0, 1], got ${String(amount)}`);
  }
  const red = fromColor.red + (toColor.red - fromColor.red) * amount;
  const green = fromColor.green + (toColor.green - fromColor.green) * amount;
  const blue = fromColor.blue + (toColor.blue - fromColor.blue) * amount;
  return `#${formatChannel(red)}${formatChannel(green)}${formatChannel(blue)}`;
}
