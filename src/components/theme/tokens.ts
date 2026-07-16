export interface ColorTokens {
  background: string;
  surface: string;
  surfaceRaised: string;
  border: string;
  backdrop: string;
  textPrimary: string;
  textSecondary: string;
  textMuted: string;
  accent: string;
  accentMuted: string;
  statusNeedsYou: string;
  statusWorking: string;
  statusIdle: string;
  success: string;
  warning: string;
  danger: string;
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
}

export interface Theme {
  colors: ColorTokens;
  terminalPalette: TerminalPalette;
  typography: TypographyTokens;
  spacing: SpacingTokens;
  radii: RadiusTokens;
  minTouchSize: number;
  fontFamilyMono: string;
}

/**
 * Body text floors at 14, dense/caption text floors at 12, and nothing goes
 * below 11 without an explicit UI-conventions exception (.claude/rules/ui-conventions.md).
 */
export const darkTerminalTheme: Theme = {
  colors: {
    background: '#0b0e0c',
    surface: '#121613',
    surfaceRaised: '#181d19',
    border: '#26302a',
    backdrop: 'rgba(0, 0, 0, 0.6)',
    textPrimary: '#e6f2ea',
    textSecondary: '#9fb3a6',
    textMuted: '#647268',
    accent: '#3ddc84',
    accentMuted: '#1f6b45',
    statusNeedsYou: '#f2a33d',
    statusWorking: '#3ddc84',
    statusIdle: '#647268',
    success: '#3ddc84',
    warning: '#f2a33d',
    danger: '#e05d5d',
    // Diff tints are solid dark blends (not alpha overlays) so mono 12px text
    // keeps full contrast regardless of what the row sits on.
    diffAddBackground: '#10291b',
    diffAddText: '#7ee2a8',
    diffRemoveBackground: '#301518',
    diffRemoveText: '#f09a9a',
    codeBackground: '#0f1310',
    terminalBackground: '#090b0a',
  },
  terminalPalette: {
    ansiBlack: '#121613',
    ansiRed: '#e05d5d',
    ansiGreen: '#3ddc84',
    ansiYellow: '#f2a33d',
    ansiBlue: '#5da9e0',
    ansiMagenta: '#c792ea',
    ansiCyan: '#56c8d8',
    ansiWhite: '#c9d8cf',
    ansiBrightBlack: '#647268',
    ansiBrightRed: '#f08a8a',
    ansiBrightGreen: '#7ee2a8',
    ansiBrightYellow: '#f7c377',
    ansiBrightBlue: '#8cc4ec',
    ansiBrightMagenta: '#dcb8f2',
    ansiBrightCyan: '#8adbe6',
    ansiBrightWhite: '#e6f2ea',
  },
  typography: {
    body: { fontSize: 14, lineHeight: 20, fontWeight: '400' },
    bodyStrong: { fontSize: 14, lineHeight: 20, fontWeight: '600' },
    caption: { fontSize: 12, lineHeight: 16, fontWeight: '400' },
    title: { fontSize: 18, lineHeight: 24, fontWeight: '600' },
    heading: { fontSize: 22, lineHeight: 28, fontWeight: '700' },
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
  },
  minTouchSize: 44,
  fontFamilyMono: 'monospace',
};
