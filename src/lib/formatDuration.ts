/**
 * A span of time as a compact label: '12m', '3h', '3h 5m'.
 *
 * Deliberately takes a DURATION rather than a timestamp, so it stays pure and
 * the caller owns the clock (the same split `relativeTimeLabel` makes, and the
 * reason `Date.now()` never appears in a render path here).
 *
 * The `<= 0` case returns '0m' rather than an empty string because
 * `CompletedTaskScreen`'s run summary is a table that must always have a value
 * in the cell. A LIVE counter wants the opposite - nothing at all until the
 * span is worth reporting - so that floor belongs to the caller, not here:
 * `WaitLabel` renders null below a minute instead of asking this to.
 */
export function formatDuration(milliseconds: number): string {
  if (milliseconds <= 0) return '0m';
  const totalMinutes = Math.round(milliseconds / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/**
 * The same span spoken in full, for an accessibility label. '4h 7m' read aloud
 * says nothing useful, and `ui-copy-brevity.md` exempts a11y labels from the
 * brevity rule precisely so they can be explicit.
 */
export function describeDuration(milliseconds: number): string {
  const totalMinutes = Math.max(0, Math.round(milliseconds / 60000));
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const hourPart = hours === 1 ? '1 hour' : `${hours} hours`;
  const minutePart = minutes === 1 ? '1 minute' : `${minutes} minutes`;
  if (hours === 0) return minutePart;
  return minutes === 0 ? hourPart : `${hourPart} ${minutePart}`;
}
