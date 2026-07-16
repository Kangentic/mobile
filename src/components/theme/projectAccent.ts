/**
 * Per-project accent overlay: derives a safe accent family from a
 * desktop-provided project color and applies it over the base theme.
 *
 * Guardrails (all tested in tests/unit/projectAccent.test.ts):
 * - An unparseable color leaves the base theme untouched (same reference).
 * - A low-contrast color is stepped toward the brand cream until it reads at
 *   >= 3.0:1 against the theme background.
 * - `onAccent` picks the brand ink when it stays readable (>= 4.5:1) on the
 *   resolved accent, otherwise the brand cream.
 * - ONLY the four accent-family tokens are replaced. Status, semantic, ANSI,
 *   and brand tokens never vary per project (the two-hue rule and the fixed
 *   brand identity both depend on that).
 */
import { contrastRatio, mixHex, parseHexColor } from './color';
import { brandTokens, type ColorTokens, type Theme } from './tokens';

/** Minimum accent-on-background contrast before a project color is usable as-is. */
const MINIMUM_ACCENT_CONTRAST = 3.0;

/** Minimum on-accent text contrast for choosing ink over cream. */
const MINIMUM_ON_ACCENT_CONTRAST = 4.5;

/** Step size when walking a too-dark accent toward the brand cream. */
const ACCENT_LIGHTEN_STEP = 0.05;

/** Mix fractions toward the background for the derived family members. */
const ACCENT_MUTED_MIX = 0.55;
const ACCENT_SUBTLE_MIX = 0.85;

export interface AccentFamily {
  accent: string;
  accentMuted: string;
  accentSubtle: string;
  onAccent: string;
}

/**
 * Derives the four-token accent family for a candidate accent color on the
 * given background. Returns null when either color fails to parse; callers
 * treat null as "keep the base theme".
 */
export function deriveAccentFamily(candidateAccentHex: string, backgroundHex: string): AccentFamily | null {
  const candidateColor = parseHexColor(candidateAccentHex);
  const backgroundColor = parseHexColor(backgroundHex);
  if (candidateColor === null || backgroundColor === null) return null;

  // Step the accent toward the brand cream until it clears the contrast
  // floor on the background. Cream itself clears the floor by a wide margin,
  // so the walk always terminates.
  let resolvedAccentHex = mixHex(candidateAccentHex, brandTokens.cream, 0);
  let lightenAmount = 0;
  while (lightenAmount < 1) {
    const resolvedColor = parseHexColor(resolvedAccentHex);
    if (resolvedColor !== null && contrastRatio(resolvedColor, backgroundColor) >= MINIMUM_ACCENT_CONTRAST) {
      break;
    }
    lightenAmount = Math.min(1, lightenAmount + ACCENT_LIGHTEN_STEP);
    resolvedAccentHex = mixHex(candidateAccentHex, brandTokens.cream, lightenAmount);
  }

  const resolvedAccentColor = parseHexColor(resolvedAccentHex);
  const inkColor = parseHexColor(brandTokens.ink);
  const onAccent =
    resolvedAccentColor !== null &&
    inkColor !== null &&
    contrastRatio(inkColor, resolvedAccentColor) >= MINIMUM_ON_ACCENT_CONTRAST
      ? brandTokens.ink
      : brandTokens.cream;

  return {
    accent: resolvedAccentHex,
    accentMuted: mixHex(resolvedAccentHex, backgroundHex, ACCENT_MUTED_MIX),
    accentSubtle: mixHex(resolvedAccentHex, backgroundHex, ACCENT_SUBTLE_MIX),
    onAccent,
  };
}

/**
 * Applies a project color over the base theme, replacing only the accent
 * family. An invalid color returns the base theme reference unchanged, so a
 * missing or garbage wire value can never distort the UI.
 */
export function applyProjectAccent(baseTheme: Theme, projectColorHex: string): Theme {
  const accentFamily = deriveAccentFamily(projectColorHex, baseTheme.colors.background);
  if (accentFamily === null) return baseTheme;
  const colors: ColorTokens = {
    ...baseTheme.colors,
    accent: accentFamily.accent,
    accentMuted: accentFamily.accentMuted,
    accentSubtle: accentFamily.accentSubtle,
    onAccent: accentFamily.onAccent,
  };
  return { ...baseTheme, colors };
}
