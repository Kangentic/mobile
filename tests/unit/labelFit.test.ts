import { describe, expect, it } from 'vitest';
import { computeVisibleLabelCount } from '@/components/board/labelFit';

describe('computeVisibleLabelCount', () => {
  it('returns 0 for no labels regardless of available width', () => {
    expect(computeVisibleLabelCount([], 1000)).toBe(0);
    expect(computeVisibleLabelCount([], 0)).toBe(0);
  });

  it('shows every label when they all fit within the available width', () => {
    const labels = ['backend', 'notifications', 'migration', 'breaking-change', 'p0'];
    expect(computeVisibleLabelCount(labels, 500)).toBe(5);
  });

  it('truncates to however many fit, reserving room for the overflow pill', () => {
    const labels = ['backend', 'notifications', 'migration', 'breaking-change', 'p0'];
    // backend(67) + notifications(8+109) = 184 fits under 300. Adding
    // migration (8+81) would reach 273, and 273 plus the reserved overflow
    // pill (8+39) is 320 - past 300, so migration is the one cut.
    expect(computeVisibleLabelCount(labels, 300)).toBe(2);
  });

  it('shows more labels as the available width grows', () => {
    const labels = ['backend', 'notifications', 'migration', 'breaking-change', 'p0'];
    const shownAtNarrow = computeVisibleLabelCount(labels, 200);
    const shownAtWide = computeVisibleLabelCount(labels, 400);
    expect(shownAtWide).toBeGreaterThanOrEqual(shownAtNarrow);
  });

  it('shows nothing but leaves room for the count when the row is too narrow for even one label', () => {
    const labels = ['a-very-long-label-that-does-not-fit'];
    expect(computeVisibleLabelCount(labels, 10)).toBe(0);
  });
});
