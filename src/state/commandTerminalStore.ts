import type { CommandTerminalEarlierConversationWire } from '@kangentic/protocol';
import { create } from 'zustand';
import { capCommandTerminalName, commandTerminalTitle } from './boardStore';

/**
 * Command Terminal starts, resumes and stops the phone has in flight
 * (protocol 0.20.0, resumes 0.24.0), and each project's Earlier list.
 *
 * The board lists a project's terminals, and is the authority on which exist.
 * This store holds what the board cannot say yet: a start or resume the user
 * just tapped, whose terminal the desktop has not listed (it never may, if it
 * fails), and a Stop on its way. Held outside any screen, because the screen
 * that started a terminal opens before the answer lands and can be left before
 * it does, and the Terminals sheet and the Agents feed both have to agree with
 * it about what is stopping.
 *
 * The Earlier list is the desktop's own (`list-earlier`), read on demand and
 * kept here so the Board's Terminals button and the sheet agree on it, and so
 * a reload or a failed read keeps the rows last read on screen.
 */

export type CommandTerminalLaunchPhase = 'starting' | 'started' | 'failed';

export interface CommandTerminalLaunch {
  launchId: string;
  projectId: string;
  phase: CommandTerminalLaunchPhase;
  /** The predicted slot (the lowest free one) while starting, then the desktop's own. */
  slot: number;
  /**
   * What the screen's header says: the predicted name while starting ("Command
   * Terminal N", or the conversation's own for a resume), then the name the
   * desktop answered with.
   */
  name: string;
  /**
   * The Earlier conversation this launch resumes (protocol 0.24.0), or null
   * for a New. A resume in flight hides its Earlier row, as the desktop's
   * panel does, and the terminal's screen says "Resuming conversation...".
   */
  resumeAgentSessionId: string | null;
  /** The terminal's session, once the desktop has answered the start. */
  sessionId: string | null;
  /** The one plain line a failed start shows before the screen routes back. */
  failureMessage: string | null;
  /** When the desktop answered (`started` or `failed`), epoch ms; null while starting. */
  settledAt: number | null;
  /**
   * True once a board has listed this launch's terminal. From then on the board
   * is the authority on whether it exists: the launch no longer keeps its
   * stream wanted or draws a row of its own, so a terminal that ends (and
   * leaves the board) is not held alive by its launch for the rest of the grace
   * window. Latched, because "not listed" after "listed" means ended, where
   * before it means not listed YET.
   */
  listedOnce: boolean;
}

/**
 * How long a started terminal the board has not listed yet keeps its stream
 * wanted. The board lists it on the `command-terminals-changed` refresh that
 * follows every start, normally a round trip later; this only bounds a start
 * whose board event never comes, so its stream is not held forever. The same
 * 20 s the feed gives a labelled respawn to produce its successor
 * (RESPAWN_ROW_GRACE_MS).
 */
export const LAUNCH_LISTING_GRACE_MS = 20_000;

export type CommandTerminalStopPhase = 'stopping' | 'failed';

export type EarlierReadStatus = 'loading' | 'ready' | 'failed';

/** One project's Earlier list, as last read from the desktop. */
export interface EarlierList {
  status: EarlierReadStatus;
  /**
   * Newest first, as the desktop sent them. Kept through a reload and through
   * a failed read, so the rows on screen never vanish for a round trip; null
   * only before the first read lands.
   */
  conversations: CommandTerminalEarlierConversationWire[] | null;
  /**
   * Bumped whenever the phone changes the list itself (a resumed or gone
   * conversation dropped). A read in flight across a bump answers with the
   * list as it was before the change, so it is discarded and read again.
   */
  revision: number;
}

/** What a resume launch carries: the conversation, and the name its row shows (null when it has none). */
export interface LaunchResume {
  agentSessionId: string;
  name: string | null;
}

interface CommandTerminalStoreState {
  launchesById: Record<string, CommandTerminalLaunch>;
  /**
   * A Stop in flight or refused, by the terminal's session. `stopping` lasts
   * until the board drops the terminal, not until the verb answers: the row
   * reads "Stopping..." until it leaves the list. `failed` brings the row back
   * and puts the failure line under the list.
   */
  stopsBySessionId: Record<string, CommandTerminalStopPhase>;
  /** Each project's Earlier list (protocol 0.24.0), once a read has been asked for. */
  earlierByProjectId: Record<string, EarlierList>;
  /** A New when `resume` is absent or null; a resume of that conversation otherwise. */
  beginLaunch: (projectId: string, predictedSlot: number, resume?: LaunchResume | null) => string;
  markLaunchStarted: (launchId: string, started: { sessionId: string; slot: number; name: string }) => void;
  markLaunchFailed: (launchId: string, failureMessage: string) => void;
  /** A board has listed the launch's terminal (see `listedOnce`). A no-op once set. */
  markLaunchListed: (launchId: string) => void;
  clearLaunch: (launchId: string) => void;
  markStopping: (sessionId: string) => void;
  markStopFailed: (sessionId: string) => void;
  clearStop: (sessionId: string) => void;
  /** A read of the project's Earlier list is on its way; the rows last read stay. */
  markEarlierLoading: (projectId: string) => void;
  setEarlier: (projectId: string, conversations: CommandTerminalEarlierConversationWire[]) => void;
  /** The read failed; the rows last read stay, under the failure state. */
  markEarlierFailed: (projectId: string) => void;
  /** Takes one conversation out of the held list (resumed, or gone) and bumps the list's revision. */
  dropEarlierConversation: (projectId: string, agentSessionId: string) => void;
  reset: () => void;
}

let nextLaunchSequence = 0;

const EMPTY_EARLIER_LIST: EarlierList = { status: 'loading', conversations: null, revision: 0 };

function earlierListOf(state: Pick<CommandTerminalStoreState, 'earlierByProjectId'>, projectId: string): EarlierList {
  return state.earlierByProjectId[projectId] ?? EMPTY_EARLIER_LIST;
}

/** Whether a desktop-supplied conversation name has anything to show: null and blank ones do not. */
export function hasConversationName(name: string | null): name is string {
  return name !== null && name.trim().length > 0;
}

/**
 * Whether two Earlier answers list the same conversations in the same order,
 * field by field. A re-read that brings nothing new then keeps the held array,
 * and with it every row object, so the sheet's rows and the Board button do
 * not re-render for a list that did not change.
 */
function sameConversations(
  held: readonly CommandTerminalEarlierConversationWire[],
  answer: readonly CommandTerminalEarlierConversationWire[],
): boolean {
  if (held.length !== answer.length) return false;
  return held.every((conversation, index) => {
    const other = answer[index];
    return conversation.agentSessionId === other.agentSessionId && conversation.name === other.name && conversation.endedAt === other.endedAt;
  });
}

export const useCommandTerminalStore = create<CommandTerminalStoreState>((set) => ({
  launchesById: {},
  stopsBySessionId: {},
  earlierByProjectId: {},

  beginLaunch: (projectId, predictedSlot, resume = null) => {
    nextLaunchSequence += 1;
    const launchId = `launch-${nextLaunchSequence}`;
    set((state) => ({
      launchesById: {
        ...state.launchesById,
        [launchId]: {
          launchId,
          projectId,
          phase: 'starting',
          slot: predictedSlot,
          // A resume is titled by its conversation from the tap; one with no
          // name of its own (or a blank one) reads as the slot's terminal, as
          // the desktop will name it.
          name: resume !== null && hasConversationName(resume.name) ? capCommandTerminalName(resume.name) : commandTerminalTitle(predictedSlot),
          resumeAgentSessionId: resume !== null ? resume.agentSessionId : null,
          sessionId: null,
          failureMessage: null,
          settledAt: null,
          listedOnce: false,
        },
      },
    }));
    return launchId;
  },

  markLaunchStarted: (launchId, started) =>
    set((state) => {
      const launch = state.launchesById[launchId];
      if (launch === undefined) return state;
      return {
        launchesById: {
          ...state.launchesById,
          [launchId]: {
            ...launch,
            phase: 'started',
            sessionId: started.sessionId,
            slot: started.slot,
            name: capCommandTerminalName(started.name),
            settledAt: Date.now(),
          },
        },
      };
    }),

  markLaunchFailed: (launchId, failureMessage) =>
    set((state) => {
      const launch = state.launchesById[launchId];
      if (launch === undefined) return state;
      return {
        launchesById: { ...state.launchesById, [launchId]: { ...launch, phase: 'failed', failureMessage, settledAt: Date.now() } },
      };
    }),

  markLaunchListed: (launchId) =>
    set((state) => {
      const launch = state.launchesById[launchId];
      if (launch === undefined || launch.listedOnce) return state;
      return { launchesById: { ...state.launchesById, [launchId]: { ...launch, listedOnce: true } } };
    }),

  clearLaunch: (launchId) =>
    set((state) => {
      if (state.launchesById[launchId] === undefined) return state;
      const launchesById = { ...state.launchesById };
      delete launchesById[launchId];
      return { launchesById };
    }),

  markStopping: (sessionId) => set((state) => ({ stopsBySessionId: { ...state.stopsBySessionId, [sessionId]: 'stopping' } })),

  markStopFailed: (sessionId) => set((state) => ({ stopsBySessionId: { ...state.stopsBySessionId, [sessionId]: 'failed' } })),

  clearStop: (sessionId) =>
    set((state) => {
      if (state.stopsBySessionId[sessionId] === undefined) return state;
      const stopsBySessionId = { ...state.stopsBySessionId };
      delete stopsBySessionId[sessionId];
      return { stopsBySessionId };
    }),

  markEarlierLoading: (projectId) =>
    set((state) => {
      const list = earlierListOf(state, projectId);
      if (state.earlierByProjectId[projectId] !== undefined && list.status === 'loading') return state;
      return { earlierByProjectId: { ...state.earlierByProjectId, [projectId]: { ...list, status: 'loading' } } };
    }),

  setEarlier: (projectId, conversations) =>
    set((state) => {
      const list = earlierListOf(state, projectId);
      const unchanged = list.conversations !== null && sameConversations(list.conversations, conversations);
      if (unchanged && list.status === 'ready' && state.earlierByProjectId[projectId] !== undefined) return state;
      return {
        earlierByProjectId: {
          ...state.earlierByProjectId,
          [projectId]: { ...list, status: 'ready', conversations: unchanged ? list.conversations : conversations },
        },
      };
    }),

  markEarlierFailed: (projectId) =>
    set((state) => ({
      earlierByProjectId: { ...state.earlierByProjectId, [projectId]: { ...earlierListOf(state, projectId), status: 'failed' } },
    })),

  dropEarlierConversation: (projectId, agentSessionId) =>
    set((state) => {
      const list = state.earlierByProjectId[projectId];
      if (list === undefined) return state;
      const conversations = list.conversations?.filter((conversation) => conversation.agentSessionId !== agentSessionId) ?? null;
      return {
        earlierByProjectId: { ...state.earlierByProjectId, [projectId]: { ...list, conversations, revision: list.revision + 1 } },
      };
    }),

  reset: () => set({ launchesById: {}, stopsBySessionId: {}, earlierByProjectId: {} }),
}));

/** A project's Earlier list, or null when none has been read or asked for. The stored object, so safe as a selector. */
export function selectEarlierList(state: Pick<CommandTerminalStoreState, 'earlierByProjectId'>, projectId: string | null): EarlierList | null {
  if (projectId === null) return null;
  return state.earlierByProjectId[projectId] ?? null;
}

/**
 * Whether a launch is a resume still bringing its terminal up: starting, or
 * started but not yet listed by a board. Once a board lists the terminal the
 * board decides (the desktop's list leaves out a conversation a live terminal
 * holds), and the launch only lingers for its listing grace; a failed one has
 * given its conversation back.
 */
export function isResumeInFlight(launch: CommandTerminalLaunch): boolean {
  if (launch.resumeAgentSessionId === null) return false;
  return launch.phase === 'starting' || (launch.phase === 'started' && !launch.listedOnce);
}

/** A resume of this conversation still in flight (see `isResumeInFlight`), or null. */
export function selectResumeInFlight(
  state: Pick<CommandTerminalStoreState, 'launchesById'>,
  projectId: string,
  agentSessionId: string,
): CommandTerminalLaunch | null {
  for (const launch of Object.values(state.launchesById)) {
    if (launch.projectId === projectId && launch.resumeAgentSessionId === agentSessionId && isResumeInFlight(launch)) return launch;
  }
  return null;
}

/** A launch by id, or null. The stored object, so safe as a selector. */
export function selectLaunch(state: Pick<CommandTerminalStoreState, 'launchesById'>, launchId: string | null): CommandTerminalLaunch | null {
  if (launchId === null) return null;
  return state.launchesById[launchId] ?? null;
}

/** The slots a project's in-flight starts are predicted to take, so a second New predicts the next one. */
export function selectStartingSlots(state: Pick<CommandTerminalStoreState, 'launchesById'>, projectId: string): number[] {
  return Object.values(state.launchesById)
    .filter((launch) => launch.projectId === projectId && launch.phase === 'starting')
    .map((launch) => launch.slot);
}

/**
 * Started terminals no board has listed YET, still inside their grace window:
 * the reconcile keeps their streams wanted, so the screen that just opened one
 * gets its terminal before the board catches up. Never one a board has already
 * listed (`listedOnce`): once listed, the board decides, and a terminal it has
 * since dropped has ended. `now` is passed in, so the clock stays with the
 * caller.
 */
export function selectUnlistedStartedLaunches(
  state: Pick<CommandTerminalStoreState, 'launchesById'>,
  listedSessionIds: ReadonlySet<string>,
  now: number,
): CommandTerminalLaunch[] {
  return Object.values(state.launchesById).filter(
    (launch) =>
      launch.phase === 'started' &&
      !launch.listedOnce &&
      launch.sessionId !== null &&
      !listedSessionIds.has(launch.sessionId) &&
      launch.settledAt !== null &&
      now - launch.settledAt < LAUNCH_LISTING_GRACE_MS,
  );
}
