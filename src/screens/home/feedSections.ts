import type { BoardTaskWire } from '@kangentic/protocol';
import { cardSessionDisplay, toCardSession } from '@/components/board/cardSessionDisplay';
import {
  sectionForEntry,
  selectTaskRespawn,
  type RespawnInFlight,
  type SessionActivityEntry,
  type TriageSection,
} from '@/state/activityStore';
import { sessionlessTaskStatus, type ProjectBoard } from '@/state/boardStore';

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
 * and idle share the Idle title, so they hide together). Derived from the
 * order and the titles above rather than spelled out again, so a section added
 * or renamed there cannot be missing or stale here.
 */
export const FEED_SECTION_DISPLAY_TITLES: readonly string[] = Array.from(
  new Set(FEED_SECTION_ORDER.map((section) => FEED_SECTION_TITLES[section])),
);

/**
 * One card on the feed. Almost always a SESSION (an activity entry, live or a
 * retained ghost). A TASK row is the one exception: a board task the desktop
 * keeps in its `'sessions'` projection with no session on it (protocol 0.16.0,
 * see `sessionlessTaskStatus`) and that no entry claims - a paused task after a
 * cold start, or a first start before its agent exists.
 */
export type FeedRow = { kind: 'session'; entry: SessionActivityEntry } | { kind: 'task'; task: BoardTaskWire; projectId: string };

/** The store slices the feed's sectioning reads. Passed as plain state so the screen, the warm-up and the tests read one shape. */
export interface FeedSectionSources {
  bySessionId: Record<string, SessionActivityEntry>;
  respawnByTaskId: Record<string, RespawnInFlight>;
  spawnProgressLabelBySessionId: Record<string, string>;
  boardsByProjectId: Record<string, ProjectBoard>;
}

export interface FeedSectionRows {
  section: FeedSection;
  rows: FeedRow[];
}

/** The FlashList key: the session id for a session row (unchanged, so a swap's same-slot remount still works), `task-<id>` for a task row. */
export function feedRowKey(row: FeedRow): string {
  return row.kind === 'session' ? row.entry.sessionId : `task-${row.task.id}`;
}

/** The task a session row's card draws, located the way the row itself locates it (by the entry's own project). */
function boardRowForEntry(entry: SessionActivityEntry, sources: FeedSectionSources): BoardTaskWire | null {
  return sources.boardsByProjectId[entry.projectId]?.tasksById[entry.taskId] ?? null;
}

/**
 * Which section a session row sits in: what its CARD says
 * (`cardSessionDisplay`), not its raw `sessionStatus`, so the section and the
 * footer can never disagree.
 *
 * The one judgement is a PREPARING card, because a board row can carry a label
 * and `resumable: true` at once (the desktop counts the suspended row as paused
 * through every respawn gap and every resume's git phase), so "preparing" alone
 * does not say where the row came from:
 *
 * - The session ended INTO a spawn (its `session-ended` carried a label, which
 *   `spawnProgressLabelBySessionId` keeps for good): the row was running, so it
 *   stays in its activity bucket. A model switch never hops sections.
 * - Otherwise the label landed on a PAUSED session (a Resume under way): it
 *   stays in Paused until its successor binds, so a Resume moves the row once.
 */
export function feedSectionForEntry(entry: SessionActivityEntry, sources: FeedSectionSources): FeedSection {
  const task = boardRowForEntry(entry, sources);
  const display = cardSessionDisplay({ session: toCardSession(entry), respawn: selectTaskRespawn(sources, entry.taskId), task });
  const bucket = sectionForEntry(entry);
  switch (display.kind) {
    case 'queued':
      return 'queued';
    case 'suspended':
      return 'paused';
    case 'preparing': {
      if (sources.spawnProgressLabelBySessionId[entry.sessionId] !== undefined) return bucket;
      return entry.sessionStatus === 'suspended' || task?.resumable === true ? 'paused' : bucket;
    }
    case 'exited':
      // An ended row holds the section it ended in for its retention window:
      // a session cancelled out of the queue stays in Queued rather than
      // hopping into Idle on its way out.
      return entry.sessionStatus === 'queued' ? 'queued' : bucket;
    case 'running':
    case 'none':
      return bucket;
  }
}

/**
 * A retained ghost never shares the feed with the live session that replaced
 * it. The reconciler already keeps it so (a retained ghost yields the moment
 * another entry claims its task); this is the backstop that keeps a lapse there
 * from drawing one task twice. Only an ENDED entry is ever dropped, and only
 * for a task a live entry holds: two live entries are two sessions the desktop
 * reported, and hiding one would be guessing. An entry with no known task (an
 * empty `taskId`) is never folded into another.
 */
function withoutShadowedGhosts(entries: SessionActivityEntry[]): SessionActivityEntry[] {
  const liveTaskIds = new Set(entries.filter((entry) => entry.feedStatus !== 'ended' && entry.taskId !== '').map((entry) => entry.taskId));
  return entries.filter((entry) => entry.feedStatus !== 'ended' || !liveTaskIds.has(entry.taskId));
}

/** A row's ordering key: when a session entered its section; for a task row, when the desktop last changed it (a pause, a new label). */
function orderKey(row: FeedRow): number {
  if (row.kind === 'session') return row.entry.enteredSectionAt;
  const updatedAt = Date.parse(row.task.updated_at);
  return Number.isNaN(updatedAt) ? 0 : updatedAt;
}

/**
 * Newest arrival on top, then HOLD that position (see `selectTriageRows`): a
 * row only moves when its section does. Within Idle, unread sessions surface
 * first. Ties fall back to a stable value-based order so nothing depends on
 * object-iteration order.
 */
function compareRows(section: FeedSection): (first: FeedRow, second: FeedRow) => number {
  return (first, second) => {
    if (section === 'idle') {
      const firstHasUnread = first.kind === 'session' && first.entry.unreadCount > 0 ? 1 : 0;
      const secondHasUnread = second.kind === 'session' && second.entry.unreadCount > 0 ? 1 : 0;
      if (firstHasUnread !== secondHasUnread) return secondHasUnread - firstHasUnread;
    }
    const firstKey = orderKey(first);
    const secondKey = orderKey(second);
    if (firstKey !== secondKey) return secondKey - firstKey;
    const firstId = feedRowKey(first);
    const secondId = feedRowKey(second);
    return firstId < secondId ? -1 : firstId > secondId ? 1 : 0;
  };
}

/**
 * Every row on the feed, partitioned into its section and ordered within it.
 * Session rows go where their card puts them (`feedSectionForEntry`); task
 * rows go to Paused when the desktop offers Resume for them, and to Active for
 * a spawn in flight (a first start, which the desktop classes as an active
 * phase).
 */
export function selectFeedSections(sources: FeedSectionSources): FeedSectionRows[] {
  const rowsBySection = new Map<FeedSection, FeedRow[]>(FEED_SECTION_ORDER.map((section) => [section, []]));
  const entries = withoutShadowedGhosts(Object.values(sources.bySessionId));
  const claimedTaskIds = new Set(entries.map((entry) => entry.taskId));
  for (const entry of entries) {
    rowsBySection.get(feedSectionForEntry(entry, sources))?.push({ kind: 'session', entry });
  }
  for (const [projectId, board] of Object.entries(sources.boardsByProjectId)) {
    for (const task of Object.values(board.tasksById)) {
      if (claimedTaskIds.has(task.id)) continue;
      const status = sessionlessTaskStatus(task);
      if (status === null) continue;
      rowsBySection.get(status === 'paused' ? 'paused' : 'working')?.push({ kind: 'task', task, projectId });
    }
  }
  return FEED_SECTION_ORDER.map((section) => ({
    section,
    rows: (rowsBySection.get(section) ?? []).sort(compareRows(section)),
  }));
}

/** How many rows each displayed section holds, by title (Idle sums needs-you and idle). */
export function countFeedSectionsByTitle(sources: FeedSectionSources): Map<string, number> {
  const counts = new Map<string, number>(FEED_SECTION_DISPLAY_TITLES.map((title) => [title, 0]));
  for (const { section, rows } of selectFeedSections(sources)) {
    const title = FEED_SECTION_TITLES[section];
    counts.set(title, (counts.get(title) ?? 0) + rows.length);
  }
  return counts;
}
