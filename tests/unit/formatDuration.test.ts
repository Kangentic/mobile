import { describe, expect, it } from 'vitest';
import { describeDuration, formatDuration } from '@/lib/formatDuration';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe('formatDuration', () => {
  it('renders a sub-hour span as bare minutes', () => {
    expect(formatDuration(12 * MINUTE)).toBe('12m');
  });

  it('renders a whole number of hours without a minutes part', () => {
    expect(formatDuration(4 * HOUR)).toBe('4h');
  });

  it('renders hours and minutes together', () => {
    expect(formatDuration(4 * HOUR + 7 * MINUTE)).toBe('4h 7m');
  });

  it('rounds to the nearest minute rather than truncating', () => {
    expect(formatDuration(90_000)).toBe('2m');
    expect(formatDuration(89_000)).toBe('1m');
  });

  /**
   * The '0m' floor belongs to CompletedTaskScreen's run-summary table, whose
   * cell must always hold a value. A live counter wants nothing at all below a
   * minute, which is WaitLabel's job rather than this function's - pinned here
   * so a future caller does not "fix" this into returning an empty string and
   * blank the summary row.
   */
  it('floors at 0m rather than empty, for the summary table', () => {
    expect(formatDuration(0)).toBe('0m');
    expect(formatDuration(-1)).toBe('0m');
    expect(formatDuration(5_000)).toBe('0m');
  });
});

describe('describeDuration', () => {
  it('spells the span out for a screen reader', () => {
    expect(describeDuration(4 * HOUR + 7 * MINUTE)).toBe('4 hours 7 minutes');
    expect(describeDuration(12 * MINUTE)).toBe('12 minutes');
    expect(describeDuration(4 * HOUR)).toBe('4 hours');
  });

  it('singularises a lone hour and a lone minute', () => {
    expect(describeDuration(HOUR)).toBe('1 hour');
    expect(describeDuration(MINUTE)).toBe('1 minute');
    expect(describeDuration(HOUR + MINUTE)).toBe('1 hour 1 minute');
  });

  it('clamps a negative span rather than saying "-1 minutes"', () => {
    expect(describeDuration(-5 * MINUTE)).toBe('0 minutes');
  });
});
