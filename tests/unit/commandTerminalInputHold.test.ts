/**
 * The Command Terminal input hold at its chokepoint (protocol 0.20.0): the
 * three input actions every keystroke, message and prompt answer takes refuse a
 * terminal session whose agent the desktop has not classified yet. The
 * terminal screen holds the same input in its UI, but that layer is opt-in per
 * component; this one is what a screen that forgets the prop (a prompt card on
 * the Chat lens, or a future surface) still cannot get past. The desktop's
 * mobile-bridge.md documents this hold as the phone's half of the promise that
 * `command-terminal` adds no shell reach, so it is asserted on the mechanism:
 * the verb client is never called.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommandTerminalWire } from '@kangentic/protocol';
import {
  CommandTerminalInputHeldError,
  answerPermissionPrompt,
  sendUserMessage,
  writeTerminal,
} from '@/connection/actions';
import { boardSnapshotFixture } from '@/devsupport/desktopFixtures';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';

const { writeInteractiveTerminal, verbSendUserMessage, verbAnswerPermissionPrompt } = vi.hoisted(() => ({
  writeInteractiveTerminal: vi.fn(),
  verbSendUserMessage: vi.fn(),
  verbAnswerPermissionPrompt: vi.fn(),
}));

vi.mock('@/connection/connectionManager', () => ({
  getActiveConnection: () => null,
  reconnectNow: vi.fn(),
  requireSubscriptions: vi.fn(),
  requireVerbClient: () => ({
    writeInteractiveTerminal,
    sendUserMessage: verbSendUserMessage,
    answerPermissionPrompt: verbAnswerPermissionPrompt,
  }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
// @/connection/actions also imports settingsStore, which persists via
// expo-secure-store - fake it so the vitest (node) run has no native module.
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

const TERMINAL_SESSION_ID = 'sess-terminal';
const TASK_SESSION_ID = 'sess-task';

function terminalWire(overrides: Partial<CommandTerminalWire> = {}): CommandTerminalWire {
  return {
    sessionId: TERMINAL_SESSION_ID,
    projectId: 'project-1',
    slot: 1,
    name: 'Command Terminal 1',
    named: false,
    activity: { state: null, reason: null },
    ...overrides,
  };
}

/** The desktop has classified the terminal's agent: what opens the hold. */
function observeTerminalActivity(): void {
  useActivityStore.getState().applyActivityEvent({
    kind: 'activity',
    sessionId: TERMINAL_SESSION_ID,
    taskId: 'desktop-made-up-task-id',
    payload: { type: 'activity', state: 'idle', reason: { kind: 'idle', since: 1 } },
  });
}

beforeEach(() => {
  useActivityStore.getState().reset();
  useBoardStore.getState().reset();
  writeInteractiveTerminal.mockResolvedValue({ written: true });
  verbSendUserMessage.mockResolvedValue({ delivered: true });
  verbAnswerPermissionPrompt.mockResolvedValue({ answered: true });
});

afterEach(() => {
  writeInteractiveTerminal.mockReset();
  verbSendUserMessage.mockReset();
  verbAnswerPermissionPrompt.mockReset();
});

describe('the Command Terminal input hold at the input actions', () => {
  it('refuses all three input actions for a registered terminal whose agent is not classified yet, and sends nothing', async () => {
    useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, 'project-1');

    await expect(writeTerminal(TERMINAL_SESSION_ID, 'ls\r')).rejects.toBeInstanceOf(CommandTerminalInputHeldError);
    await expect(sendUserMessage(TERMINAL_SESSION_ID, 'hello')).rejects.toBeInstanceOf(CommandTerminalInputHeldError);
    await expect(answerPermissionPrompt(TERMINAL_SESSION_ID, 'prompt-1', '1\r')).rejects.toBeInstanceOf(CommandTerminalInputHeldError);

    expect(writeInteractiveTerminal).not.toHaveBeenCalled();
    expect(verbSendUserMessage).not.toHaveBeenCalled();
    expect(verbAnswerPermissionPrompt).not.toHaveBeenCalled();
  });

  it('refuses a terminal the board lists before any activity entry exists for it', async () => {
    useBoardStore.getState().applyBoardSnapshot(boardSnapshotFixture({ commandTerminals: [terminalWire()] }));

    await expect(writeTerminal(TERMINAL_SESSION_ID, 'ls\r')).rejects.toBeInstanceOf(CommandTerminalInputHeldError);
    expect(writeInteractiveTerminal).not.toHaveBeenCalled();
  });

  it('opens once the desktop has classified the agent', async () => {
    useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, 'project-1');
    observeTerminalActivity();

    await writeTerminal(TERMINAL_SESSION_ID, 'ls\r');
    await sendUserMessage(TERMINAL_SESSION_ID, 'hello');
    await answerPermissionPrompt(TERMINAL_SESSION_ID, 'prompt-1', '1\r');

    expect(writeInteractiveTerminal).toHaveBeenCalledWith(TERMINAL_SESSION_ID, 'ls\r');
    expect(verbSendUserMessage).toHaveBeenCalledWith(TERMINAL_SESSION_ID, 'hello');
    expect(verbAnswerPermissionPrompt).toHaveBeenCalledWith({ sessionId: TERMINAL_SESSION_ID, promptId: 'prompt-1', keystrokes: '1\r' });
  });

  it("never holds a task's session, classified or not", async () => {
    useActivityStore.getState().registerSession(TASK_SESSION_ID, 'task-1', 'project-1');

    await writeTerminal(TASK_SESSION_ID, 'ls\r');

    expect(writeInteractiveTerminal).toHaveBeenCalledWith(TASK_SESSION_ID, 'ls\r');
  });
});
