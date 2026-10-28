/**
 * The completed task view's number and date formats, ported from the desktop
 * so the phone and the desktop print the same figure for the same task:
 * `formatSpan`, `formatSpanCompact` and `formatCost` from the desktop's
 * `renderer/utils/format-session.ts`, `formatTokenCount` from
 * `renderer/utils/format-tokens.ts`, and `formatMonthDayTime` and
 * `formatTimeAgo` from `renderer/lib/datetime.ts`.
 *
 * `src/lib/formatDuration.ts` is not reused for the spans: it rounds to whole
 * minutes and never prints days or seconds ("26h 5m"), where the desktop's
 * `formatSpan` keeps its two largest units and truncates ("1d 2h", "37m 37s").
 *
 * Two departures, both forced. The desktop's strings go through its Lingui
 * catalog and this app has none, so they are English. And `formatTimeAgo`
 * spells out what `Intl.RelativeTimeFormat` with `numeric: 'auto'` prints in
 * English rather than calling it, because Hermes' Intl support does not
 * reliably include RelativeTimeFormat.
 */

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** "9d 9h", "1h 59m", "37m 37s", "5s": the two largest units, a zero second one dropped ("16d", "20m"). */
export function formatSpan(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.round(milliseconds / SECOND_MS));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const pair = (first: string, second: number, unit: string): string => (second > 0 ? `${first} ${second}${unit}` : first);
  if (days > 0) return pair(`${days}d`, hours, 'h');
  if (hours > 0) return pair(`${hours}h`, minutes, 'm');
  if (minutes > 0) return pair(`${minutes}m`, seconds, 's');
  return `${seconds}s`;
}

/**
 * A span sized for a route row: whole minutes once it passes one ("24m" for
 * 23m 43s), whole hours past a day, otherwise as `formatSpan` reads it.
 */
export function formatSpanCompact(milliseconds: number): string {
  // Rounded before the unit is chosen, so 59m 40s reads "1h", never "60m".
  if (milliseconds >= MINUTE_MS && milliseconds < DAY_MS) return formatSpan(Math.round(milliseconds / MINUTE_MS) * MINUTE_MS);
  if (milliseconds >= DAY_MS) return formatSpan(Math.round(milliseconds / HOUR_MS) * HOUR_MS);
  return formatSpan(milliseconds);
}

/** "$43.42", "$1,234.00"; a sub-cent cost reads "<$0.01" rather than looking free. */
export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) return '$0.00';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Compact units, largest first. */
const TOKEN_UNITS: readonly { size: number; suffix: string }[] = [
  { size: 1_000_000_000_000, suffix: 'T' },
  { size: 1_000_000_000, suffix: 'B' },
  { size: 1_000_000, suffix: 'M' },
  { size: 1000, suffix: 'k' },
];

/**
 * A count for compact display, one decimal with a trailing .0 dropped: 850
 * "850", 1200 "1.2k", 200000 "200k", 1200000 "1.2M". A value that rounds up
 * to 1000 of its unit moves to the next one, so 999,960 reads "1M", not
 * "1000k". The desktop prints token totals and line counts with it.
 */
export function formatTokenCount(count: number): string {
  if (count < 1000) return String(count);
  for (let index = 0; index < TOKEN_UNITS.length; index++) {
    const unit = TOKEN_UNITS[index];
    if (count < unit.size) continue;
    const scaled = (count / unit.size).toFixed(1);
    const larger = TOKEN_UNITS[index - 1];
    if (larger && Number(scaled) >= 1000) {
      const promoted = (count / larger.size).toFixed(1);
      return `${promoted.endsWith('.0') ? promoted.slice(0, -2) : promoted}${larger.suffix}`;
    }
    return `${scaled.endsWith('.0') ? scaled.slice(0, -2) : scaled}${unit.suffix}`;
  }
  return String(count);
}

function toDate(value: string | null): Date | null {
  if (value === null) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "Oct 12, 11:04 PM", with the year when it is not the current one. Empty for a missing or unreadable time. */
export function formatMonthDayTime(value: string | null, now: Date = new Date()): string {
  const date = toDate(value);
  if (date === null) return '';
  const year = date.getFullYear() === now.getFullYear() ? undefined : 'numeric';
  return date.toLocaleString(undefined, { year, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

type RelativeUnit = 'year' | 'month' | 'week' | 'day' | 'hour' | 'minute';

const RELATIVE_UNITS: readonly { unit: RelativeUnit; unitMs: number }[] = [
  { unit: 'year', unitMs: 365 * DAY_MS },
  { unit: 'month', unitMs: 30 * DAY_MS },
  { unit: 'week', unitMs: 7 * DAY_MS },
  { unit: 'day', unitMs: DAY_MS },
  { unit: 'hour', unitMs: HOUR_MS },
  { unit: 'minute', unitMs: MINUTE_MS },
];

/** What `Intl.RelativeTimeFormat('en', { numeric: 'auto' })` prints for one unit back. */
const ONE_BACK: Readonly<Record<RelativeUnit, string>> = {
  year: 'last year',
  month: 'last month',
  week: 'last week',
  day: 'yesterday',
  hour: '1 hour ago',
  minute: '1 minute ago',
};

/**
 * How long before `now` a moment was: "just now" under a minute, then "37
 * minutes ago", "2 hours ago", "yesterday", "last week", "3 months ago". Whole
 * units, rounded down, so a label never runs ahead of the clock. Empty for a
 * missing or unreadable time.
 */
export function formatTimeAgo(value: string | null, nowMs: number = Date.now()): string {
  const date = toDate(value);
  if (date === null) return '';
  const elapsedMs = nowMs - date.getTime();
  if (elapsedMs < MINUTE_MS) return 'just now';
  for (const { unit, unitMs } of RELATIVE_UNITS) {
    if (elapsedMs < unitMs) continue;
    const count = Math.floor(elapsedMs / unitMs);
    return count === 1 ? ONE_BACK[unit] : `${count} ${unit}s ago`;
  }
  return '';
}
