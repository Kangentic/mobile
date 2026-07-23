/** Recency, long form: 'just now', then minutes/hours/days ago. */
export function relativeTimeLabel(epochMs: number, nowMs: number): string {
  const elapsedMs = Math.max(0, nowMs - epochMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}
