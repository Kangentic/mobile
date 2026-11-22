import type { CommandTerminalEarlierConversationWire, CommandTerminalWire } from '@kangentic/protocol';
import { sectionForEntry, type SessionActivityEntry } from '@/state/activityStore';
import { isResumeInFlight, type CommandTerminalLaunch } from '@/state/commandTerminalStore';

/**
 * How a Command Terminal reads at a glance: WORKING (green) while it starts,
 * waits for a free slot or works, NEEDS YOU (amber, decision H1) once it is
 * idle or asking. An idle terminal is the user's move, as an idle agent is on
 * the desktop's Agent Monitor, which is why the button has no third "resting"
 * state (design change 1).
 */
export type CommandTerminalTone = 'working' | 'needs-you';

export function commandTerminalTone(entry: SessionActivityEntry | null): CommandTerminalTone {
  if (entry === null || entry.sessionStatus === 'queued' || !entry.activityObserved) return 'working';
  return sectionForEntry(entry) === 'working' ? 'working' : 'needs-you';
}

/**
 * The Board header's Terminals button (design change 1), in its states:
 * - nothing running and nothing to resume: the "new terminal" mark, and one
 *   tap starts one;
 * - nothing running, with Earlier conversations to resume (task #160, decision
 *   A1): the terminal mark at rest with no count, and a tap opens the sheet;
 * - running: the count, amber when any terminal needs you and green otherwise.
 */
export type TerminalsButtonState =
  | { kind: 'new' }
  | { kind: 'earlier' }
  | { kind: 'running'; count: number; tone: CommandTerminalTone };

export function terminalsButtonState(tones: readonly CommandTerminalTone[], earlierCount: number): TerminalsButtonState {
  if (tones.length === 0) return earlierCount > 0 ? { kind: 'earlier' } : { kind: 'new' };
  return { kind: 'running', count: tones.length, tone: tones.includes('needs-you') ? 'needs-you' : 'working' };
}

/** Shared empty value, so a project with nothing to resume hands FlashList and the button a stable array. */
export const NO_EARLIER_CONVERSATIONS: readonly CommandTerminalEarlierConversationWire[] = [];

/**
 * The Earlier rows a project shows: the list last read, minus any conversation
 * a resume of this phone is still bringing up (`isResumeInFlight`), which the
 * desktop's panel also hides from the moment of the click. A resume that
 * failed gives its row back. Callers memoise it over the two stored
 * references, so the result keeps its identity across unrelated renders.
 */
export function visibleEarlierConversations(
  conversations: readonly CommandTerminalEarlierConversationWire[] | null,
  launches: readonly CommandTerminalLaunch[],
  projectId: string,
): readonly CommandTerminalEarlierConversationWire[] {
  if (conversations === null || conversations.length === 0) return NO_EARLIER_CONVERSATIONS;
  const resuming = new Set<string>();
  for (const launch of launches) {
    if (launch.projectId === projectId && isResumeInFlight(launch) && launch.resumeAgentSessionId !== null) {
      resuming.add(launch.resumeAgentSessionId);
    }
  }
  if (resuming.size === 0) return conversations;
  const visible = conversations.filter((conversation) => !resuming.has(conversation.agentSessionId));
  return visible.length === 0 ? NO_EARLIER_CONVERSATIONS : visible;
}

/**
 * One terminal of a project as the phone draws it: a listed one, or one this
 * phone is starting that no board lists yet. A start in flight counts toward
 * the button's count and the four-per-project limit, because it is taking a
 * slot, and keeps a second New from looking allowed in the meantime.
 */
export interface ProjectTerminal {
  /** The listed terminal's session; null for a start that has not answered. */
  sessionId: string | null;
  slot: number;
  name: string;
  /** True once the desktop has named it from its first prompt. */
  named: boolean;
}

export function projectTerminals(
  listed: readonly CommandTerminalWire[],
  launches: readonly CommandTerminalLaunch[],
  projectId: string,
): ProjectTerminal[] {
  const listedSessionIds = new Set(listed.map((terminal) => terminal.sessionId));
  const rows: ProjectTerminal[] = listed.map((terminal) => ({
    sessionId: terminal.sessionId,
    slot: terminal.slot,
    name: terminal.name,
    named: terminal.named,
  }));
  for (const launch of launches) {
    if (launch.projectId !== projectId || launch.phase === 'failed') continue;
    // Listed, or listed once and since ended: the board's row (or its
    // absence) is the truth from then on.
    if (launch.listedOnce || (launch.sessionId !== null && listedSessionIds.has(launch.sessionId))) continue;
    rows.push({ sessionId: launch.sessionId, slot: launch.slot, name: launch.name, named: false });
  }
  return rows.sort((first, second) => first.slot - second.slot);
}
