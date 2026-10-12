import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import { DirectKeyInput } from '@/components/terminal/DirectKeyInput';

const mockWriteTerminal = jest.fn();
jest.mock('@/connection/actions', () => ({
  writeTerminal: (sessionId: string, data: string) => mockWriteTerminal(sessionId, data),
}));

/**
 * The field starts with a one-space sentinel (Android reports no change for a
 * backspace on an empty field), so a typed "ls" arrives as the whole value " ls".
 */
const SENTINEL = ' ';

function field(): ReturnType<typeof screen.getByTestId> {
  return screen.getByTestId('terminal-direct-key-input', { includeHiddenElements: true });
}

/**
 * Delivers an edit straight to the field's onChangeText prop. RNTL's
 * `fireEvent.changeText` refuses to fire on a TextInput with `editable={false}`,
 * so using it for the held state would prove RNTL's own check rather than the
 * component's guard: a field that was merely MADE non-editable could still
 * stream every key to the PTY on a platform that delivers the event anyway.
 */
async function deliverEdit(nextText: string): Promise<void> {
  await act(() => {
    field().props.onChangeText(nextText);
  });
}

describe('DirectKeyInput', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockWriteTerminal.mockResolvedValue(undefined);
  });

  describe('with input enabled (the default)', () => {
    it('is editable, and streams appended characters to the PTY', async () => {
      await render(<DirectKeyInput sessionId="sess-1" />);

      expect(field().props.editable).toBe(true);
      await fireEvent.changeText(field(), `${SENTINEL}ls`);

      expect(mockWriteTerminal).toHaveBeenCalledTimes(1);
      expect(mockWriteTerminal).toHaveBeenCalledWith('sess-1', 'ls');
    });

    it('sends only the delta of each edit, and a newline as a carriage return', async () => {
      await render(<DirectKeyInput sessionId="sess-1" inputEnabled />);

      await deliverEdit(`${SENTINEL}ls`);
      await deliverEdit(`${SENTINEL}ls\n`);

      expect(mockWriteTerminal.mock.calls).toEqual([
        ['sess-1', 'ls'],
        ['sess-1', '\r'],
      ]);
    });

    it('sends a deletion as DEL', async () => {
      await render(<DirectKeyInput sessionId="sess-1" />);
      await deliverEdit(`${SENTINEL}ls`);
      mockWriteTerminal.mockClear();

      await deliverEdit(`${SENTINEL}l`);

      expect(mockWriteTerminal).toHaveBeenCalledWith('sess-1', '\x7f');
    });
  });

  describe('with input held', () => {
    it('is not editable', async () => {
      await render(<DirectKeyInput sessionId="sess-1" inputEnabled={false} />);

      expect(field().props.editable).toBe(false);
    });

    it('sends nothing for an appended character, a newline or a deletion', async () => {
      await render(<DirectKeyInput sessionId="sess-1" inputEnabled={false} />);

      await deliverEdit(`${SENTINEL}rm -rf /`);
      await deliverEdit(`${SENTINEL}rm -rf /\n`);
      await deliverEdit(`${SENTINEL}rm`);
      // The buffer fully deleted: the path that sends DEL for the whole previous value.
      await deliverEdit('');

      expect(mockWriteTerminal).not.toHaveBeenCalled();
    });

    it('sends nothing for a tail replacement (an autocorrect rewrite) either', async () => {
      await render(<DirectKeyInput sessionId="sess-1" inputEnabled={false} />);

      await deliverEdit(`${SENTINEL}teh`);
      await deliverEdit(`${SENTINEL}the`);

      expect(mockWriteTerminal).not.toHaveBeenCalled();
    });
  });

  describe('as the gate changes under a mounted field', () => {
    it('stops sending the moment input is held, even for an edit already in flight', async () => {
      const { rerender } = await render(<DirectKeyInput sessionId="sess-1" inputEnabled />);
      await deliverEdit(`${SENTINEL}ls`);
      expect(mockWriteTerminal).toHaveBeenCalledTimes(1);

      await rerender(<DirectKeyInput sessionId="sess-1" inputEnabled={false} />);
      expect(field().props.editable).toBe(false);
      await deliverEdit(`${SENTINEL}ls -la`);

      expect(mockWriteTerminal).toHaveBeenCalledTimes(1);
    });

    it('starts sending once the desktop has classified the agent and input opens', async () => {
      const { rerender } = await render(<DirectKeyInput sessionId="sess-1" inputEnabled={false} />);
      await deliverEdit(`${SENTINEL}typed-while-held`);
      expect(mockWriteTerminal).not.toHaveBeenCalled();

      await rerender(<DirectKeyInput sessionId="sess-1" inputEnabled />);
      expect(field().props.editable).toBe(true);
      await deliverEdit(`${SENTINEL}typed-while-held!`);

      // The edit that was dropped while held is not replayed: only what is typed once open goes out.
      expect(mockWriteTerminal).toHaveBeenCalledTimes(1);
      expect(mockWriteTerminal).toHaveBeenCalledWith('sess-1', '!');
    });
  });
});
