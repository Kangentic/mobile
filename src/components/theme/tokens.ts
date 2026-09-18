import { mixHex } from './color';

/**
 * Design tokens for the dark, terminal-native brand theme ("Warm Craft").
 *
 * This module is the ONLY place in the app allowed to carry hardcoded hex
 * values (generated asset data under src/brand/ is the one other exception).
 * It stays pure data with no react-native import so vitest can assert the
 * palette's contrast guarantees (tests/unit/tokensContrast.test.ts).
 *
 * TWO-HUE RULE (load-bearing, tested):
 * - Amber is the brand and the attention hue: `accent`, `statusNeedsYou`.
 * - Green is the terminal-native positive hue: `statusWorking`, `success`,
 *   diff adds, `ansiGreen`.
 * - `warning` is a true yellow (also `ansiYellow`) so amber never has to mean
 *   both "brand" and "caution" at once. Never point a warning role back at
 *   amber or a positive role at amber/yellow.
 */

export interface ColorTokens {
  background: string;
  surface: string;
  surfaceRaised: string;
  /** Sheets and modal surfaces: the highest elevation step, above surfaceRaised. */
  surfaceOverlay: string;
  border: string;
  backdrop: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentMuted: string;
  /** Barely-there accent wash for selected rows and subtle emphasis fills. */
  accentSubtle: string;
  /** Text/glyph color guaranteed readable on an accent (or semantic) fill. */
  onAccent: string;
  statusNeedsYou: string;
  statusWorking: string;
  statusIdle: string;
  success: string;
  warning: string;
  danger: string;
  dangerMuted: string;
  /**
   * Merge conflicts, and anything else that is stuck rather than failed. The
   * brand rust, promoted to a semantic role so it can sit beside `danger`
   * without reading as it: a conflicting PR is still open and still landable,
   * a closed one is not. Deliberately NOT amber, which the two-hue rule keeps
   * for the brand and for attention.
   */
  conflict: string;
  /** Neutral informational tint (hints, callouts) distinct from all status hues. */
  info: string;
  diffAddBackground: string;
  diffAddText: string;
  diffRemoveBackground: string;
  diffRemoveText: string;
  codeBackground: string;
  terminalBackground: string;
}

/**
 * The 16 standard ANSI colors, tuned to the dark terminal theme. Consumed by
 * terminal-style renderers (and later an xterm.js theme object) so escape-coded
 * output matches the rest of the design system.
 */
export interface TerminalPalette {
  ansiBlack: string;
  ansiRed: string;
  ansiGreen: string;
  ansiYellow: string;
  ansiBlue: string;
  ansiMagenta: string;
  ansiCyan: string;
  ansiWhite: string;
  ansiBrightBlack: string;
  ansiBrightRed: string;
  ansiBrightGreen: string;
  ansiBrightYellow: string;
  ansiBrightBlue: string;
  ansiBrightMagenta: string;
  ansiBrightCyan: string;
  ansiBrightWhite: string;
}

/**
 * The fixed brand identity colors from @kangentic/branding ("Warm Craft"
 * generation). These are NEVER project-overridden: the per-project accent
 * overlay (projectAccent.ts) replaces only the accent family in ColorTokens
 * and leans on these as its guardrail anchors (step toward cream, ink for
 * on-accent text).
 */
export interface BrandTokens {
  amber: string;
  rust: string;
  cream: string;
  ink: string;
}

/** A cubic bezier easing curve as pure data: (x1, y1, x2, y2) control points. */
export interface MotionEasingBezier {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Motion timings as pure data (milliseconds and curve control points), so the
 * motion module (reanimated presets, skeletons) shares one timing vocabulary
 * and vitest can import it without react-native. The Overseer mascot's own
 * timings are not here: they are generated output from the shared branding
 * package's motion manifest (src/brand/overseerFrames.generated.ts), so they
 * cannot drift from the assets they animate.
 */
export interface MotionTokens {
  durations: {
    instant: number;
    fast: number;
    base: number;
    slow: number;
  };
  easing: {
    /** General-purpose ease for on-screen movement. */
    standard: MotionEasingBezier;
    /** Entering elements: fast start, gentle settle. */
    decelerate: MotionEasingBezier;
    /** Exiting elements: gentle start, fast leave. */
    accelerate: MotionEasingBezier;
  };
  /** Pressed-state scale for touchables (PressScale wraps Card/Button/IconButton later). */
  pressedScale: number;
  /**
   * The loading placeholder's pulse. `holdAfterMs` bounds it: a skeleton that
   * has been on screen that long stops pulsing and rests at the mid opacity,
   * still reading as "loading". A load normally lands in a second or two, but
   * a stalled one does not, and a tween draws a whole window frame per vsync
   * for as long as it runs (measured 2026-09-18 on the release build: a board
   * stranded on its skeleton drew 60 frames a second for the ninety seconds
   * the stall lasted, read off the emulator's per-second frame stats). The
   * bound is the same shape as the swap veil's quiet deadline.
   */
  skeletonPulse: {
    durationMs: number;
    opacityMin: number;
    opacityMax: number;
    holdAfterMs: number;
  };
  /**
   * The session screen's swap veil: a scrim over the last terminal frame that
   * breathes while a session swap is in flight. Slower than the skeleton (a
   * transition, not a loading placeholder) and never far from opaque, so the
   * dead frame under it can be seen to still be there but never read as live.
   */
  swapVeilPulse: {
    durationMs: number;
    opacityMin: number;
    opacityMax: number;
  };
  /**
   * The wait cursor: one cell-sized block blinking at the empty terminal's
   * origin once the swap veil has cleared the pane, the terminal's own idiom
   * for waiting with nothing to show. A BLINK, not a breath: a two-state
   * toggle committed on a JS interval, never a tween, because a tween draws a
   * whole window frame per vsync however small the view that changed.
   * Measured on the release build (emulator, 2026-09-18): a breathing cursor
   * drew 57 frames a second at 24-28% of a core, the same cost the
   * full-screen scrim breath had, while the same veil held still drew
   * nothing at 1.5-4%. The scrim itself holds static there
   * for the same reason, and because its breath over the empty grid moves
   * each channel by less than one unit (the two backgrounds are three units
   * apart). `intervalMs` is a half-period, lit for one and dim for the next,
   * xterm.js's own cursor cadence; the dim state stays faintly visible so the
   * grid's origin never vanishes.
   */
  waitCursorBlink: {
    intervalMs: number;
    opacityMin: number;
    opacityMax: number;
  };
}

export interface TypographyToken {
  fontSize: number;
  lineHeight: number;
  fontWeight: '400' | '500' | '600' | '700';
}

export interface TypographyTokens {
  body: TypographyToken;
  bodyStrong: TypographyToken;
  caption: TypographyToken;
  title: TypographyToken;
  display: TypographyToken;
  heading: TypographyToken;
}

export interface SpacingTokens {
  xs: number;
  sm: number;
  md: number;
  lg: number;
  xl: number;
  xxl: number;
}

export interface RadiusTokens {
  sm: number;
  md: number;
  lg: number;
  /** Stadium/pill shape: fully rounded ends regardless of element height. */
  full: number;
}

export interface Theme {
  colors: ColorTokens;
  terminalPalette: TerminalPalette;
  brand: BrandTokens;
  motion: MotionTokens;
  typography: TypographyTokens;
  spacing: SpacingTokens;
  radii: RadiusTokens;
  minTouchSize: number;
  fontFamilyMono: string;
}

export const brandTokens: BrandTokens = {
  amber: '#e8a33d',
  rust: '#c0562f',
  cream: '#fdfbf7',
  ink: '#24201b',
};

export const motionTokens: MotionTokens = {
  durations: {
    instant: 80,
    fast: 140,
    base: 220,
    slow: 320,
  },
  easing: {
    standard: { x1: 0.2, y1: 0, x2: 0, y2: 1 },
    decelerate: { x1: 0, y1: 0, x2: 0.2, y2: 1 },
    accelerate: { x1: 0.3, y1: 0, x2: 1, y2: 1 },
  },
  pressedScale: 0.97,
  skeletonPulse: {
    durationMs: 1200,
    opacityMin: 0.4,
    opacityMax: 0.8,
    // Well past any load that is going to land (a full board reads in under
    // five seconds on the hosted relay; the capability timeout is ten).
    holdAfterMs: 10_000,
  },
  waitCursorBlink: {
    intervalMs: 600,
    opacityMin: 0.15,
    opacityMax: 1,
  },
  // Design values, tuned by eye on a release build rather than measured: the
  // max is the switching overlay's own scrim opacity, the min keeps the frame
  // underneath dimmed enough never to read as live output.
  swapVeilPulse: {
    durationMs: 1600,
    opacityMin: 0.8,
    opacityMax: 0.92,
  },
};

/** Warm near-black canvas; every neutral below tints toward the brand ink, not gray. */
const BACKGROUND = '#0f0d0a';

/**
 * Body text floors at 14, dense/caption text floors at 12, and nothing goes
 * below 11 without an explicit UI-conventions exception (.claude/rules/ui-conventions.md).
 *
 * The accent family's muted/subtle steps derive from the same background mix
 * the per-project accent overlay uses (projectAccent.ts, 55% and 85% toward
 * the background), so applying the brand amber as a project accent reproduces
 * this exact base family.
 */
export const darkTerminalTheme: Theme = {
  colors: {
    background: BACKGROUND,
    surface: '#16120d',
    surfaceRaised: '#1d1812',
    surfaceOverlay: '#262019',
    border: '#332b21',
    backdrop: 'rgba(0, 0, 0, 0.6)',
    textPrimary: '#f0e9dd',
    textSecondary: '#b5a892',
    textMuted: '#7b7263',
    accent: brandTokens.amber,
    accentMuted: mixHex(brandTokens.amber, BACKGROUND, 0.55),
    accentSubtle: mixHex(brandTokens.amber, BACKGROUND, 0.85),
    onAccent: brandTokens.ink,
    statusNeedsYou: brandTokens.amber,
    statusWorking: '#3ddc84',
    statusIdle: '#7b7263',
    success: '#3ddc84',
    warning: '#d9b83f',
    danger: '#e05d5d',
    /** Danger's tinted fill, mixed the same way accentMuted is, for destructive controls that need a findable surface rather than only red lettering. */
    dangerMuted: mixHex('#e05d5d', BACKGROUND, 0.75),
    conflict: brandTokens.rust,
    info: '#5da9e0',
    // Diff tints are solid dark blends (not alpha overlays) so mono 12px text
    // keeps full contrast regardless of what the row sits on.
    diffAddBackground: '#10291b',
    diffAddText: '#7ee2a8',
    diffRemoveBackground: '#301518',
    diffRemoveText: '#f09a9a',
    codeBackground: '#13100b',
    terminalBackground: '#0c0a07',
  },
  terminalPalette: {
    ansiBlack: '#16120d',
    ansiRed: '#e05d5d',
    ansiGreen: '#3ddc84',
    ansiYellow: '#d9b83f',
    ansiBlue: '#5da9e0',
    ansiMagenta: '#c792ea',
    ansiCyan: '#56c8d8',
    ansiWhite: '#d8cfbf',
    ansiBrightBlack: '#7b7263',
    ansiBrightRed: '#f08a8a',
    ansiBrightGreen: '#7ee2a8',
    ansiBrightYellow: '#ecd47c',
    ansiBrightBlue: '#8cc4ec',
    ansiBrightMagenta: '#dcb8f2',
    ansiBrightCyan: '#8adbe6',
    ansiBrightWhite: '#f0e9dd',
  },
  brand: brandTokens,
  motion: motionTokens,
  typography: {
    body: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
    bodyStrong: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
    caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
    title: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
    heading: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
    // For a value the screen exists to display - today the pairing SAS, which
    // the user compares digit by digit against another screen. `heading` sat
    // 4px and one weight above `title`, which is not a hierarchy: the code and
    // its instruction line read as equals.
    display: { fontSize: 40, lineHeight: 48, fontWeight: '700' },
  },
  spacing: {
    xs: 4,
    sm: 8,
    md: 12,
    lg: 16,
    xl: 24,
    xxl: 32,
  },
  radii: {
    sm: 4,
    md: 8,
    lg: 12,
    full: 999,
  },
  minTouchSize: 44,
  fontFamilyMono: 'monospace',
};
