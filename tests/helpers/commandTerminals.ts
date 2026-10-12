import type { CommandTerminalWire } from '@kangentic/protocol';
import { useBoardStore } from '@/state/boardStore';
import { commandTerminalWire } from './commandTerminalWire';

/**
 * A Command Terminal as the board lists it (protocol 0.20.0), for the
 * component tests: the shared wire fixture (commandTerminalWire.ts) under the
 * session id these tests were written against.
 */
export function commandTerminalWireFixture(overrides: Partial<CommandTerminalWire> = {}): CommandTerminalWire {
  return commandTerminalWire({ sessionId: 'terminal-session-1', ...overrides });
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
