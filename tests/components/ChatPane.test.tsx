import React from 'react';
import { act, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { ChatPane } from '@/screens/task/ChatPane';
import { useReadingViewStore } from '@/state/readingViewStore';
import { useTranscriptStore } from '@/state/transcriptStore';

jest.mock('@/connection/actions', () => ({
  sendUserMessage: jest.fn().mockResolvedValue(undefined),
  answerPermissionPrompt: jest.fn().mockResolvedValue(undefined),
  loadTranscriptTail: jest.fn().mockResolvedValue(undefined),
  loadOlderTranscript: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('react-native-enriched-markdown', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const ReactModule = require('react');
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- lazy require, evaluated inside the mock factory
  const { View } = require('react-native');
  return {
    __esModule: true,
    EnrichedMarkdownText: (props: object) => ReactModule.createElement(View, props),
  };
});

jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn().mockReturnValue(true),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    start: jest.fn(),
    stop: jest.fn(),
  },
  useSpeechRecognitionEvent: jest.fn(),
}));

function seedTranscript(sessionId: string, totalEntries: number): void {
  useTranscriptStore.setState({
    bySessionId: {
      [sessionId]: {
        // A window has landed. For totalEntries 0 that is the whole point:
        // "the desktop answered, and this session has no structured
        // transcript" is what selects the reading-view lens, and it must not
        // be confused with "the window has not come back yet".
        hasWindow: true,
        entries:
          totalEntries > 0
            ? [{ kind: 'user' as const, uuid: 'u-1', ts: 1, text: 'Structured entry' }]
            : [],
        startIndex: 0,
        totalEntries,
        revision: 1,
        tailRevision: 1,
        needsTailFetch: false,
      },
    },
    retainedSessionIds: [sessionId],
  });
}

function renderPane(sessionId: string | null): void {
  render(
    <ThemeProvider>
      <ChatPane taskId="task-1" sessionId={sessionId} projectId="project-1" agentLabel="codex" />
    </ThemeProvider>,
  );
}

describe('ChatPane lens selection', () => {
  beforeEach(() => {
    useTranscriptStore.getState().reset();
    useReadingViewStore.getState().reset();
  });

  it('shows the loading note before the transcript window loads', () => {
    renderPane('sess-1');
    expect(screen.getByTestId('chat-pane-loading')).toBeTruthy();
  });

  it('renders the conversation feed for a structured transcript', () => {
    seedTranscript('sess-1', 1);
    renderPane('sess-1');
    expect(screen.getByText('Structured entry')).toBeTruthy();
    expect(screen.queryByTestId('reading-view-caption')).toBeNull();
  });

  it('renders the reading view for a loaded-but-empty transcript', () => {
    seedTranscript('sess-1', 0);
    act(() => {
      useReadingViewStore.getState().applyCleanLines('sess-1', ['Refactoring invoice.ts'], false);
    });
    renderPane('sess-1');
    expect(screen.getByTestId('reading-view-caption')).toBeTruthy();
    expect(screen.getByText(/codex session/)).toBeTruthy();
  });

  /**
   * A transcript delta can beat the window request and create the store entry
   * with a real totalEntries and no entries at all (transcriptStore's
   * revision === -1 branch). Routing on totalEntries alone sent that state to
   * the conversation feed, which rendered zero cells and no loading note - a
   * blank chat screen, seen live on a Pixel.
   */
  it('keeps the loading note when a delta lands before the window', () => {
    useTranscriptStore.setState({
      bySessionId: {
        'sess-1': {
          hasWindow: false,
          entries: [],
          startIndex: 0,
          totalEntries: 476,
          revision: 312,
          tailRevision: 0,
          needsTailFetch: true,
        },
      },
      retainedSessionIds: ['sess-1'],
    });
    renderPane('sess-1');
    expect(screen.getByTestId('chat-pane-loading')).toBeTruthy();
    expect(screen.queryByTestId('conversation-list')).toBeNull();
  });

  /**
   * `revision` is a raw wire number with no reserved "none" value, so the
   * lens choice must not read a sentinel out of it. A transcript-less
   * session whose window happens to report revision -1 still has a window,
   * and must reach the reading view rather than load forever.
   */
  it('picks the reading view even when the landed window reports revision -1', () => {
    useTranscriptStore.setState({
      bySessionId: {
        'sess-1': { hasWindow: true, entries: [], startIndex: 0, totalEntries: 0, revision: -1, tailRevision: 1, needsTailFetch: false },
      },
      retainedSessionIds: ['sess-1'],
    });
    renderPane('sess-1');
    expect(screen.getByTestId('reading-view-caption')).toBeTruthy();
    expect(screen.queryByTestId('chat-pane-loading')).toBeNull();
  });

  it('shows the no-session empty state without a session', () => {
    renderPane(null);
    expect(screen.getByText('No active session for this task')).toBeTruthy();
  });
});
