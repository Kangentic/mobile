import type { CommandTerminalWire } from '@kangentic/protocol';

/**
 * A Command Terminal as a board snapshot lists it (protocol 0.20.0), for the
 * vitest tier. `desktopFixtures` has no factory for it. `named: false` and a
 * null activity are the defaults because a fresh terminal has no name of its
 * own until the desktop derives one from the first prompt, and its engine has
 * classified nothing yet.
 */
export function commandTerminalWire(overrides: Partial<CommandTerminalWire> = {}): CommandTerminalWire {
  return {
    sessionId: 'sess-terminal-1',
    projectId: 'project-1',
    slot: 1,
    name: 'Command Terminal 1',
    named: false,
    activity: { state: null, reason: null },
    ...overrides,
  };
}
