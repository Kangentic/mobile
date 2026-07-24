import type { SessionUsageWire } from '@kangentic/protocol';
import { StyleSheet } from 'react-native';
import { render, screen } from '@testing-library/react-native';
import { ContextUsageBar, isContextWindowKnown, ThemeProvider, darkTerminalTheme } from '@/components';
// contextUsageColor and contextWindowDisplayPercent are internal to the bar -
// nothing outside it consumes them, so they stay off the design-system barrel
// and are imported directly here rather than widening the public surface.
import { contextUsageColor, contextWindowDisplayPercent } from '@/components/ContextUsageBar';

/**
 * These are pure predicates, but ContextUsageBar.tsx imports react-native
 * (StyleSheet, View) directly, so the module cannot load under vitest's
 * plain Node environment (no Flow/RN transform there). It loads fine under
 * jest-expo's babel preset, so this lives in the Jest (Component) tier even
 * though most of it does not render.
 */
function buildUsage(overrides: Partial<SessionUsageWire['contextWindow']>): SessionUsageWire {
  return {
    contextWindow: {
      usedPercentage: 0,
      usedTokens: 0,
      cacheTokens: 0,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      contextWindowSize: 0,
      ...overrides,
    },
    cost: { totalCostUsd: 0, totalDurationMs: 0 },
    model: { id: 'claude-fable-5', displayName: 'Claude Fable 5' },
  };
}

describe('isContextWindowKnown', () => {
  it('is false for a null usage report', () => {
    expect(isContextWindowKnown(null)).toBe(false);
  });

  it('is false for a zero-size context window - the unknown-size sentinel', () => {
    const usage = buildUsage({ contextWindowSize: 0, usedTokens: 0 });
    expect(isContextWindowKnown(usage)).toBe(false);
  });

  it('is true for a used-token count above the window size - an over-budget critical state, not bad data', () => {
    const usage = buildUsage({ contextWindowSize: 100, usedTokens: 101 });
    expect(isContextWindowKnown(usage)).toBe(true);
  });

  it('is true for a used-token count exactly at the window size', () => {
    const usage = buildUsage({ contextWindowSize: 100, usedTokens: 100 });
    expect(isContextWindowKnown(usage)).toBe(true);
  });

  it('is true for a normal in-range usage payload', () => {
    const usage = buildUsage({ contextWindowSize: 200_000, usedTokens: 40_000, usedPercentage: 20 });
    expect(isContextWindowKnown(usage)).toBe(true);
  });
});

describe('contextWindowDisplayPercent', () => {
  it('clamps an over-budget window to 100 regardless of the reported percentage', () => {
    // The case that proves parity: usedPercentage reads 92, but usedTokens
    // exceeds the window, so the desktop-parity display is 100, not 92.
    const usage = buildUsage({ contextWindowSize: 200_000, usedTokens: 210_000, usedPercentage: 92 });
    expect(contextWindowDisplayPercent(usage)).toBe(100);
  });

  it('caps an in-window over-100 percentage at 100', () => {
    const usage = buildUsage({ contextWindowSize: 200_000, usedTokens: 190_000, usedPercentage: 105 });
    expect(contextWindowDisplayPercent(usage)).toBe(100);
  });

  it('rounds a normal in-range percentage', () => {
    const usage = buildUsage({ contextWindowSize: 200_000, usedTokens: 40_000, usedPercentage: 20.4 });
    expect(contextWindowDisplayPercent(usage)).toBe(20);
  });

  it('rounds half-up rather than flooring or truncating - 20.6 must read as 21, not 20', () => {
    // Kills a Math.round -> Math.floor/Math.trunc mutation: both would leave
    // this at 20 and stay green against the 20.4 case above.
    const usage = buildUsage({ contextWindowSize: 200_000, usedTokens: 41_200, usedPercentage: 20.6 });
    expect(contextWindowDisplayPercent(usage)).toBe(21);
  });

  it('returns 0 for an unknown (zero-size) window even when usedPercentage alone would read as full - the early-return guard, not the over-budget branch', () => {
    // Kills a deletion of the `if (!isContextWindowKnown(usage)) return 0;`
    // guard: without it, execution falls through past the already-guarded
    // isContextWindowOverBudget check to the cap branch, and
    // Math.min(100, Math.round(100)) wrongly returns 100 instead of 0.
    const usage = buildUsage({ contextWindowSize: 0, usedTokens: 5000, usedPercentage: 100 });
    expect(contextWindowDisplayPercent(usage)).toBe(0);
  });
});

describe('contextUsageColor', () => {
  const { colors } = darkTerminalTheme;

  it('is statusWorking just below the warning boundary and warning at it (69 vs 70)', () => {
    // Pins the strict >= 70 boundary. Flipping it to > 70 would turn 70 green
    // instead of yellow while leaving every other case in this file green.
    expect(contextUsageColor(darkTerminalTheme, 69)).toBe(colors.statusWorking);
    expect(contextUsageColor(darkTerminalTheme, 70)).toBe(colors.warning);
  });

  it('is warning just below the danger boundary and danger at it (89 vs 90)', () => {
    // Pins the strict >= 90 boundary: 90% must read as critical, not an
    // ambiguous mid-ramp hue.
    expect(contextUsageColor(darkTerminalTheme, 89)).toBe(colors.warning);
    expect(contextUsageColor(darkTerminalTheme, 90)).toBe(colors.danger);
  });

  it('is statusWorking at the 0 endpoint and danger at the 100 endpoint', () => {
    expect(contextUsageColor(darkTerminalTheme, 0)).toBe(colors.statusWorking);
    expect(contextUsageColor(darkTerminalTheme, 100)).toBe(colors.danger);
  });

  it('stays danger for an over-budget percentage above 100', () => {
    expect(contextUsageColor(darkTerminalTheme, 150)).toBe(colors.danger);
  });

  it('falls back to statusWorking for a negative percentage', () => {
    expect(contextUsageColor(darkTerminalTheme, -5)).toBe(colors.statusWorking);
  });

  it('falls back to statusWorking for NaN rather than an unmapped value', () => {
    expect(contextUsageColor(darkTerminalTheme, NaN)).toBe(colors.statusWorking);
  });

  it('only ever returns one of the three known tokens across the full 0-100 range', () => {
    // The assertion a future retune-to-a-gradient cannot pass: exactly 3
    // distinct values across 0-100, each a known token, never a blend.
    const seen = new Set<string>();
    for (let usedPercentage = 0; usedPercentage <= 100; usedPercentage++) {
      const color = contextUsageColor(darkTerminalTheme, usedPercentage);
      expect([colors.statusWorking, colors.warning, colors.danger]).toContain(color);
      seen.add(color);
    }
    expect(seen.size).toBe(3);
  });
});

describe('ContextUsageBar', () => {
  it('renders a full critical bar for an over-budget usage report instead of hiding it', () => {
    const usage = buildUsage({ contextWindowSize: 200_000, usedTokens: 210_000, usedPercentage: 92 });
    render(
      <ThemeProvider>
        <ContextUsageBar usage={usage} testID="usage-bar" />
      </ThemeProvider>,
    );

    expect(screen.getByTestId('usage-bar')).toBeTruthy();
    expect(screen.getByText('100%')).toBeTruthy();
  });

  it('renders nothing for a null usage report', () => {
    render(
      <ThemeProvider>
        <ContextUsageBar usage={null} testID="usage-bar" />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('usage-bar')).toBeNull();
  });

  it('renders nothing for a zero-size (unknown) context window - the render guard, not just the pure predicate', () => {
    const usage = buildUsage({ contextWindowSize: 0, usedTokens: 0 });
    render(
      <ThemeProvider>
        <ContextUsageBar usage={usage} testID="usage-bar" />
      </ThemeProvider>,
    );

    expect(screen.queryByTestId('usage-bar')).toBeNull();
  });

  it('sets the fill width and color to danger for an over-budget usage report', () => {
    // Kills both a hardcoded fill width (replacing `${usedPercentage}%`) and
    // a fixed contextUsageColor token: this over-budget case must land on
    // 100% / danger.
    const usage = buildUsage({ contextWindowSize: 200_000, usedTokens: 210_000, usedPercentage: 92 });
    render(
      <ThemeProvider>
        <ContextUsageBar usage={usage} testID="usage-bar" />
      </ThemeProvider>,
    );

    const fillStyle = StyleSheet.flatten(screen.getByTestId('usage-bar-fill').props.style);
    expect(fillStyle.width).toBe('100%');
    expect(fillStyle.backgroundColor).toBe(darkTerminalTheme.colors.danger);
  });

  it('sets the fill width and color to statusWorking for a normal in-range usage report', () => {
    // The complementary case: proves the width/color track the actual
    // percentage rather than always landing on the over-budget values above.
    const usage = buildUsage({ contextWindowSize: 200_000, usedTokens: 40_000, usedPercentage: 20 });
    render(
      <ThemeProvider>
        <ContextUsageBar usage={usage} testID="usage-bar" />
      </ThemeProvider>,
    );

    const fillStyle = StyleSheet.flatten(screen.getByTestId('usage-bar-fill').props.style);
    expect(fillStyle.width).toBe('20%');
    expect(fillStyle.backgroundColor).toBe(darkTerminalTheme.colors.statusWorking);
  });
});
