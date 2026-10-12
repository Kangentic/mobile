import React from 'react';
import { StyleSheet } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { darkTerminalTheme } from '@/components/theme/tokens';
import { SessionInputBar } from '@/screens/task/SessionInputBar';
import type { SessionMode } from '@/screens/task/SessionModeToggle';

// The footer owns the gesture-nav bottom inset.
jest.mock('react-native-safe-area-context', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  require('react-native-safe-area-context/jest/mock').default,
);

// ComposerBar pulls in the dictation engine.
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn().mockReturnValue(true),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    start: jest.fn(),
    stop: jest.fn(),
  },
  useSpeechRecognitionEvent: jest.fn(),
}));

// The locked-row tests press a real quick key and read whether it reached the
// terminal write.
const mockWriteTerminal = jest.fn();
jest.mock('@/connection/actions', () => ({
  writeTerminal: (sessionId: string, data: string) => mockWriteTerminal(sessionId, data),
  sendUserMessage: jest.fn().mockResolvedValue(undefined),
}));

async function renderBar(mode: SessionMode, sessionId: string | null = 'sess-1'): Promise<void> {
  await render(
    <ThemeProvider>
      <SessionInputBar sessionId={sessionId} mode={mode} onModeChange={jest.fn()} chatAttention={false} />
    </ThemeProvider>,
  );
}

describe('SessionInputBar', () => {
  it('renders the quick keys in terminal mode (no staging field, no mic)', async () => {
    await renderBar('terminal');
    expect(screen.getByTestId('quick-key-esc')).toBeTruthy();
    // Typing happens directly in the terminal (tap raises the keyboard);
    // there is no staging text field and no composer.
    expect(screen.queryByTestId('terminal-input')).toBeNull();
    expect(screen.queryByTestId('composer-input')).toBeNull();
    // Dictation into the PTY is gone: the quick-key row carries only keys,
    // and raising the keyboard gives you its own voice input.
    expect(screen.queryByTestId('terminal-mic')).toBeNull();
  });

  it('renders the agent composer in chat mode', async () => {
    await renderBar('chat');
    expect(screen.getByTestId('composer-input')).toBeTruthy();
    expect(screen.queryByTestId('quick-key-esc')).toBeNull();
  });

  it('renders only the switcher in changes mode', async () => {
    await renderBar('changes');
    expect(screen.getByTestId('session-mode-toggle')).toBeTruthy();
    expect(screen.queryByTestId('composer-input')).toBeNull();
    expect(screen.queryByTestId('quick-key-esc')).toBeNull();
  });

  /** The switcher anchors the footer in every mode; only what sits above it changes. */
  it('renders the surface switcher in every mode', async () => {
    await renderBar('terminal');
    expect(screen.getByTestId('session-mode-toggle')).toBeTruthy();
  });

  /**
   * A sessionless task (paused, or a first start) is a steady state since
   * protocol 0.16.0, not a passing moment. A footer that vanished with the
   * session stranded a screen that opened on a remembered Chat lens: no way
   * back to the Resume panel or the diff. The switcher stays; the mode row,
   * with nothing to type into, does not.
   */
  it.each(['terminal', 'chat', 'changes'] as const)('renders the switcher alone without a session (%s)', async (mode) => {
    await renderBar(mode, null);
    expect(screen.getByTestId('session-mode-toggle')).toBeTruthy();
    expect(screen.queryByTestId('session-input-row')).toBeNull();
    expect(screen.queryByTestId('composer-input')).toBeNull();
    expect(screen.queryByTestId('quick-key-esc')).toBeNull();
  });

  /** A failed Resume's line above the rest of the footer, muted as the desktop draws it (not an error red). */
  it('shows a muted notice above the footer when given one, and none otherwise', async () => {
    const { unmount } = await render(
      <ThemeProvider>
        <SessionInputBar sessionId="sess-1" mode="chat" onModeChange={jest.fn()} chatAttention={false} notice="Session could not be resumed." />
      </ThemeProvider>,
    );
    const notice = screen.getByTestId('session-footer-notice');
    expect(notice).toHaveTextContent('Session could not be resumed.');
    expect(StyleSheet.flatten(notice.props.style).color).toBe(darkTerminalTheme.colors.textMuted);
    await unmount();

    await renderBar('chat');
    expect(screen.queryByTestId('session-footer-notice')).toBeNull();
  });

  /**
   * Held through a session swap: the footer looks exactly as it did (no
   * dimming, nothing new to read) but its mode row takes no touches and
   * leaves the accessibility tree, since it points at a dead PTY. The pill
   * stays live - it is the way out to Changes.
   */
  describe('suspended (the quiet swap window)', () => {
    it('takes no touches on the mode row while suspended, and still switches modes from the pill', async () => {
      const onModeChange = jest.fn();
      await render(
        <ThemeProvider>
          <SessionInputBar sessionId="sess-1" mode="terminal" onModeChange={onModeChange} chatAttention={false} suspended />
        </ThemeProvider>,
      );

      const modeRow = screen.getByTestId('session-input-row', { includeHiddenElements: true });
      expect(modeRow.props.pointerEvents).toBe('none');
      expect(modeRow.props.accessibilityElementsHidden).toBe(true);
      expect(modeRow.props.importantForAccessibility).toBe('no-hide-descendants');
      // Held in place: the keys are still there, just inert.
      expect(screen.getByTestId('quick-key-esc', { includeHiddenElements: true })).toBeTruthy();

      await fireEvent.press(screen.getByTestId('session-mode-chat'));
      expect(onModeChange).toHaveBeenCalledWith('chat');
    });

    it('keeps the mode row live when not suspended', async () => {
      await renderBar('chat');

      const modeRow = screen.getByTestId('session-input-row');
      expect(modeRow.props.pointerEvents).toBe('auto');
      expect(modeRow.props.accessibilityElementsHidden).toBe(false);
    });

    it('renders no mode-row wrapper in changes mode, so nothing adds a gap above the pill', async () => {
      await renderBar('changes');
      expect(screen.queryByTestId('session-input-row')).toBeNull();
    });
  });

  /**
   * A Command Terminal before the desktop has classified its agent (protocol
   * 0.20.0), and one whose start failed: nothing typed may reach the session,
   * because the PTY can still be a bare shell at the project root. The mode row
   * stays in place but is inert exactly as `suspended` holds it; `dimmed`
   * additionally fades it, for the failed start the design draws greyed.
   *
   * The locked state is asserted twice over: as the props that hold it, and as
   * the behaviour they exist for (a pressed key writes nothing), with an
   * unlocked control beside each so a press that never reached the key at all
   * cannot pass for the lock working.
   */
  describe('inputLocked (a Command Terminal that may not be typed into yet)', () => {
    beforeEach(() => {
      mockWriteTerminal.mockReset();
      mockWriteTerminal.mockResolvedValue(undefined);
    });

    async function renderLockableBar(props: { inputLocked?: boolean; dimmed?: boolean; mode?: SessionMode }): Promise<void> {
      await render(
        <ThemeProvider>
          <SessionInputBar
            sessionId="sess-1"
            mode={props.mode ?? 'terminal'}
            onModeChange={jest.fn()}
            chatAttention={false}
            inputLocked={props.inputLocked}
            dimmed={props.dimmed}
          />
        </ThemeProvider>,
      );
    }

    it.each(['terminal', 'chat'] as const)('takes no touches on the %s row and leaves the accessibility tree', async (mode) => {
      await renderLockableBar({ inputLocked: true, mode });

      const modeRow = screen.getByTestId('session-input-row', { includeHiddenElements: true });
      expect(modeRow.props.pointerEvents).toBe('none');
      expect(modeRow.props.accessibilityElementsHidden).toBe(true);
      expect(modeRow.props.importantForAccessibility).toBe('no-hide-descendants');
      // Held in place, not removed: the footer keeps its geometry.
      expect(screen.getByTestId(mode === 'terminal' ? 'quick-key-esc' : 'composer-input', { includeHiddenElements: true })).toBeTruthy();
    });

    it('leaves the row live when not locked', async () => {
      await renderLockableBar({ inputLocked: false });

      const modeRow = screen.getByTestId('session-input-row');
      expect(modeRow.props.pointerEvents).toBe('auto');
      expect(modeRow.props.accessibilityElementsHidden).toBe(false);
      expect(modeRow.props.importantForAccessibility).toBe('auto');
    });

    it('sends nothing when a quick key is pressed while locked, and sends the key once unlocked', async () => {
      await renderLockableBar({ inputLocked: true });
      await fireEvent.press(screen.getByTestId('quick-key-esc', { includeHiddenElements: true }));
      expect(mockWriteTerminal).not.toHaveBeenCalled();
      await screen.unmount();

      await renderLockableBar({ inputLocked: false });
      await fireEvent.press(screen.getByTestId('quick-key-esc'));
      expect(mockWriteTerminal).toHaveBeenCalledTimes(1);
      expect(mockWriteTerminal).toHaveBeenCalledWith('sess-1', expect.any(String));
    });

    it('keeps the mode pill live, since it is the way out to Changes', async () => {
      const onModeChange = jest.fn();
      await render(
        <ThemeProvider>
          <SessionInputBar sessionId="sess-1" mode="terminal" onModeChange={onModeChange} chatAttention={false} inputLocked />
        </ThemeProvider>,
      );

      await fireEvent.press(screen.getByTestId('session-mode-changes'));

      expect(onModeChange).toHaveBeenCalledWith('changes');
    });

    it('applies the faded style only when dimmed', async () => {
      await renderLockableBar({ inputLocked: true, dimmed: true });
      const dimmedRow = screen.getByTestId('session-input-row', { includeHiddenElements: true });
      expect(StyleSheet.flatten(dimmedRow.props.style)?.opacity).toBe(0.4);
      await screen.unmount();

      await renderLockableBar({ inputLocked: true, dimmed: false });
      const lockedRow = screen.getByTestId('session-input-row', { includeHiddenElements: true });
      expect(lockedRow.props.style).toBeUndefined();
    });

    it('does not fade by locking alone, and does not lock by fading alone', async () => {
      await renderLockableBar({ inputLocked: true });
      expect(StyleSheet.flatten(screen.getByTestId('session-input-row', { includeHiddenElements: true }).props.style)?.opacity).toBeUndefined();
      await screen.unmount();

      await renderLockableBar({ dimmed: true });
      const fadedRow = screen.getByTestId('session-input-row');
      expect(StyleSheet.flatten(fadedRow.props.style)?.opacity).toBe(0.4);
      expect(fadedRow.props.pointerEvents).toBe('auto');
    });
  });

  /**
   * Past the end of the session (the waiting card is up, or the user has
   * gone to Chat or Changes from it): keys and messages have nowhere to go,
   * so the footer is the switcher alone in every mode. Not merely inert like
   * `suspended`: the row is gone, so nothing under the card invites a tap.
   */
  describe('switcherOnly (past the end of the session)', () => {
    it.each(['terminal', 'chat'] as const)('renders the switcher alone in %s mode, and it still switches', async (mode) => {
      const onModeChange = jest.fn();
      await render(
        <ThemeProvider>
          <SessionInputBar sessionId="sess-1" mode={mode} onModeChange={onModeChange} chatAttention={false} switcherOnly />
        </ThemeProvider>,
      );

      expect(screen.getByTestId('session-mode-toggle')).toBeTruthy();
      expect(screen.queryByTestId('session-input-row', { includeHiddenElements: true })).toBeNull();
      expect(screen.queryByTestId('quick-key-esc', { includeHiddenElements: true })).toBeNull();
      expect(screen.queryByTestId('composer-input', { includeHiddenElements: true })).toBeNull();

      await fireEvent.press(screen.getByTestId('session-mode-changes'));
      expect(onModeChange).toHaveBeenCalledWith('changes');
    });
  });

  /**
   * A paused session (the terminal lens shows Resume): the quick keys go,
   * since there is no live session to type into, but only in terminal mode.
   * Chat keeps its composer, unlike switcherOnly.
   */
  describe('quickKeysHidden (a paused session)', () => {
    it('drops the quick keys in terminal mode', async () => {
      await render(
        <ThemeProvider>
          <SessionInputBar sessionId="sess-1" mode="terminal" onModeChange={jest.fn()} chatAttention={false} quickKeysHidden />
        </ThemeProvider>,
      );

      expect(screen.queryByTestId('quick-key-esc', { includeHiddenElements: true })).toBeNull();
      expect(screen.getByTestId('session-mode-toggle')).toBeTruthy();
    });

    it('keeps the composer in chat mode', async () => {
      await render(
        <ThemeProvider>
          <SessionInputBar sessionId="sess-1" mode="chat" onModeChange={jest.fn()} chatAttention={false} quickKeysHidden />
        </ThemeProvider>,
      );

      expect(screen.getByTestId('composer-input')).toBeTruthy();
    });
  });
});
