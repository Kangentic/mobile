import { create } from 'zustand';
import type {
  ActivityEvent,
  ActivityEventPayload,
  ActivityReasonWire,
  ActivityStateWire,
  ReadStreamResponsePayload,
  SessionUsageWire,
} from '@kangentic/protocol';

export type TriageSection = 'needs-you' | 'working' | 'idle';

export interface SessionActivityEntry {
  sessionId: string;
  taskId: string;
  projectId: string;
  state: ActivityStateWire;
  reason: ActivityReasonWire | null;
  usage: SessionUsageWire | null;
  /** The live outstanding prompt id (permission prompts AND AskUserQuestion/ExitPlanMode pauses), or null. */
  awaitedPromptId: string | null;
  /** The prompt dialog's numbered option labels from the desktop's PTY probe (protocol 0.6.0), or null when unknown. */
  awaitedPromptOptions: string[] | null;
  /**
   * The agent's last message as a ready-to-render line, pushed by the desktop
   * (protocol 0.8.0+), or null when the desktop predates it. Null is what
   * keeps the Home feed's own transcript peek alive as the fallback, so this
   * must never be set to an empty string to mean "nothing to say".
   */
  messagePreview: string | null;
  /** Epoch ms of the last snapshot/event touching this session. */
  lastEventAt: number;
  /**
   * Epoch ms of when this session ENTERED its current triage section. This
   * is the feed's ordering key, deliberately NOT lastEventAt: two agents
   * working at once each bump lastEventAt on every token, so ordering by it
   * made them trade places continuously while the user was trying to read
   * them. A row's position now only changes when its section does.
   */
  enteredSectionAt: number;
  /**
   * Epoch ms of the last EVENT-driven triage-section change (thinking to
   * idle, a prompt arriving), or null. Drives the feed's landing pulse so
   * the eye can track a row that just moved. Snapshot re-applies
   * (reconnect, pull-to-refresh) deliberately never set it: a mass
   * reshuffle should snap silently, not light up the whole feed.
   */
  sectionChangedAt: number | null;
  /** Session events since the last markRead (the triage unread badge). */
  unreadCount: number;
  /**
   * 'pending' until the first snapshot lands; 'rejected' when the desktop
   * refused the stream subscribe; 'ended' when the desktop pushed
   * `session-ended` for a session that WAS live and subscribed.
   *
   * 'rejected' and 'ended' are different events, not synonyms: 'rejected' is a
   * subscribe the desktop refused (the session was already gone when we asked),
   * while 'ended' is a session that died under us. Nothing but a refused
   * subscribe reaches 'rejected', so a live session that exits only ever
   * arrives here as 'ended'. 'ended' is TERMINAL - see markRejected.
   */
  feedStatus: 'pending' | 'live' | 'rejected' | 'ended';
  /**
   * Whether the end was deliberate (a desktop Stop, suspend or shutdown) as
   * opposed to a crash. Null until a `session-ended` event arrives. Kept
   * separate from feedStatus because only an UNINTENTIONAL end is worth a
   * notification - see localNotifier.
   */
  endedIntentionally: boolean | null;
}

interface ActivityStoreState {
  bySessionId: Record<string, SessionActivityEntry>;
  /**
   * Every sessionId the desktop has reported `session-ended` for, kept
   * SEPARATELY from bySessionId because that map is pruned and this fact must
   * outlive the pruning.
   *
   * A session that ends leaves the board's `view: 'sessions'` projection in
   * the very next snapshot (its task has no session_id, so the projection
   * drops the task), and reconcileSessionsFromBoards then deletes the activity
   * entry for any session no board claims - taking `feedStatus: 'ended'` with
   * it a few hundred milliseconds after it was set. A screen bound to that
   * session would see the ended state appear and vanish, which is what the
   * session-ended-state E2E flow caught. Pruning the entry is right (the feed
   * must not keep listing a dead session); losing the fact is not.
   *
   * Grows by one short string per session ended in an app run, in memory only.
   */
  endedSessionIds: Record<string, true>;
  /**
   * The desktop's in-flight spawn-progress label from a `session-ended` push
   * (e.g. "Switching model..."), keyed by the session that ended. Kept
   * SEPARATELY from `bySessionId` for the same reason `endedSessionIds` is:
   * the entry is pruned a few hundred milliseconds after the session ends
   * (reconcileSessionsFromBoards, once the board drops the sessionless task),
   * and this fact must outlive that pruning just as long as `endedSessionIds`
   * does - a screen reading it after the prune is exactly the case this
   * field exists for.
   *
   * Presence means the desktop expects a successor session to land and is
   * naming the phase it is in; absence means either a genuine park or a
   * desktop that predates the field (protocol has no such field yet - see
   * kangentic board task #639). Per that field's own contract, this is
   * INTENT, not a guarantee: a consumer must keep whatever timeout already
   * bounds its own wait for a successor and use presence only to skip a
   * redundant one, never as proof one is coming.
   *
   * Grows by one short string per respawn in an app run, in memory only -
   * same bound as `endedSessionIds`.
   */
  spawnProgressLabelBySessionId: Record<string, string>;
  registerSession: (sessionId: string, taskId: string, projectId: string) => void;
  applySnapshot: (sessionId: string, taskId: string, projectId: string, snapshot: ReadStreamResponsePayload) => void;
  applyActivityEvent: (event: ActivityEvent) => void;
  markRejected: (sessionId: string) => void;
  removeSession: (sessionId: string) => void;
  markRead: (sessionId: string) => void;
  reset: () => void;
}

function emptyEntry(sessionId: string, taskId: string, projectId: string): SessionActivityEntry {
  return {
    sessionId,
    taskId,
    projectId,
    state: 'idle',
    reason: null,
    usage: null,
    awaitedPromptId: null,
    // Populated from protocol 0.6.0's awaitedPromptOptions (snapshot) and
    // permission-event options once the bumped package links; until then
    // the 0.5.x parsers strip the fields and this stays null.
    awaitedPromptOptions: null,
    // Filled by the desktop's message-preview push (protocol 0.8.0+); stays
    // null against an older desktop, which is what keeps the Home feed's own
    // transcript peek as the fallback.
    messagePreview: null,
    lastEventAt: Date.now(),
    enteredSectionAt: Date.now(),
    sectionChangedAt: null,
    unreadCount: 0,
    feedStatus: 'pending',
    endedIntentionally: null,
  };
}

/**
 * Reads a `session-ended` payload's optional `spawnProgressLabel` field
 * without declaring a local parallel type (protocol-types-from-package.md
 * forbids that). The field does not exist in `ActivityEventPayload` until
 * the desktop's protocol package ships it (kangentic board #639), so this is
 * a runtime guard over an UNKNOWN extra property, not a declared shape: `in`
 * narrows to an intersection with `Record<K, unknown>`, and `typeof` narrows
 * that to `string`. Once the package bumps this keeps working unchanged -
 * TypeScript sees the real optional field and the guard is still correct,
 * just redundant.
 */
function extractSpawnProgressLabel(payload: ActivityEventPayload): string | null {
  if (payload.type !== 'session-ended') return null;
  return 'spawnProgressLabel' in payload && typeof payload.spawnProgressLabel === 'string'
    ? payload.spawnProgressLabel
    : null;
}

export const useActivityStore = create<ActivityStoreState>((set) => ({
  bySessionId: {},
  endedSessionIds: {},
  spawnProgressLabelBySessionId: {},

  registerSession: (sessionId, taskId, projectId) =>
    set((state) => {
      const existing = state.bySessionId[sessionId];
      if (existing) {
        if (existing.taskId === taskId && existing.projectId === projectId) return state;
        return { bySessionId: { ...state.bySessionId, [sessionId]: { ...existing, taskId, projectId } } };
      }
      return { bySessionId: { ...state.bySessionId, [sessionId]: emptyEntry(sessionId, taskId, projectId) } };
    }),

  applySnapshot: (sessionId, taskId, projectId, snapshot) =>
    set((state) => {
      const existing = state.bySessionId[sessionId] ?? emptyEntry(sessionId, taskId, projectId);
      const next: SessionActivityEntry = {
        ...existing,
        taskId,
        projectId,
        state: snapshot.activity.state ?? 'idle',
        reason: snapshot.activity.reason,
        usage: snapshot.usage,
        awaitedPromptId: snapshot.awaitedPromptId,
        awaitedPromptOptions: snapshot.awaitedPromptOptions ?? null,
        lastEventAt: Date.now(),
        // 'ended' is TERMINAL, the same invariant markRejected enforces. The
        // desktop pushes session-ended just BEFORE it tears the read-stream
        // registry entry down, so a subscribe already in flight can still
        // succeed inside that window and land here; without this guard it
        // would resurrect a dead session as 'live', and a later refusal would
        // then downgrade it to 'rejected' (markRejected's own guard reads the
        // status this one just corrupted) instead of leaving the real cause
        // of death in place.
        feedStatus: existing.feedStatus === 'ended' ? 'ended' : 'live',
      };
      // Re-subscribes (reconnect, pull-to-refresh) re-deliver a snapshot for
      // every live session at once. Only advance the ordering key when the
      // section actually changed, or the whole feed would reshuffle into
      // snapshot-arrival order on every reconnect.
      if (sectionForEntry(next) !== sectionForEntry(existing)) {
        next.enteredSectionAt = Date.now();
      }
      return { bySessionId: { ...state.bySessionId, [sessionId]: next } };
    }),

  applyActivityEvent: (event) =>
    set((state) => {
      const existing = state.bySessionId[event.sessionId];
      const payload = event.payload;
      // Recorded BEFORE the no-entry bail: a session-ended for a session this
      // phone never registered still tells a screen bound to it (by deep link
      // or push tap) that it is over.
      const endedSessionIds: Record<string, true> =
        payload.type === 'session-ended' ? { ...state.endedSessionIds, [event.sessionId]: true } : state.endedSessionIds;
      // Same reasoning, same timing: a deep-linked or push-tapped screen with
      // no local entry must still learn the desktop's spawn-progress label,
      // not just that the session ended.
      const spawnProgressLabel = extractSpawnProgressLabel(payload);
      const spawnProgressLabelBySessionId: Record<string, string> =
        spawnProgressLabel !== null
          ? { ...state.spawnProgressLabelBySessionId, [event.sessionId]: spawnProgressLabel }
          : state.spawnProgressLabelBySessionId;
      if (!existing) {
        if (endedSessionIds === state.endedSessionIds && spawnProgressLabelBySessionId === state.spawnProgressLabelBySessionId) {
          return state;
        }
        return { endedSessionIds, spawnProgressLabelBySessionId };
      }
      const updated: SessionActivityEntry = { ...existing, lastEventAt: Date.now() };
      switch (payload.type) {
        case 'activity':
          updated.state = payload.state;
          updated.reason = payload.reason;
          // The engine leaving 'permission' means the prompt resolved; the
          // dedicated permission event usually races ahead of this, but a
          // missed one must not leave a stale answerable prompt behind.
          if (payload.state !== 'permission') {
            updated.awaitedPromptId = null;
            updated.awaitedPromptOptions = null;
          }
          break;
        case 'usage':
          updated.usage = payload.usage;
          break;
        case 'event':
          updated.unreadCount = existing.unreadCount + 1;
          break;
        case 'permission':
          updated.awaitedPromptId = payload.pending ? payload.promptId : null;
          // Options belong to THIS prompt: replaced on a new pending prompt
          // (absent = desktop probed nothing), cleared when it resolves.
          updated.awaitedPromptOptions = payload.pending ? (payload.options ?? null) : null;
          if (payload.pending) updated.state = 'permission';
          break;
        // The agent's last message, already collapsed desktop-side (protocol
        // 0.8.0+). It arrives on a feed the app receives anyway, replacing a
        // per-session transcript fetch that cost 2.3-34.6 KB and up to 3.8s
        // to produce this same one line. A pre-0.8.0 desktop sends none, and
        // the Home feed's own peek stays as the fallback.
        case 'message-preview':
          updated.messagePreview = payload.text;
          break;
        // The desktop pushes this immediately before tearing the read-stream
        // subscription down. It was parsed and forwarded but had no case here,
        // so it fell through, bumped lastEventAt and vanished - which is why
        // the 'session-failed' notification could never fire (localNotifier
        // keys on exactly this status) and why the session screen never showed
        // its ended state for a session that died while subscribed.
        case 'session-ended':
          updated.feedStatus = 'ended';
          updated.endedIntentionally = payload.intentional;
          break;
        default: {
          // Exhaustiveness guard. `session-ended` survived two protocol bumps
          // precisely because a silent fall-through was possible here; a new
          // payload type must now fail the build rather than be dropped.
          const unhandled: never = payload;
          void unhandled;
          break;
        }
      }
      if (sectionForEntry(updated) !== sectionForEntry(existing)) {
        updated.sectionChangedAt = Date.now();
        updated.enteredSectionAt = Date.now();
      }
      return {
        bySessionId: { ...state.bySessionId, [event.sessionId]: updated },
        endedSessionIds,
        spawnProgressLabelBySessionId,
      };
    }),

  markRejected: (sessionId) =>
    set((state) => {
      const existing = state.bySessionId[sessionId];
      if (!existing) return state;
      // 'ended' is terminal and outranks 'rejected'. A session that died while
      // subscribed keeps being re-subscribed by the reconciler until a board
      // snapshot drops it, and the desktop refuses each attempt - so without
      // this guard the first refusal would overwrite the real cause of death
      // with the consequence of it.
      if (existing.feedStatus === 'ended') return state;
      return { bySessionId: { ...state.bySessionId, [sessionId]: { ...existing, feedStatus: 'rejected' } } };
    }),

  removeSession: (sessionId) =>
    set((state) => {
      if (!(sessionId in state.bySessionId)) return state;
      const bySessionId = { ...state.bySessionId };
      delete bySessionId[sessionId];
      return { bySessionId };
    }),

  markRead: (sessionId) =>
    set((state) => {
      const existing = state.bySessionId[sessionId];
      if (!existing || existing.unreadCount === 0) return state;
      return { bySessionId: { ...state.bySessionId, [sessionId]: { ...existing, unreadCount: 0 } } };
    }),

  reset: () => set({ bySessionId: {}, endedSessionIds: {}, spawnProgressLabelBySessionId: {} }),
}));

/**
 * Whether the desktop has reported this session as over. Survives the activity
 * entry's pruning, so a screen bound to the session keeps its ended state
 * after the board projection drops the task. See `endedSessionIds`.
 */
export function selectSessionEnded(state: { endedSessionIds: Record<string, true> }, sessionId: string | null): boolean {
  return sessionId !== null && state.endedSessionIds[sessionId] === true;
}

/**
 * The desktop's in-flight spawn-progress label for a session that just
 * ended, or null if the desktop sent none (a genuine park, or a desktop
 * that predates the field). Survives the activity entry's pruning the same
 * way `selectSessionEnded` does - see `spawnProgressLabelBySessionId`.
 */
export function selectSessionSpawnProgressLabel(
  state: { spawnProgressLabelBySessionId: Record<string, string> },
  sessionId: string | null,
): string | null {
  if (sessionId === null) return null;
  return state.spawnProgressLabelBySessionId[sessionId] ?? null;
}

/**
 * The triage bucketing: 'permission' needs the user (covers permission
 * prompts and AskUserQuestion/ExitPlanMode pauses), 'thinking' is working,
 * 'idle' is idle. An idle-after-work promotion into needs-you is
 * deliberately NOT encoded here yet; it is expressible later as
 * `state === 'idle' && unreadCount > 0` without a store change.
 */
export function sectionForEntry(entry: SessionActivityEntry): TriageSection {
  switch (entry.state) {
    case 'permission':
      return 'needs-you';
    case 'thinking':
      return 'working';
    case 'idle':
      return 'idle';
  }
}

export interface TriageRows {
  section: TriageSection;
  entries: SessionActivityEntry[];
}

const TRIAGE_SECTION_ORDER: readonly TriageSection[] = ['needs-you', 'working', 'idle'];

/** Pure selector for `useActivityStore((state) => selectTriageRows(state))`-style reactive reads. */
export function selectTriageRows(state: { bySessionId: Record<string, SessionActivityEntry> }): TriageRows[] {
  const entries = Object.values(state.bySessionId);
  return TRIAGE_SECTION_ORDER.map((section) => ({
    section,
    entries: entries
      .filter((entry) => sectionForEntry(entry) === section)
      .sort((first, second) => {
        // Within Idle, unread sessions surface first (finished work the user
        // has not seen outranks quiet idles).
        if (section === 'idle') {
          const firstHasUnread = first.unreadCount > 0 ? 1 : 0;
          const secondHasUnread = second.unreadCount > 0 ? 1 : 0;
          if (firstHasUnread !== secondHasUnread) return secondHasUnread - firstHasUnread;
        }
        // Newest arrival on top, then HOLD that position. Ordering by
        // lastEventAt made two concurrently-working agents swap places on
        // every streamed token, so a feed the user was reading rearranged
        // itself continuously. enteredSectionAt only moves when the row
        // moves sections, which is a change worth re-ranking for.
        if (second.enteredSectionAt !== first.enteredSectionAt) {
          return second.enteredSectionAt - first.enteredSectionAt;
        }
        // Same millisecond (a batch of snapshots on reconnect): fall back to
        // a stable, value-based tiebreak so the order never depends on
        // object-iteration order.
        return first.sessionId < second.sessionId ? -1 : first.sessionId > second.sessionId ? 1 : 0;
      }),
  }));
}
