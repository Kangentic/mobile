import type { ActivityReasonWire, ActivityStateWire, ReadStreamSessionStatusWire } from '@kangentic/protocol';
import { formatDuration } from './formatDuration';

/**
 * What a session is doing, as one line: the desktop's own words for an
 * activity reason (`formatActivityReasonText` in its ActivityReasonTooltip.tsx,
 * the text its Agent Monitor and task card show), copied literally. The
 * Terminals sheet's rows read it ("Awaiting permission", "Running Bash",
 * "Thinking", "Idle for 12m").
 *
 * Two forced deviations, both about time:
 *
 * - The desktop prints the wait to the second ("Idle for 2m 13s"). The phone's
 *   wait labels have minute resolution on a 30 s shared clock (NowTick), so the
 *   duration here is whole minutes, truncated as WaitLabel truncates it.
 * - Under a minute the duration is left off ("Idle", "Awaiting permission")
 *   rather than printed as "0m", for the reason WaitLabel holds its own back.
 *
 * Plus two lines the desktop's tooltip has no case for, because its rows only
 * exist once a session runs: a queued terminal ("Waiting to start", a terminal
 * started while the desktop's concurrency limit was full still holds its slot)
 * and one whose agent the desktop has not classified yet ("Starting...").
 */

/** Below this a wait reads as no wait at all, as WaitLabel's floor. */
const MINIMUM_SHOWN_WAIT_MS = 60_000;

export interface ActivityLineInput {
  state: ActivityStateWire;
  reason: ActivityReasonWire | null;
  /** Null until the stream's first snapshot. */
  sessionStatus: ReadStreamSessionStatusWire | null;
  /** False until the desktop has classified the session at all (see SessionActivityEntry). */
  activityObserved: boolean;
}

/**
 * `nowMs: null` leaves every duration off: for a surface that already shows
 * the wait elsewhere (the Agents feed card's band), where the line would say
 * it twice.
 */
function waitSuffix(since: number | undefined, nowMs: number | null): string {
  if (since === undefined || nowMs === null) return '';
  const elapsedMs = nowMs - since;
  if (elapsedMs < MINIMUM_SHOWN_WAIT_MS) return '';
  return ` for ${formatDuration(Math.floor(elapsedMs / 60_000) * 60_000)}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}

export function formatActivityLine(input: ActivityLineInput, nowMs: number | null): string {
  if (input.sessionStatus === 'queued') return 'Waiting to start';
  if (!input.activityObserved) return 'Starting...';
  const reason = input.reason;
  // Keyed on the STATE first: a prompt arriving sets `state` without touching
  // `reason` (activityStore's permission branch), so a session that needs the
  // user can still be carrying the turn's last reason.
  if (input.state === 'permission') {
    return `Awaiting permission${waitSuffix(reason?.kind === 'permission' ? reason.since : undefined, nowMs)}`;
  }
  if (input.state === 'idle') {
    return `Idle${waitSuffix(reason?.kind === 'idle' ? reason.since : undefined, nowMs)}`;
  }
  if (reason === null) return 'Thinking';
  switch (reason.kind) {
    case 'tool':
      return reason.currentTool !== null && reason.currentTool.length > 0
        ? `Running ${reason.currentTool}`
        : `${plural(reason.pendingCount, 'tool')} in flight`;
    case 'subagent':
      return `${plural(reason.depth, 'subagent')} active`;
    case 'background-shell':
      return `${plural(reason.count, 'background shell')}${reason.ids.length > 0 ? ` (${reason.ids.join(', ')})` : ''}`;
    case 'turn-active':
    case 'idle':
    case 'permission':
      return 'Thinking';
  }
}
