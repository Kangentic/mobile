import { describe, expect, it } from 'vitest';
import { relativeTimeLabel } from '@/lib/relativeTime';

describe('relativeTimeLabel', () => {
  it('reads as "just now" at zero elapsed time', () => {
    expect(relativeTimeLabel(1_000, 1_000)).toBe('just now');
  });

  it('still reads as "just now" one millisecond under a minute', () => {
    expect(relativeTimeLabel(0, 59_999)).toBe('just now');
  });

  it('rolls over to "1 min ago" at exactly one minute', () => {
    expect(relativeTimeLabel(0, 60_000)).toBe('1 min ago');
  });

  it('reads "59 min ago" one minute short of an hour', () => {
    expect(relativeTimeLabel(0, 59 * 60_000)).toBe('59 min ago');
  });

  it('rolls over to "1 hr ago" at exactly one hour', () => {
    expect(relativeTimeLabel(0, 3_600_000)).toBe('1 hr ago');
  });

  it('reads "23 hr ago" one hour short of a day', () => {
    expect(relativeTimeLabel(0, 23 * 3_600_000)).toBe('23 hr ago');
  });

  it('rolls over to the singular "1 day ago" at exactly one day', () => {
    expect(relativeTimeLabel(0, 86_400_000)).toBe('1 day ago');
  });

  it('uses the plural "days ago" from two days onward', () => {
    expect(relativeTimeLabel(0, 2 * 86_400_000)).toBe('2 days ago');
  });

  it('clamps a future timestamp to "just now" instead of a negative elapsed time', () => {
    expect(relativeTimeLabel(60_000, 0)).toBe('just now');
  });
});
