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

/**
 * How long a task whose session ended WITH a spawn-progress label keeps its
 * Home feed row and its board-card status glyph.
 *
 * Deliberately the same 20s as `SESSION_SWAP_GRACE_MS` in
 * `src/screens/task/SessionScreen.tsx`, so a user glancing between the feed and
 * the session screen sees one window rather than two. Kept as a second constant
 * agreeing by documented convention rather than moved: that one lives in the
 * file `tests/components/SessionScreen.session-swap.test.tsx` renders, and the
 * two rigs already couple their respawn gaps the same way (see
 * `scripts/stubDesktopPeer.mjs`'s STUB_RESPAWN_GAP_MS).
 * `tests/unit/sessionRespawnGapTiming.test.ts` pins the equality.
 *
 * The desktop's label is INTENT, not a guarantee that a successor is coming, so
 * this bound is not optional - without it a respawn that dies leaves a row
 * wearing the starting glyph forever.
 */
export const RESPAWN_ROW_GRACE_MS = 20_000;

/**
 * How long a task whose session ended WITHOUT a label keeps the same row and
 * glyph. Shorter than the labelled window, because at arrival the phone
 * cannot tell this end apart from a genuine park: the desktop's own
 * column-move swap arrives unlabelled (the suspend-then-resume shape), and so
 * does a Stop. Retaining both for a short span is what keeps the row from
 * vanishing and reappearing on every column move; the bound is what keeps a
 * park from lingering. Equal to `SESSION_SWAP_QUIET_MS` (the session screen's
 * silent phase), pinned by `tests/unit/sessionRespawnGapTiming.test.ts`, so a
 * swap that goes quiet on the session screen goes quiet on the list surfaces
 * for the same span.
 */
export const ENDED_ROW_GRACE_MS = 8_000;

/**
 * One session end, in flight: the desktop's phase label when it sent one
 * (null for an unlabelled end), when the ending session reported it, and
 * WHICH session ended - so the successor's `registerSession` can find the
 * ghost entry and take over its place on the Home feed. Read through
 * `selectTaskRespawn`, which applies the window.
 */
export interface RespawnInFlight {
  label: string | null;
  reportedAt: number;
  endedSessionId: string;
}

/** The retention window a given end earns: a labelled one is explicit desktop intent, an unlabelled one is a bet. */
export function respawnGraceMs(respawn: Pick<RespawnInFlight, 'label'>): number {
  return respawn.label !== null ? RESPAWN_ROW_GRACE_MS : ENDED_ROW_GRACE_MS;
}

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
  /**
   * True while `messagePreview` is the GHOST's line, copied by successorEntry
   * so the Home row shows nothing new across a swap. The successor may be a
   * different conversation (an isolated column's session ending and the main
   * one resuming), so the line is only borrowed: the successor's first
   * snapshot drops it, which hands the row back to its own peek, and a
   * preview the successor pushes itself replaces it outright. Seen live: a
   * resumed session that stayed idle wore the dead review agent's sentence
   * for minutes.
   */
  inheritedPreview: boolean;
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
   * is balanced against the quiet swap window, and a fourth input re-opens
   * the mid-respawn flash that window exists to prevent. The same applies to
   * 'exited': the protocol calls it a snapshot racing teardown, so routing it
   * into `endedSessionIds` would end the session on the phone in exactly the
   * gap the window covers. The `session-ended` PUSH stays the sole authority,
   * because it carries `intentional`, which a snapshot cannot.
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
   * naming the phase it is in; absence means either a genuine park, a
   * desktop that predates the field (protocol 0.14.0, kangentic board task
   * #639), or the desktop's own column-move swap, which suspends and resumes
   * without a label. Per that field's own contract, this is INTENT, not a
   * guarantee: a consumer must keep whatever timeout already bounds its own
   * wait for a successor and use presence only to skip a redundant one, never
   * as proof one is coming. Nothing renders it any more (the session screen
   * reads it for the connection trace alone, and the list surfaces show no
   * caption for a swap); it lengthens the row's retention window, and
   * nothing reads absence as "no successor".
   *
   * Grows by one short string per respawn in an app run, in memory only -
   * same bound as `endedSessionIds`.
   */
  spawnProgressLabelBySessionId: Record<string, string>;
  /**
   * The END fact, keyed by TASK rather than by the session that ended, and
   * written on EVERY `session-ended`, label or not. Both keyings are needed
   * and neither is redundant:
   *
   * - `SessionScreen` holds `lastBoundSessionId`, so the session-keyed maps
   *   above are the only ones it can reach once the board drops the task.
   * - The Home feed row and the board card are TASK-keyed. During the gap the
   *   task has no session_id at all (`BoardScreen` reads
   *   `state.bySessionId[task.session_id]`, which is null), so they have no
   *   session id to look anything up with. Without this map the row simply
   *   vanishes for the whole swap, which is the bug this exists to fix - and
   *   the desktop's column-move swap arrives UNLABELLED, indistinguishable
   *   from a park at arrival, so both are retained and the window
   *   (`respawnGraceMs`) is what tells them apart.
   *
   * Unlike its two siblings this map is CLEARED rather than grown forever:
   * `registerSession` drops the entry when the successor lands, so a
   * completed swap leaves nothing behind. An end with no successor leaks one
   * small object, bounded exactly like `endedSessionIds`; the grace window in
   * `selectTaskRespawn` is what stops it being DISPLAYED, so read this map
   * through that selector and never directly.
   */
  respawnByTaskId: Record<string, RespawnInFlight>;
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
    inheritedPreview: false,
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
 * The entry a freshly registered session starts from. Ordinarily `emptyEntry`;
 * for a SUCCESSOR (a session registering for a task whose previous session
 * just ended, and whose ghost entry is still retained) it takes over the
 * ghost's place on the Home feed instead of starting from nothing.
 *
 * Why: the feed's FlashList is keyed on the session id and ordered by
 * `enteredSectionAt`, so a successor built from `emptyEntry` is a NEW row
 * that lands at the top of Idle with the task description as its body, then
 * jumps to the top of Working a round trip later when its snapshot says it is
 * thinking - two position changes and a body change inside the swap, on the
 * row that is supposed to show nothing new. Inheriting the ghost's section,
 * ordering key, preview, usage and unread badge makes the bind a same-slot
 * remount with the same body; `applySnapshot` then leaves `enteredSectionAt`
 * alone when the section it reports matches.
 *
 * What is NOT inherited, and why: a pending prompt (`'permission'` maps to
 * `'idle'`, `awaitedPromptId` stays null) belongs to the agent that died and
 * can never be answered - and `localNotifier` treats a NEW entry in
 * 'permission' as a fresh prompt, so inheriting it verbatim would push
 * "Agent needs your input" for a dead question. `reason`, `feedStatus` and
 * `sessionStatus` are the successor's own liveness and stay fresh. One
 * consequence to know: a successor inherited as 'thinking' whose snapshot
 * then reports 'idle' is a thinking-to-idle edge, which arms the notifier's
 * 45s idle settle where a fresh entry armed nothing. That is the agent going
 * idle after work the user was watching, so it is the honest reading.
 *
 * Nothing seeds when the successor id equals the ended id (the desktop never
 * reuses one across a swap; a queue promotion does, but that never ends) or
 * when the ghost has already been pruned.
 */
function successorEntry(
  sessionId: string,
  taskId: string,
  projectId: string,
  state: Pick<ActivityStoreState, 'bySessionId'>,
  respawnInFlight: RespawnInFlight | undefined,
): SessionActivityEntry {
  const fresh = emptyEntry(sessionId, taskId, projectId);
  if (respawnInFlight === undefined || respawnInFlight.endedSessionId === sessionId) return fresh;
  const ghost = state.bySessionId[respawnInFlight.endedSessionId];
  if (ghost === undefined || ghost.taskId !== taskId) return fresh;
  return {
    ...fresh,
    state: ghost.state === 'permission' ? 'idle' : ghost.state,
    enteredSectionAt: ghost.enteredSectionAt,
    messagePreview: ghost.messagePreview,
    inheritedPreview: ghost.messagePreview !== null,
    usage: ghost.usage,
    unreadCount: ghost.unreadCount,
  };
}

/**
 * Reads a `session-ended` payload's optional `spawnProgressLabel` field
 * (protocol 0.14.0+), normalising "absent" to null so callers have one empty
 * case rather than two. Absent from a pre-0.14.0 desktop, and never sent as
 * null, so the two are the same fact here: no respawn was in flight.
 *
 * The `typeof` check is kept now that the field is DECLARED, and is not
 * redundant with the type. It is the runtime floor under the store's own
 * reads: a non-string recorded here would count as "the desktop said a
 * successor is coming" and lengthen a row's retention on garbage (the label
 * is no longer rendered anywhere, so a render crash is not the risk it once
 * was). The wire path cannot deliver one today
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

/**
 * Drops a task's respawn-in-flight fact, preserving referential identity when
 * there was nothing to drop. That matters: `registerSession` runs once per live
 * task on EVERY board snapshot, so returning a fresh map each time would churn
 * every subscriber of this field on every snapshot.
 */
function clearTaskRespawn(
  respawnByTaskId: Record<string, RespawnInFlight>,
  taskId: string,
): Record<string, RespawnInFlight> {
  if (respawnByTaskId[taskId] === undefined) return respawnByTaskId;
  const next = { ...respawnByTaskId };
  delete next[taskId];
  return next;
}

export const useActivityStore = create<ActivityStoreState>((set) => ({
  bySessionId: {},
  endedSessionIds: {},
  spawnProgressLabelBySessionId: {},
  respawnByTaskId: {},

  registerSession: (sessionId, taskId, projectId) =>
    set((state) => {
      // A session registering for this task IS the successor landing, so the
      // respawn-in-flight fact is spent. Cleared HERE rather than on a later
      // pass so that the single board snapshot which installs the successor
      // also releases the retained ghost entry: reconcileSessionsFromBoards
      // registers every live session before it prunes, so by the time the
      // prune loop asks "is a respawn in flight for this task?" the answer is
      // already no. One snapshot, no double row, no flicker.
      const respawnInFlight = state.respawnByTaskId[taskId];
      const respawnByTaskId = clearTaskRespawn(state.respawnByTaskId, taskId);
      const respawnChanged = respawnByTaskId !== state.respawnByTaskId;
      const existing = state.bySessionId[sessionId];
      if (existing) {
        if (existing.taskId === taskId && existing.projectId === projectId) {
          return respawnChanged ? { respawnByTaskId } : state;
        }
        return {
          bySessionId: { ...state.bySessionId, [sessionId]: { ...existing, taskId, projectId } },
          respawnByTaskId,
        };
      }
      return {
        bySessionId: { ...state.bySessionId, [sessionId]: successorEntry(sessionId, taskId, projectId, state, respawnInFlight) },
        respawnByTaskId,
      };
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
        // The successor's own snapshot is where a borrowed preview is handed
        // back: null re-arms the Home row's peek of THIS session's transcript.
        messagePreview: existing.inheritedPreview ? null : existing.messagePreview,
        inheritedPreview: false,
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
      // The end, keyed by task, for the two surfaces that have no session id
      // during the gap - EVERY end, label or not, since the desktop's own
      // column-move swap arrives unlabelled. Written from the SAME extracted
      // label, so the two maps cannot disagree about what the desktop said.
      const respawnByTaskId: Record<string, RespawnInFlight> =
        payload.type === 'session-ended'
          ? {
              ...state.respawnByTaskId,
              [event.taskId]: { label: spawnProgressLabel, reportedAt: Date.now(), endedSessionId: event.sessionId },
            }
          : state.respawnByTaskId;
      if (!existing) {
        if (
          endedSessionIds === state.endedSessionIds &&
          spawnProgressLabelBySessionId === state.spawnProgressLabelBySessionId &&
          respawnByTaskId === state.respawnByTaskId
        ) {
          return state;
        }
        return { endedSessionIds, spawnProgressLabelBySessionId, respawnByTaskId };
      }
      const updated: SessionActivityEntry = { ...existing, lastEventAt: Date.now() };
      // The 'queued' retirement, hoisted ABOVE the switch on purpose, because
      // its justification is about the payload ARRIVING and not about what the
      // payload says. A queued placeholder has `pty: null` (desktop
      // session-manager.ts's shouldQueue branch), so it can emit nothing at
      // all - any payload reaching this entry is proof the queue promoted it.
      // Scoping it to `case 'activity'` would have left a promoted session
      // whose first push happened to be a 'permission' badged "Waiting for a
      // free slot" with its prompt hidden behind that caption, since `starting`
      // outranks every other body source on the feed row.
      //
      // 'session-ended' is the one exclusion: a session cancelled OUT of the
      // queue ends without ever running, and calling that 'running' would be a
      // lie the ended-state handling below then has to work around.
      //
      // This matters because no later snapshot would correct a stale status:
      // `setDesiredStreams` skips a session that already has a stream, so a
      // live channel re-snapshots nothing. The promotion REUSES the same
      // session id (desktop session-spawn-flow.ts: "For queue promotions, the
      // ID was set on the input when the placeholder was created"), which is
      // exactly why the stale status would otherwise outlive the queue and
      // leave a running agent badged as waiting for the life of the connection.
      if (existing.sessionStatus === 'queued' && payload.type !== 'session-ended') {
        updated.sessionStatus = 'running';
      }
      switch (payload.type) {
        case 'activity':
          updated.state = payload.state;
          updated.reason = payload.reason;
          // The 'suspended' retirement, and deliberately much NARROWER than the
          // 'queued' one above: a parked session's entry can legitimately carry
          // a stale 'idle', so only positive proof of WORK retires it, where a
          // queued placeholder's silence makes any payload proof enough.
          // 'exited' and the null "never snapshotted" case are left exactly as
          // they were, and the snapshot stays the authority on everything else.
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
          updated.inheritedPreview = false;
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
        respawnByTaskId,
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

  reset: () => set({ bySessionId: {}, endedSessionIds: {}, spawnProgressLabelBySessionId: {}, respawnByTaskId: {} }),
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
 * The end in flight for a TASK (its label, if the desktop sent one), or null
 * when none is - or when the one there was has outlived its window. The Home
 * feed row, the board card and `TaskHeader` read this;
 * `selectSessionSpawnProgressLabel` above serves the session screen, which has
 * a session id to key on and this does not require.
 *
 * The window is applied HERE rather than at each call site so that the three
 * surfaces and `reconcileSessionsFromBoards` - which uses this to decide
 * whether to keep a sessionless task's row alive - can never disagree about
 * whether an end is still in flight. A row retained by one rule and badged by
 * another would be the worst of both. The window depends on the label
 * (`respawnGraceMs`): 20s when the desktop said a successor is coming, the
 * short `ENDED_ROW_GRACE_MS` when it said nothing.
 *
 * Returns the record rather than a boolean so the one caller that still needs
 * the label (the Home row derives its queued caption as "starting for a
 * reason that is not a swap"; no surface renders the label itself) gets it
 * through the same windowed read, never a second selector.
 *
 * Reads the clock, so this is not a pure function of the state: the same state
 * answers differently once the window passes. That is intended and is what
 * bounds an end with no successor. The storeFeed timer re-runs the prune at
 * the same deadline, so the row and the glyph expire together rather than
 * leaving a glyph-less ghost behind.
 *
 * "Together" is to the same deadline, not to the same instant, and the
 * difference is worth knowing rather than discovering: nothing re-renders a
 * subscriber merely because the clock crossed the boundary (Zustand compares on
 * store WRITES), so between the window closing and the sweep's
 * `reconcileSessionsFromBoards` landing, an already-rendered row can still be
 * wearing a glyph from a window that has just closed. Both are driven off the
 * same constants, so the two deadlines coincide by construction - but the gap
 * between them is whatever `setTimeout` latency the JS thread is under, which
 * is unbounded above and NOT measured here (read out of the source, not a
 * timing claim). Deliberately not engineered against: the worst case is a
 * glyph outliving its window on an already-drawn row until the sweep lands.
 */
export function selectTaskRespawn(
  state: { respawnByTaskId: Record<string, RespawnInFlight> },
  taskId: string,
): RespawnInFlight | null {
  const respawn = state.respawnByTaskId[taskId];
  if (respawn === undefined) return null;
  if (Date.now() - respawn.reportedAt >= respawnGraceMs(respawn)) return null;
  return respawn;
}

/**
 * Whether a task is in one of the two transitional states the `'starting'`
 * glyph stands for: between two sessions (its last one ended, labelled or
 * not, and the window `selectTaskRespawn` applies has not passed) or queued
 * behind the desktop's concurrency limit.
 *
 * Shared rather than recomputed at each surface BECAUSE the surfaces claim to
 * agree. The Home feed row, the board card and `TaskHeader` all promise that
 * one task cannot report two different states on two screens at once (see
 * `docs/architecture.md`'s "Transitional states" section), and three hand-copied
 * predicates have nothing holding them to that promise - a fifth transitional
 * state would have to be remembered in three files with no compiler check.
 * Small, in the same spirit as `sectionForEntry`: the classification rule lives
 * once, and each caller supplies only the two facts it happens to hold.
 *
 * Takes the values rather than the store because the three callers reach them
 * differently: two read `sessionStatus` off a possibly-absent entry, one off an
 * entry it always has, and `TaskHeader` may have no `taskId` to look an end up
 * with at all.
 */
export function isStartingSession(
  taskRespawn: RespawnInFlight | null,
  sessionStatus: ReadStreamSessionStatusWire | null | undefined,
): boolean {
  return taskRespawn !== null || sessionStatus === 'queued';
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

/**
 * The order `selectTriageRows` RETURNS its sections in - which is not the order
 * the Home feed displays them in, and the difference is a trap worth naming.
 *
 * `TriageHomeScreen` has its own `SECTION_ORDER` (`['needs-you', 'idle',
 * 'working']`, Idle above Thinking) and re-finds each section by name, so this
 * array's order reaches no screen. That makes it look like drift somebody
 * should "tidy" by matching the two. It is not inert: `activityStore.test.ts`
 * indexes the result POSITIONALLY (`selectTriageRows(...)[1]` means the working
 * section), so reordering this silently changes what those assertions are about
 * rather than failing.
 *
 * Adding a member to `TriageSection` means adding it to BOTH arrays - the
 * screen's copy carries the same warning, since a section missing from its
 * SECTION_ORDER renders no rows and warms no snippets.
 */
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
