import { create } from 'zustand';
import { capCommandTerminalName, commandTerminalTitle } from './boardStore';

/**
 * Command Terminal starts and stops the phone has in flight (protocol 0.20.0).
 *
 * The board lists a project's terminals, and is the authority on which exist.
 * This store holds what the board cannot say yet: a start the user just
 * tapped, whose terminal the desktop has not listed (it never may, if the
 * start fails), and a Stop on its way. Held outside any screen, because the
 * screen that started a terminal opens before the answer lands and can be
 * left before it does, and the Terminals sheet and the Agents feed both have
 * to agree with it about what is stopping.
 */

export type CommandTerminalLaunchPhase = 'starting' | 'started' | 'failed';

export interface CommandTerminalLaunch {
  launchId: string;
  projectId: string;
  phase: CommandTerminalLaunchPhase;
  /** The predicted slot (the lowest free one) while starting, then the desktop's own. */
  slot: number;
  /**
   * What the screen's header says: the predicted "Command Terminal N" while
   * starting, then the name the desktop answered with.
   */
  name: string;
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

interface CommandTerminalStoreState {
  launchesById: Record<string, CommandTerminalLaunch>;
  /**
   * A Stop in flight or refused, by the terminal's session. `stopping` lasts
   * until the board drops the terminal, not until the verb answers: the row
   * reads "Stopping..." until it leaves the list. `failed` brings the row back
   * and puts the failure line under the list.
   */
  stopsBySessionId: Record<string, CommandTerminalStopPhase>;
  beginLaunch: (projectId: string, predictedSlot: number) => string;
  markLaunchStarted: (launchId: string, started: { sessionId: string; slot: number; name: string }) => void;
  markLaunchFailed: (launchId: string, failureMessage: string) => void;
  /** A board has listed the launch's terminal (see `listedOnce`). A no-op once set. */
  markLaunchListed: (launchId: string) => void;
  clearLaunch: (launchId: string) => void;
  markStopping: (sessionId: string) => void;
  markStopFailed: (sessionId: string) => void;
  clearStop: (sessionId: string) => void;
  reset: () => void;
}

let nextLaunchSequence = 0;

export const useCommandTerminalStore = create<CommandTerminalStoreState>((set) => ({
  launchesById: {},
  stopsBySessionId: {},

  beginLaunch: (projectId, predictedSlot) => {
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
          name: commandTerminalTitle(predictedSlot),
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

  reset: () => set({ launchesById: {}, stopsBySessionId: {} }),
}));

/** A launch by id, or null. The stored object, so safe as a selector. */
export function selectLaunch(state: Pick<CommandTerminalStoreState, 'launchesById'>, launchId: string | null): CommandTerminalLaunch | null {
  if (launchId === null) return null;
  return state.launchesById[launchId] ?? null;
}

/**
 * How many starts this phone has in flight for a project. They count toward
 * the four-per-project limit until they settle: a slot is being taken, and a
 * second New behind the first would otherwise read as allowed.
 */
export function selectStartingCount(state: Pick<CommandTerminalStoreState, 'launchesById'>, projectId: string | null): number {
  if (projectId === null) return 0;
  let starting = 0;
  for (const launch of Object.values(state.launchesById)) {
    if (launch.projectId === projectId && launch.phase === 'starting') starting += 1;
  }
  return starting;
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
