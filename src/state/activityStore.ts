import { create } from 'zustand';
import type {
  ActivityEvent,
  ActivityEventPayload,
  ActivityReasonWire,
  ActivityStateWire,
  ReadStreamResponsePayload,
  ReadStreamSessionStatusWire,
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
  /**
   * The desktop's lifecycle status for this session AS OF THE LAST SNAPSHOT,
   * or null when no snapshot has landed yet.
   *
   * `null` and `'running'` are NOT synonyms. Null means this entry has only
   * been registered, never snapshotted (it is still `feedStatus: 'pending'`).
   * `'running'` means a snapshot DID land and either said so or omitted the
   * field, which is the fallback the protocol mandates for pre-0.5.0 desktops.
   *
   * NOT AN ENDEDNESS SIGNAL, and this is the load-bearing part. `feedStatus`
   * and `endedSessionIds` are the authority on whether a session is over; this
   * is a snapshot-time observation that goes stale between snapshots. An entry
   * that snapshots 'suspended' and then receives `session-ended` keeps the
   * stale 'suspended' - correct, not a bug to fix by writing 'exited' here,
   * which would give two fields authority over one fact.
   *
   * THE ONE EXCEPTION IS A RESUME, and it is a liveness correction rather than
   * an endedness one. `applyActivityEvent` clears a stale 'suspended' when an
   * `activity` event reports 'thinking', because a thinking session is by
   * definition not parked. Without that, staleness is unbounded in the one
   * direction that costs a notification: `sessionStatus` is written only by
   * `applySnapshot`, a snapshot lands only on a fresh `read-stream` subscribe,
   * and `setDesiredStreams` skips ids already in `activeStreamIds` - so a
   * session observed suspended and then resumed on the same established
   * channel would keep suppressing `localNotifier`'s "Agent went idle" for the
   * rest of that connection. Only 'thinking' clears, and only from 'suspended':
   * the settle arms on a thinking -> idle edge, so that is exactly the reach of
   * the gap and nothing wider.
   *
   * Nothing on the session screen may read it. `SessionScreen`'s `sessionEnded`
   * is balanced against the spawn-label swap latch, and a fourth input re-opens
   * the mid-respawn "Session ended" flash that latch exists to prevent. The
   * same applies to 'exited': the protocol calls it a snapshot racing teardown,
   * so routing it into `endedSessionIds` would flash the ended state in exactly
   * the gap the latch covers. The `session-ended` PUSH stays the sole
   * authority, because it carries `intentional`, which a snapshot cannot.
   */
  sessionStatus: ReadStreamSessionStatusWire | null;
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
   * desktop that predates the field (protocol 0.14.0, kangentic board task
   * #639). Per that field's own contract, this is
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
    // Null, never 'running': no snapshot has landed for a freshly registered
    // session, and the two must stay distinguishable - see the field's docs.
    sessionStatus: null,
  };
}

/**
 * Reads a `session-ended` payload's optional `spawnProgressLabel` field
 * (protocol 0.14.0+), normalising "absent" to null so callers have one empty
 * case rather than two. Absent from a pre-0.14.0 desktop, and never sent as
 * null, so the two are the same fact here: no respawn was in flight.
 *
 * The `typeof` check is kept now that the field is DECLARED, and is not
 * redundant with the type. It is the runtime floor under a render crash: a
 * non-string reaching `SessionSwitchingState`'s `renderableLabel` would call
 * `.trim()` on it and throw. The wire path cannot deliver one today
 * (`feedRouter` gates on `isBridgeEvent`, which validates through
 * `parseActivityEventPayload` and drops the whole event on a non-string), so
 * this guards against a future producer that skips that gate, not against the
 * desktop.
 *
 * Exported only so the rig tests that assert on a produced `session-ended`
 * read it through the SAME guard the store applies, instead of hand-copying
 * these two lines and calling the copy "kept in step" when nothing keeps it so.
 */
export function extractSpawnProgressLabel(payload: ActivityEventPayload): string | null {
  if (payload.type !== 'session-ended') return null;
  return typeof payload.spawnProgressLabel === 'string' ? payload.spawnProgressLabel : null;
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
        // 'running' is the protocol's own stated fallback for a desktop that
        // predates the field (pre-0.5.0), not a guess.
        sessionStatus: snapshot.sessionStatus ?? 'running',
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
          // A thinking session is not parked, so this retires a 'suspended'
          // that no later snapshot would ever correct - see the field's docs.
          // Narrow on purpose: only 'suspended' is overwritten, so 'exited'
          // and the null "never snapshotted" case are left exactly as they
          // were, and the snapshot stays the authority on everything else.
          if (payload.state === 'thinking' && existing.sessionStatus === 'suspended') {
            updated.sessionStatus = 'running';
          }
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

/**
 * When this session first needed the user, as epoch ms, or null if it is not
 * waiting on one. The Home feed's "how long has this been sitting" label.
 *
 * Three things here are load-bearing and each has bitten, or would have:
 *
 * 1. WHETHER to show is gated on `sectionForEntry`, never on `reason.kind`.
 *    `applyActivityEvent`'s 'permission' branch sets `state` without writing
 *    `reason`, so a session that genuinely needs the user can be carrying a
 *    stale `{kind:'turn-active'}` reason from the turn that led into it.
 *
 * 2. `feedStatus` must be 'live', not merely 'not ended'. `registerSession`
 *    stamps `enteredSectionAt` when the board first names a session, BEFORE
 *    any snapshot lands, and `applySnapshot` defaults to `state ?? 'idle'`.
 *    So a 'pending' (subscribe in flight) or 'rejected' entry sits at
 *    `state: 'idle'` with a running clock, and would claim "1m" a minute into
 *    a cold start for a session this phone never actually subscribed to.
 *
 * 3. `reason.since` is the real answer and `enteredSectionAt` only a fallback
 *    for a desktop that sends none. The fallback UNDER-REPORTS, in two ways
 *    that matter: it re-stamps on the permission <-> idle crossing (the exact
 *    crossing `since` exists to span without resetting), and again on every
 *    `registerSession` after a reconnect, so a four-hour wait reads 0m on a
 *    cold launch. It is a degradation, not a simplification of the primary.
 */
export function selectWaitingSince(entry: SessionActivityEntry): number | null {
  if (entry.feedStatus !== 'live') return null;
  if (sectionForEntry(entry) === 'working') return null;
  const reason = entry.reason;
  if (reason !== null && (reason.kind === 'idle' || reason.kind === 'permission') && typeof reason.since === 'number') {
    return reason.since;
  }
  return entry.enteredSectionAt;
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
