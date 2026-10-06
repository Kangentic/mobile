import { selectTriageRows, type SessionActivityEntry, type TriageSection } from '@/state/activityStore';

/**
 * The feed's sections: the activity buckets (`TriageSection`) for running
 * sessions, plus one section each for the two session STATUSES that are not
 * running. Feed-level on purpose: `sectionForEntry` stays a pure function of
 * `entry.state`, which the wait time, the notifier and section re-stamping all
 * read, and none of them should change because a session is queued or paused.
 */
export type FeedSection = TriageSection | 'queued' | 'paused';

// The desktop Agent Monitor's groups (monitor-view-model.ts BUCKET_LABELS), in
// its order: Idle (waiting on you), Active, then the sessions that are not
// running. Running sessions are bucketed by TURN, not presence: Active while a
// turn is in flight, Idle once it ends OR a prompt waits on the user (both are
// the user's move), so prompt cards lead Idle under the shared header. The one
// departure is Queued: the Monitor files queued and paused together under
// Paused; here Queued is its own section and Paused holds only suspended
// sessions, the ones Resume applies to.
export const FEED_SECTION_ORDER: readonly FeedSection[] = ['needs-you', 'idle', 'working', 'queued', 'paused'];
export const FEED_SECTION_TITLES: Record<FeedSection, string> = {
  'needs-you': 'Idle',
  idle: 'Idle',
  working: 'Active',
  queued: 'Queued',
  paused: 'Paused',
};

/**
 * The four sections the user sees, by title, in display order: what the
 * section filter lists, and the keys `hiddenTriageSections` stores (needs-you
 * and idle share the Idle title, so they hide together).
 */
export const FEED_SECTION_DISPLAY_TITLES: readonly string[] = ['Idle', 'Active', 'Queued', 'Paused'];

/**
 * `selectTriageRows` re-partitioned into the feed's sections: queued and
 * suspended sessions leave their activity bucket for Queued and Paused. Order
 * within those two follows the store's own rule, newest arrival first with a
 * stable value-based tiebreak, so neither reshuffles on a re-render.
 */
export function selectFeedSections(bySessionId: Record<string, SessionActivityEntry>): { section: FeedSection; entries: SessionActivityEntry[] }[] {
  const queued: SessionActivityEntry[] = [];
  const paused: SessionActivityEntry[] = [];
  const running = selectTriageRows({ bySessionId }).map(({ section, entries }) => ({
    section: section as FeedSection,
    entries: entries.filter((entry) => {
      if (entry.sessionStatus === 'queued') {
        queued.push(entry);
        return false;
      }
      if (entry.sessionStatus === 'suspended') {
        paused.push(entry);
        return false;
      }
      return true;
    }),
  }));
  const newestFirst = (first: SessionActivityEntry, second: SessionActivityEntry): number =>
    second.enteredSectionAt !== first.enteredSectionAt
      ? second.enteredSectionAt - first.enteredSectionAt
      : first.sessionId < second.sessionId
        ? -1
        : first.sessionId > second.sessionId
          ? 1
          : 0;
  return [...running, { section: 'queued', entries: queued.sort(newestFirst) }, { section: 'paused', entries: paused.sort(newestFirst) }];
}

/** How many sessions each displayed section holds, by title (Idle sums needs-you and idle). */
export function countFeedSectionsByTitle(bySessionId: Record<string, SessionActivityEntry>): Map<string, number> {
  const counts = new Map<string, number>(FEED_SECTION_DISPLAY_TITLES.map((title) => [title, 0]));
  for (const { section, entries } of selectFeedSections(bySessionId)) {
    const title = FEED_SECTION_TITLES[section];
    counts.set(title, (counts.get(title) ?? 0) + entries.length);
  }
  return counts;
}
