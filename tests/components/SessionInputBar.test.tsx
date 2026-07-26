import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
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

function renderBar(mode: SessionMode, sessionId: string | null = 'sess-1'): void {
  render(
    <ThemeProvider>
      <SessionInputBar sessionId={sessionId} mode={mode} onModeChange={jest.fn()} chatAttention={false} />
    </ThemeProvider>,
  );
}

describe('SessionInputBar', () => {
  it('renders quick keys and the dictation mic in terminal mode (no staging field)', () => {
    renderBar('terminal');
    expect(screen.getByTestId('quick-key-esc')).toBeTruthy();
    expect(screen.getByTestId('terminal-mic')).toBeTruthy();
    // Typing happens directly in the terminal (tap raises the keyboard);
    // there is no staging text field and no composer.
    expect(screen.queryByTestId('terminal-input')).toBeNull();
    expect(screen.queryByTestId('composer-input')).toBeNull();
  });

  it('renders the agent composer in chat mode', () => {
    renderBar('chat');
    expect(screen.getByTestId('composer-input')).toBeTruthy();
    expect(screen.queryByTestId('terminal-mic')).toBeNull();
    expect(screen.queryByTestId('quick-key-esc')).toBeNull();
  });

  it('renders only the switcher in changes mode', () => {
    renderBar('changes');
    expect(screen.getByTestId('session-mode-toggle')).toBeTruthy();
    expect(screen.queryByTestId('composer-input')).toBeNull();
    expect(screen.queryByTestId('quick-key-esc')).toBeNull();
    expect(screen.queryByTestId('terminal-mic')).toBeNull();
  });

  /** The switcher anchors the footer in every mode; only what sits above it changes. */
  it('renders the surface switcher in every mode', () => {
    renderBar('terminal');
    expect(screen.getByTestId('session-mode-toggle')).toBeTruthy();
  });

  it('renders nothing without a session', () => {
    renderBar('terminal', null);
    expect(screen.queryByTestId('session-input-bar')).toBeNull();
  });
});
