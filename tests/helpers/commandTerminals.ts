import type { CommandTerminalWire } from '@kangentic/protocol';
import { useBoardStore } from '@/state/boardStore';

/**
 * A Command Terminal as the board lists it (protocol 0.20.0). No fixture for it
 * exists in the shipped desktopFixtures, so the component tests build the wire
 * rows here. `named: false` is the default because a fresh terminal has no name
 * of its own until the desktop derives one from the first prompt.
 */
export function commandTerminalWireFixture(overrides: Partial<CommandTerminalWire> = {}): CommandTerminalWire {
  return {
    sessionId: 'terminal-session-1',
    projectId: 'project-1',
    slot: 1,
    name: 'Command Terminal 1',
    named: false,
    activity: { state: null, reason: null },
    ...overrides,
  };
}

/**
 * Seeds one project's board with the given terminals. `offered` is the
 * desktop's `commandTerminalsOffered` flag (the verb is on offer to this phone).
 * The board has no columns or tasks: every component under test here reads the
 * terminals and the project list only.
 */
export function seedCommandTerminalBoard({
  projectId = 'project-1',
  projectName = 'Alpha',
  terminals = [],
  offered = true,
}: {
  projectId?: string;
  projectName?: string;
  terminals?: CommandTerminalWire[];
  offered?: boolean;
} = {}): void {
  useBoardStore.setState({
    projects: [{ id: projectId, name: projectName }],
    hasHydratedSnapshot: true,
    boardsByProjectId: {
      [projectId]: {
        columns: [],
        tasksById: {},
        snapshotAt: 0,
        showTicketNumbers: true,
        view: 'full',
        taskCountsByColumnId: {},
        commandTerminals: terminals,
        commandTerminalsOffered: offered,
      },
    },
    pendingMoves: [],
  });
}

/** Replaces only the terminals of an already-seeded board, as a `command-terminals-changed` refresh does. */
export function setBoardCommandTerminals(projectId: string, terminals: CommandTerminalWire[]): void {
  useBoardStore.setState((state) => {
    const board = state.boardsByProjectId[projectId];
    if (board === undefined) return state;
    return { boardsByProjectId: { ...state.boardsByProjectId, [projectId]: { ...board, commandTerminals: terminals } } };
  });
}
