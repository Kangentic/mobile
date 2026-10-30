import { isPermissionWaitKindWire, type ActivityReasonWire, type ActivityStateWire, type PermissionWaitKindWire } from '@kangentic/protocol';

/**
 * What an agent waiting on the user is waiting for, ported from the desktop's
 * `agent-wait.ts` (renderer/components/board) so the phone draws every wait the
 * way the desktop card does: the kind the agent reported (protocol 0.26.0), or
 * `'unknown'` when its wait carries none (an agent that does not report it, an
 * older desktop, or a reason that has not arrived yet).
 */
export type AgentWaitKind = PermissionWaitKindWire | 'unknown';

/**
 * The kind of the permission wait `state` and `reason` describe, or null when
 * the session is not in one (working, a finished turn).
 *
 * The STATE decides that a wait is open, the reason only what it is for: a
 * prompt event sets `state` without writing `reason` (activityStore's
 * permission branch), so the reason can lag the state.
 *
 * The kind is checked against the protocol's own set rather than trusted:
 * `isBridgeEvent` validates an event by parsing it, but the feed keeps the RAW
 * event, so a kind a newer desktop adds reaches the store unfiltered. Unknown
 * reads as unknown, as the protocol's parsers drop it.
 */
export function agentWaitKind(state: ActivityStateWire | null | undefined, reason: ActivityReasonWire | null | undefined): AgentWaitKind | null {
  if (state !== 'permission') return null;
  if (reason?.kind === 'permission' && isPermissionWaitKindWire(reason.waitKind)) return reason.waitKind;
  return 'unknown';
}

/**
 * The mark each wait draws. An unknown kind takes the question's bubble, the
 * general "waiting on your answer", the same way its notification falls back to
 * "Agent needs your input". A lookup rather than comparisons, as the desktop's.
 */
const WAIT_MARKS: Record<AgentWaitKind, PermissionWaitKindWire> = {
  question: 'question',
  approval: 'approval',
  unknown: 'question',
};

export function waitMarkKind(waitKind: AgentWaitKind): PermissionWaitKindWire {
  return WAIT_MARKS[waitKind];
}
