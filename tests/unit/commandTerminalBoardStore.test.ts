/**
 * boardStore's Command Terminal share (protocol 0.20.0): what a snapshot keeps
 * of a project's terminals, and the selectors and helpers the Board header, the
 * Terminals sheet and the New button read.
 *
 * The slot helpers are a PREDICTION of the desktop's own allocation (its lowest
 * free slot, 1 to 4), used only to title a terminal whose start has not been
 * answered; the start's answer carries the real slot.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  COMMAND_TERMINAL_LIMIT,
  COMMAND_TERMINAL_NAME_MAX_LENGTH,
  capCommandTerminalName,
  commandTerminalTitle,
  lowestFreeCommandTerminalSlot,
  selectCommandTerminal,
  selectCommandTerminalSessionIds,
  selectCommandTerminals,
  selectCommandTerminalsOffered,
  useBoardStore,
} from '@/state/boardStore';
import { boardSnapshotFixture } from '@/devsupport/desktopFixtures';
import { commandTerminalWire } from '../helpers/commandTerminalWire';

function applyTerminals(projectId: string, terminals: ReturnType<typeof commandTerminalWire>[] | undefined, offered?: boolean): void {
  useBoardStore.getState().applyBoardSnapshot(
    boardSnapshotFixture({
      projectId,
      tasks: [],
      ...(terminals !== undefined ? { commandTerminals: terminals } : {}),
      ...(offered !== undefined ? { commandTerminalsOffered: offered } : {}),
    }),
  );
}

describe('boardStore and Command Terminals', () => {
  beforeEach(() => {
    useBoardStore.getState().reset();
  });

  describe('applyBoardSnapshot', () => {
    it('orders a project\'s terminals by slot, whatever order the snapshot sent them in', () => {
      applyTerminals('project-1', [
        commandTerminalWire({ sessionId: 'sess-c', slot: 3 }),
        commandTerminalWire({ sessionId: 'sess-a', slot: 1 }),
        commandTerminalWire({ sessionId: 'sess-b', slot: 2 }),
      ]);

      expect(useBoardStore.getState().boardsByProjectId['project-1'].commandTerminals.map((terminal) => terminal.sessionId)).toEqual([
        'sess-a',
        'sess-b',
        'sess-c',
      ]);
    });

    it('sorts a copy: the snapshot\'s own array keeps the order it arrived in', () => {
      const wireOrder = [commandTerminalWire({ sessionId: 'sess-b', slot: 2 }), commandTerminalWire({ sessionId: 'sess-a', slot: 1 })];

      applyTerminals('project-1', wireOrder);

      expect(wireOrder.map((terminal) => terminal.sessionId)).toEqual(['sess-b', 'sess-a']);
    });

    it('holds no terminals, and offers none, against a snapshot that carries neither field (an older desktop)', () => {
      applyTerminals('project-1', undefined);

      const board = useBoardStore.getState().boardsByProjectId['project-1'];
      expect(board.commandTerminals).toEqual([]);
      expect(board.commandTerminalsOffered).toBe(false);
    });

    it.each([
      ['true', true, true],
      ['false', false, false],
      ['absent', undefined, false],
    ])('reads commandTerminalsOffered %s as %s', (_label, wireValue, expected) => {
      applyTerminals('project-1', [], wireValue);

      expect(useBoardStore.getState().boardsByProjectId['project-1'].commandTerminalsOffered).toBe(expected);
    });

    it('replaces a project\'s terminals wholesale: a terminal the next snapshot omits is gone', () => {
      applyTerminals('project-1', [commandTerminalWire({ sessionId: 'sess-a', slot: 1 }), commandTerminalWire({ sessionId: 'sess-b', slot: 2 })]);

      applyTerminals('project-1', [commandTerminalWire({ sessionId: 'sess-b', slot: 2 })]);

      expect(selectCommandTerminals(useBoardStore.getState(), 'project-1').map((terminal) => terminal.sessionId)).toEqual(['sess-b']);
    });

    it('keeps one project\'s terminals out of another\'s', () => {
      applyTerminals('project-1', [commandTerminalWire({ sessionId: 'sess-a', slot: 1 })]);
      applyTerminals('project-2', [commandTerminalWire({ sessionId: 'sess-z', slot: 1, projectId: 'project-2' })]);

      expect(selectCommandTerminals(useBoardStore.getState(), 'project-1').map((terminal) => terminal.sessionId)).toEqual(['sess-a']);
      expect(selectCommandTerminals(useBoardStore.getState(), 'project-2').map((terminal) => terminal.sessionId)).toEqual(['sess-z']);
    });

    /**
     * A terminal's name is derived from a prompt someone typed, so it is capped
     * where it is stored: every surface that draws it then holds at most this.
     */
    it('caps an over-long terminal name at the desktop namer\'s own ceiling and leaves a name at the ceiling alone', () => {
      const atCeiling = 'n'.repeat(COMMAND_TERMINAL_NAME_MAX_LENGTH);
      applyTerminals('project-1', [
        commandTerminalWire({ sessionId: 'sess-long', slot: 1, name: 'x'.repeat(COMMAND_TERMINAL_NAME_MAX_LENGTH + 120) }),
        commandTerminalWire({ sessionId: 'sess-edge', slot: 2, name: atCeiling }),
        commandTerminalWire({ sessionId: 'sess-short', slot: 3, name: 'Fix the login bug' }),
      ]);

      const [capped, edge, short] = selectCommandTerminals(useBoardStore.getState(), 'project-1');
      expect(capped.name).toHaveLength(COMMAND_TERMINAL_NAME_MAX_LENGTH);
      expect(edge.name).toBe(atCeiling);
      expect(short.name).toBe('Fix the login bug');
    });
  });

  describe('capCommandTerminalName', () => {
    it('keeps the leading characters of a long name', () => {
      expect(capCommandTerminalName(`Refactor ${'y'.repeat(200)}`).startsWith('Refactor y')).toBe(true);
      expect(capCommandTerminalName('short')).toBe('short');
    });
  });

  describe('selectCommandTerminals', () => {
    it('hands back the stored array itself, so it is safe as a Zustand selector', () => {
      applyTerminals('project-1', [commandTerminalWire({ sessionId: 'sess-a' })]);
      const state = useBoardStore.getState();

      expect(selectCommandTerminals(state, 'project-1')).toBe(state.boardsByProjectId['project-1'].commandTerminals);
    });

    it('returns one stable empty array for no project and for an unknown project', () => {
      const state = useBoardStore.getState();

      const forNull = selectCommandTerminals(state, null);
      expect(forNull).toEqual([]);
      expect(selectCommandTerminals(state, null)).toBe(forNull);
      expect(selectCommandTerminals(state, 'project-unknown')).toBe(forNull);
    });
  });

  describe('selectCommandTerminalsOffered', () => {
    it('is false for no project, an unknown project and an older desktop, and true once a snapshot offers it', () => {
      expect(selectCommandTerminalsOffered(useBoardStore.getState(), null)).toBe(false);
      expect(selectCommandTerminalsOffered(useBoardStore.getState(), 'project-1')).toBe(false);

      applyTerminals('project-1', undefined);
      expect(selectCommandTerminalsOffered(useBoardStore.getState(), 'project-1')).toBe(false);

      applyTerminals('project-1', [], true);
      expect(selectCommandTerminalsOffered(useBoardStore.getState(), 'project-1')).toBe(true);
    });
  });

  describe('selectCommandTerminal', () => {
    beforeEach(() => {
      applyTerminals('project-1', [commandTerminalWire({ sessionId: 'sess-a', slot: 1 })]);
      applyTerminals('project-2', [commandTerminalWire({ sessionId: 'sess-z', slot: 2, projectId: 'project-2' })]);
    });

    it('finds a terminal in any project by its session id, as the stored row', () => {
      const state = useBoardStore.getState();

      expect(selectCommandTerminal(state, 'sess-z')).toBe(state.boardsByProjectId['project-2'].commandTerminals[0]);
      expect(selectCommandTerminal(state, 'sess-a')?.slot).toBe(1);
    });

    it('is null for a null session and for a session no board lists', () => {
      expect(selectCommandTerminal(useBoardStore.getState(), null)).toBeNull();
      expect(selectCommandTerminal(useBoardStore.getState(), 'sess-missing')).toBeNull();
    });
  });

  describe('selectCommandTerminalSessionIds', () => {
    it('is every listed terminal\'s session across all cached boards, and empty with none', () => {
      expect(selectCommandTerminalSessionIds(useBoardStore.getState()).size).toBe(0);

      applyTerminals('project-1', [commandTerminalWire({ sessionId: 'sess-a', slot: 1 }), commandTerminalWire({ sessionId: 'sess-b', slot: 2 })]);
      applyTerminals('project-2', [commandTerminalWire({ sessionId: 'sess-z', slot: 1, projectId: 'project-2' })]);

      expect([...selectCommandTerminalSessionIds(useBoardStore.getState())].sort()).toEqual(['sess-a', 'sess-b', 'sess-z']);
    });
  });

  describe('lowestFreeCommandTerminalSlot', () => {
    it.each([
      ['no slot is taken', [], 1],
      ['slots 1 and 2 are taken', [1, 2], 3],
      ['a gap sits below the highest (1 and 3)', [1, 3], 2],
      ['slot 1 is the one free (2, 3, 4 taken)', [2, 3, 4], 1],
      ['only a slot outside 1 to 4 is held', [7], 1],
    ])('picks the lowest free slot when %s', (_label, occupied, expected) => {
      expect(lowestFreeCommandTerminalSlot(new Set(occupied))).toBe(expected);
    });

    it('is null once all four slots are taken', () => {
      expect(lowestFreeCommandTerminalSlot(new Set([1, 2, 3, 4]))).toBeNull();
    });

    it('agrees with the four-per-project limit it mirrors', () => {
      expect(COMMAND_TERMINAL_LIMIT).toBe(4);
      expect(lowestFreeCommandTerminalSlot(new Set([1, 2, 3]))).toBe(COMMAND_TERMINAL_LIMIT);
    });
  });

  describe('commandTerminalTitle', () => {
    it('is the desktop\'s own "Command Terminal N" for the slot', () => {
      expect(commandTerminalTitle(1)).toBe('Command Terminal 1');
      expect(commandTerminalTitle(4)).toBe('Command Terminal 4');
    });
  });
});
