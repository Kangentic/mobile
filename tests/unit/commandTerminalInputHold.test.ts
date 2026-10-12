/**
 * The Command Terminal input hold (protocol 0.20.0), run as a matrix: every
 * case against each of the three input actions on its own, where
 * commandTerminalInputHold.test.ts asserts the headline behaviour once. This
 * file adds what that one leaves out - a snapshot that still carries no
 * classified state keeps the hold, and a session neither the phone nor a board
 * knows is not held (the screen's own gate covers it) - and proves each action
 * is individually guarded rather than one of them riding on another.
 *
 * Nothing typed reaches a terminal until the desktop has classified its agent:
 * in the moment after spawn the PTY can be a bare shell at the project root, and
 * holding input there is the phone's half of the promise that `command-terminal`
 * adds no shell reach.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommandTerminalInputHeldError, answerPermissionPrompt, sendUserMessage, writeTerminal } from '@/connection/actions';
import { useActivityStore } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';
import { boardSnapshotFixture, streamSnapshotFixture } from '@/devsupport/desktopFixtures';
import { commandTerminalWire } from '../helpers/commandTerminalWire';

const mocks = vi.hoisted(() => ({
  sendUserMessage: vi.fn(),
  answerPermissionPrompt: vi.fn(),
  writeInteractiveTerminal: vi.fn(),
}));

vi.mock('@/connection/connectionManager', () => ({
  NotConnectedError: class NotConnectedError extends Error {},
  getActiveConnection: vi.fn(),
  reconnectNow: vi.fn(),
  requireSubscriptions: vi.fn(),
  requireVerbClient: () => ({
    sendUserMessage: mocks.sendUserMessage,
    answerPermissionPrompt: mocks.answerPermissionPrompt,
    writeInteractiveTerminal: mocks.writeInteractiveTerminal,
  }),
}));
vi.mock('@/connection/bootstrap', () => ({ runBootstrap: vi.fn() }));
vi.mock('@/connection/storeFeed', () => ({ reconcileSessionsFromBoards: vi.fn() }));
vi.mock('expo-secure-store', () => ({
  getItemAsync: () => Promise.resolve(null),
  setItemAsync: () => Promise.resolve(),
}));

const PROJECT_ID = 'project-1';
const TERMINAL_SESSION_ID = 'sess-terminal-1';

const INPUT_ACTIONS = [
  ['sendUserMessage', () => sendUserMessage(TERMINAL_SESSION_ID, 'hello'), mocks.sendUserMessage],
  ['answerPermissionPrompt', () => answerPermissionPrompt(TERMINAL_SESSION_ID, `${TERMINAL_SESSION_ID}:tool-1`, '1\r'), mocks.answerPermissionPrompt],
  ['writeTerminal', () => writeTerminal(TERMINAL_SESSION_ID, 'ls\r'), mocks.writeInteractiveTerminal],
] as const;

beforeEach(() => {
  mocks.sendUserMessage.mockReset().mockResolvedValue({ delivered: true });
  mocks.answerPermissionPrompt.mockReset().mockResolvedValue({ answered: true });
  mocks.writeInteractiveTerminal.mockReset().mockResolvedValue({ written: true });
  useActivityStore.getState().reset();
  useBoardStore.getState().reset();
});

describe.each(INPUT_ACTIONS)('%s and a Command Terminal', (_name, act, verb) => {
  it('is held while the terminal\'s agent is unclassified, and sends nothing', async () => {
    useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, PROJECT_ID);

    await expect(act()).rejects.toBeInstanceOf(CommandTerminalInputHeldError);

    expect(verb).not.toHaveBeenCalled();
  });

  it('is held when only a board lists the session as a terminal and the phone has no entry yet', async () => {
    useBoardStore.getState().applyBoardSnapshot(
      boardSnapshotFixture({ projectId: PROJECT_ID, tasks: [], commandTerminals: [commandTerminalWire({ sessionId: TERMINAL_SESSION_ID })] }),
    );

    await expect(act()).rejects.toBeInstanceOf(CommandTerminalInputHeldError);

    expect(verb).not.toHaveBeenCalled();
  });

  it('is held after a snapshot that still carries no classified state', async () => {
    useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, PROJECT_ID);
    useActivityStore.getState().applySnapshot(
      TERMINAL_SESSION_ID,
      '',
      PROJECT_ID,
      streamSnapshotFixture({ activity: { state: null, reason: null } }),
    );

    await expect(act()).rejects.toBeInstanceOf(CommandTerminalInputHeldError);

    expect(verb).not.toHaveBeenCalled();
  });

  it('goes through once the desktop has classified the agent', async () => {
    useActivityStore.getState().registerCommandTerminal(TERMINAL_SESSION_ID, PROJECT_ID);
    useActivityStore.getState().applySnapshot(TERMINAL_SESSION_ID, '', PROJECT_ID, streamSnapshotFixture());

    await act();

    expect(verb).toHaveBeenCalledTimes(1);
  });

  it('is not held for a task\'s session, even one whose activity was never classified', async () => {
    useActivityStore.getState().registerSession(TERMINAL_SESSION_ID, 'task-1', PROJECT_ID);

    await act();

    expect(verb).toHaveBeenCalledTimes(1);
  });

  it('is not held for a session neither the phone nor a board knows (the screen\'s own gate covers it)', async () => {
    await act();

    expect(verb).toHaveBeenCalledTimes(1);
  });
});
