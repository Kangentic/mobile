import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { SessionInputBar } from '@/screens/task/SessionInputBar';
import type { SessionMode } from '@/screens/task/SessionModeToggle';

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
  it('renders the quick keys and PTY composer in terminal mode', () => {
    renderBar('terminal');
    expect(screen.getByTestId('quick-key-esc')).toBeTruthy();
    expect(screen.getByTestId('terminal-input')).toBeTruthy();
    expect(screen.queryByTestId('composer-input')).toBeNull();
  });

  it('renders the agent composer in chat mode', () => {
    renderBar('chat');
    expect(screen.getByTestId('composer-input')).toBeTruthy();
    expect(screen.queryByTestId('terminal-input')).toBeNull();
    expect(screen.queryByTestId('quick-key-esc')).toBeNull();
  });

  it('renders the mode pill in both modes', () => {
    renderBar('terminal');
    expect(screen.getByTestId('session-mode-terminal')).toBeTruthy();
    expect(screen.getByTestId('session-mode-chat')).toBeTruthy();
  });

  it('renders nothing without a session', () => {
    renderBar('terminal', null);
    expect(screen.queryByTestId('session-input-bar')).toBeNull();
  });
});
