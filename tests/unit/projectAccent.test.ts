/**
 * Per-project accent overlay guardrails: invalid input leaves the base theme
 * untouched, low-contrast colors are lifted toward the brand cream, onAccent
 * always stays readable, and ONLY the four accent-family tokens ever change.
 */
import { describe, expect, it } from 'vitest';
import { contrastRatio, mixHex, parseHexColor, type RgbColor } from '@/components/theme/color';
import { applyProjectAccent, deriveAccentFamily } from '@/components/theme/projectAccent';
import { brandTokens, darkTerminalTheme } from '@/components/theme/tokens';

function mustParse(hex: string): RgbColor {
  const parsed = parseHexColor(hex);
  if (parsed === null) throw new Error(`test fixture is not a valid hex color: ${hex}`);
  return parsed;
}

const baseTheme = darkTerminalTheme;
const backgroundHex = baseTheme.colors.background;

describe('deriveAccentFamily', () => {
  it('returns null for unparseable colors', () => {
    expect(deriveAccentFamily('', backgroundHex)).toBeNull();
    expect(deriveAccentFamily('chartreuse', backgroundHex)).toBeNull();
    expect(deriveAccentFamily('#12345', backgroundHex)).toBeNull();
    expect(deriveAccentFamily('#5da9e0', 'not-a-color')).toBeNull();
  });

  it('adopts a high-contrast color as-is (normalized to lowercase)', () => {
    const family = deriveAccentFamily('#5DA9E0', backgroundHex);
    expect(family).not.toBeNull();
    expect(family?.accent).toBe('#5da9e0');
  });

  it('steps a low-contrast color toward the brand cream until it reads at >= 3.0', () => {
    const muddyDark = '#2a2320';
    expect(contrastRatio(mustParse(muddyDark), mustParse(backgroundHex))).toBeLessThan(3);

    const family = deriveAccentFamily(muddyDark, backgroundHex);
    expect(family).not.toBeNull();
    if (family === null) throw new Error('unreachable');
    expect(family.accent).not.toBe(muddyDark);
    expect(contrastRatio(mustParse(family.accent), mustParse(backgroundHex))).toBeGreaterThanOrEqual(3);
  });

  it('derives muted and subtle by mixing the resolved accent toward the background', () => {
    const family = deriveAccentFamily('#5da9e0', backgroundHex);
    if (family === null) throw new Error('expected a derived family');
    expect(family.accentMuted).toBe(mixHex('#5da9e0', backgroundHex, 0.55));
    expect(family.accentSubtle).toBe(mixHex('#5da9e0', backgroundHex, 0.85));
  });

  it('chooses ink for onAccent on a light accent and cream on a darker one, always >= 4.5', () => {
    const lightFamily = deriveAccentFamily(brandTokens.amber, backgroundHex);
    expect(lightFamily?.onAccent).toBe(brandTokens.ink);

    // Mid-luminance blue: clears 3.0 on the background unchanged, but ink
    // would not clear 4.5 on it, so cream wins.
    const midFamily = deriveAccentFamily('#3d6ae0', backgroundHex);
    expect(midFamily?.onAccent).toBe(brandTokens.cream);

    for (const family of [lightFamily, midFamily]) {
      if (family === null || family === undefined) throw new Error('expected a derived family');
      expect(contrastRatio(mustParse(family.onAccent), mustParse(family.accent))).toBeGreaterThanOrEqual(4.5);
    }
  });
});

describe('applyProjectAccent', () => {
  it('returns the base theme reference untouched for invalid colors', () => {
    expect(applyProjectAccent(baseTheme, '')).toBe(baseTheme);
    expect(applyProjectAccent(baseTheme, 'chartreuse')).toBe(baseTheme);
    expect(applyProjectAccent(baseTheme, '#e8a33d00')).toBe(baseTheme);
  });

  it('replaces ONLY the four accent-family tokens', () => {
    const themed = applyProjectAccent(baseTheme, '#5da9e0');
    const accentFamilyKeys = new Set(['accent', 'accentMuted', 'accentSubtle', 'onAccent']);

    for (const [tokenName, tokenValue] of Object.entries(themed.colors)) {
      if (accentFamilyKeys.has(tokenName)) continue;
      expect(tokenValue, `non-accent token ${tokenName} must not change`).toBe(
        baseTheme.colors[tokenName as keyof typeof baseTheme.colors],
      );
    }
    // Status, terminal, and brand identity never vary per project.
    expect(themed.colors.statusNeedsYou).toBe(baseTheme.colors.statusNeedsYou);
    expect(themed.terminalPalette).toBe(baseTheme.terminalPalette);
    expect(themed.brand).toBe(baseTheme.brand);
    expect(themed.colors.accent).toBe('#5da9e0');
  });

  it('reproduces the base accent family exactly when given the brand amber', () => {
    const themed = applyProjectAccent(baseTheme, brandTokens.amber);
    expect(themed.colors.accent).toBe(baseTheme.colors.accent);
    expect(themed.colors.accentMuted).toBe(baseTheme.colors.accentMuted);
    expect(themed.colors.accentSubtle).toBe(baseTheme.colors.accentSubtle);
    expect(themed.colors.onAccent).toBe(baseTheme.colors.onAccent);
  });
});
