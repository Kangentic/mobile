/**
 * The completed task view's formats, ported from the desktop
 * (`format-session.ts`, `format-tokens.ts`, `datetime.ts`). The expected
 * strings are the desktop's own documented outputs, so a drift from the
 * desktop fails here rather than as two screens disagreeing about one task.
 */
import { describe, expect, it } from 'vitest';
import {
  formatCost,
  formatMonthDayTime,
  formatSpan,
  formatSpanCompact,
  formatTimeAgo,
  formatTokenCount,
} from '@/taskReport/format';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('formatSpan', () => {
  it.each([
    [9 * DAY + 9 * HOUR, '9d 9h'],
    [1 * HOUR + 59 * MINUTE, '1h 59m'],
    [37 * MINUTE + 37 * SECOND, '37m 37s'],
    [5 * SECOND, '5s'],
    [16 * DAY, '16d'],
    [20 * MINUTE, '20m'],
    [0, '0s'],
  ])('%i ms reads %s', (milliseconds, expected) => {
    expect(formatSpan(milliseconds)).toBe(expected);
  });

  it('drops seconds rather than rounding them into the minutes, as the desktop does (#905: 3h 5m 51s)', () => {
    expect(formatSpan(3 * HOUR + 5 * MINUTE + 51 * SECOND)).toBe('3h 5m');
  });

  it('never goes negative', () => {
    expect(formatSpan(-5 * SECOND)).toBe('0s');
  });

  it('rounds the seconds before choosing the unit, so 59.6s reads 1m, not 59s', () => {
    expect(formatSpan(59_600)).toBe('1m');
  });
});

describe('formatSpanCompact', () => {
  it('rounds to whole minutes past a minute, so 23m 43s reads 24m', () => {
    expect(formatSpanCompact(23 * MINUTE + 43 * SECOND)).toBe('24m');
  });

  it('rounds before choosing the unit, so 59m 40s reads 1h, never 60m', () => {
    expect(formatSpanCompact(59 * MINUTE + 40 * SECOND)).toBe('1h');
  });

  it('rounds into the day before choosing the unit, so 23h 59m 40s reads 1d, not 23h 59m', () => {
    expect(formatSpanCompact(23 * HOUR + 59 * MINUTE + 40 * SECOND)).toBe('1d');
  });

  it('rounds to whole hours past a day', () => {
    expect(formatSpanCompact(2 * DAY + 3 * HOUR + 40 * MINUTE)).toBe('2d 4h');
  });

  it('keeps seconds under a minute', () => {
    expect(formatSpanCompact(54 * SECOND)).toBe('54s');
  });
});

describe('formatTokenCount', () => {
  it.each([
    [850, '850'],
    [1000, '1k'],
    [1200, '1.2k'],
    [1047, '1k'],
    [200_000, '200k'],
    [1_200_000, '1.2M'],
    [104_900_000, '104.9M'],
    [999_999_999, '1B'],
    [87_378_754_432, '87.4B'],
  ])('%i reads %s', (count, expected) => {
    expect(formatTokenCount(count)).toBe(expected);
  });

  it('moves a value that rounds to 1000 of its unit up a unit, so 999,960 reads 1M', () => {
    expect(formatTokenCount(999_960)).toBe('1M');
  });
});

describe('formatCost', () => {
  it.each([
    [43.42, '$43.42'],
    [1234, '$1,234.00'],
    [0.01, '$0.01'],
    [0.004, '<$0.01'],
    [0, '$0.00'],
    [-1, '$0.00'],
    [Number.NaN, '$0.00'],
  ])('%f reads %s', (usd, expected) => {
    expect(formatCost(usd)).toBe(expected);
  });
});

describe('formatMonthDayTime', () => {
  const now = new Date('2026-10-27T12:00:00.000Z');

  it('leaves the year out for a moment in the current year', () => {
    expect(formatMonthDayTime('2026-07-20T12:00:00.000Z', now)).not.toMatch(/2026/);
  });

  it('adds the year for a moment in another year', () => {
    expect(formatMonthDayTime('2025-07-20T12:00:00.000Z', now)).toMatch(/2025/);
  });

  it('shows the time', () => {
    expect(formatMonthDayTime('2026-07-20T12:00:00.000Z', now)).toMatch(/\d:\d\d/);
  });

  it('reads a missing or unreadable time as empty, never "Invalid Date"', () => {
    expect(formatMonthDayTime(null, now)).toBe('');
    expect(formatMonthDayTime('not a date', now)).toBe('');
  });
});

describe('formatTimeAgo', () => {
  const nowMs = Date.parse('2026-10-27T12:00:00.000Z');
  const ago = (milliseconds: number): string => new Date(nowMs - milliseconds).toISOString();

  it.each([
    [30 * SECOND, 'just now'],
    [1 * MINUTE, '1 minute ago'],
    [37 * MINUTE, '37 minutes ago'],
    [1 * HOUR, '1 hour ago'],
    [2 * HOUR + 59 * MINUTE, '2 hours ago'],
    [1 * DAY, 'yesterday'],
    [4 * DAY, '4 days ago'],
    [8 * DAY, 'last week'],
    [20 * DAY, '2 weeks ago'],
    [45 * DAY, 'last month'],
    [99 * DAY, '3 months ago'],
    [400 * DAY, 'last year'],
    [800 * DAY, '2 years ago'],
  ])('%i ms back reads %s', (milliseconds, expected) => {
    expect(formatTimeAgo(ago(milliseconds), nowMs)).toBe(expected);
  });

  it('reads a missing time as empty', () => {
    expect(formatTimeAgo(null, nowMs)).toBe('');
  });
});
