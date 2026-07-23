import type { SessionUsageWire } from '@kangentic/protocol';
import { isUsageTrusted } from '@/components/ContextUsageBar';

/**
 * isUsageTrusted is a pure predicate, but ContextUsageBar.tsx imports
 * react-native (StyleSheet, View) directly, so the module cannot load under
 * vitest's plain Node environment (no Flow/RN transform there). It loads
 * fine under jest-expo's babel preset, so this lives in the Jest (Component)
 * tier even though nothing here renders.
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

describe('isUsageTrusted', () => {
  it('distrusts a null usage report', () => {
    expect(isUsageTrusted(null)).toBe(false);
  });

  it('distrusts a zero-size context window', () => {
    const usage = buildUsage({ contextWindowSize: 0, usedTokens: 0 });
    expect(isUsageTrusted(usage)).toBe(false);
  });

  it('distrusts a used-token count above the window size', () => {
    const usage = buildUsage({ contextWindowSize: 100, usedTokens: 101 });
    expect(isUsageTrusted(usage)).toBe(false);
  });

  it('trusts a used-token count exactly at the window size', () => {
    const usage = buildUsage({ contextWindowSize: 100, usedTokens: 100 });
    expect(isUsageTrusted(usage)).toBe(true);
  });

  it('trusts a normal in-range usage payload', () => {
    const usage = buildUsage({ contextWindowSize: 200_000, usedTokens: 40_000, usedPercentage: 20 });
    expect(isUsageTrusted(usage)).toBe(true);
  });
});
