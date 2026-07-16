import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react-native';
import type { TranscriptEntryWire } from '@kangentic/protocol';
import { ThemeProvider } from '@/components';
import { ConversationTab } from '@/screens/task/ConversationTab';
import { useActivityStore } from '@/state/activityStore';
import { useTranscriptStore } from '@/state/transcriptStore';
import { appendChunk, resetTerminalFeed, retainTerminal } from '@/state/terminalFeed';

jest.mock('@/connection/actions', () => ({
  sendUserMessage: jest.fn().mockResolvedValue(undefined),
  answerPermissionPrompt: jest.fn().mockResolvedValue(undefined),
}));

// EnrichedMarkdownText is a native Fabric component; pass props through a View.
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

// ComposerBar (imported by the tab module) pulls in the dictation engine.
jest.mock('expo-speech-recognition', () => ({
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn().mockReturnValue(true),
    requestPermissionsAsync: jest.fn().mockResolvedValue({ granted: true }),
    start: jest.fn(),
    stop: jest.fn(),
  },
  useSpeechRecognitionEvent: jest.fn(),
}));

const fixtureEntries: TranscriptEntryWire[] = [
  { kind: 'user', uuid: 'user-1', ts: 1, text: 'Fix the login bug' },
  {
    kind: 'assistant',
    uuid: 'assist-1',
    ts: 2,
    blocks: [
      { type: 'text', text: 'Looking at the auth flow now.' },
      { type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'npm run lint' } },
    ],
  },
  { kind: 'tool_result', uuid: 'result-1', ts: 3, toolUseId: 'tool-1', content: 'lint passed', isError: false },
  { kind: 'system', uuid: 'system-1', ts: 4, subtype: 'compaction', text: 'compacted' },
];

function seedStores(): void {
  useTranscriptStore.getState().reset();
  useActivityStore.getState().reset();
  resetTerminalFeed();
  useTranscriptStore.setState({
    bySessionId: { 'sess-1': { entries: fixtureEntries, localRevision: 1 } },
    retainedSessionIds: ['sess-1'],
  });
  useActivityStore.getState().registerSession('sess-1', 'task-1', 'project-1');
}

function renderTab(sessionId: string | null = 'sess-1'): void {
  render(
    <ThemeProvider>
      <ConversationTab taskId="task-1" sessionId={sessionId} projectId="project-1" />
    </ThemeProvider>,
  );
  if (sessionId !== null) {
    // FlashList renders nothing (or, with startRenderingFromBottom, only the
    // bottom item) until it has a measured viewport; jest never lays out, so
    // hand it one.
    fireEvent(screen.getByTestId('conversation-list'), 'layout', {
      nativeEvent: { layout: { x: 0, y: 0, width: 400, height: 800 } },
    });
  }
}

describe('ConversationTab', () => {
  beforeEach(() => {
    seedStores();
  });

  it('shows the empty state without a session', () => {
    renderTab(null);
    expect(screen.getByText('No active session for this task')).toBeTruthy();
  });

  it('renders the flattened transcript cells from the store', () => {
    renderTab();
    expect(screen.getByText('Fix the login bug')).toBeTruthy();
    expect(screen.getByTestId('markdown-cell-assist-1-0').props.markdown).toBe('Looking at the auth flow now.');
    expect(screen.getByTestId('tool-call-tool-1')).toBeTruthy();
    expect(screen.getByText('context compacted')).toBeTruthy();
  });

  it('shows the live tail only while the session is thinking', () => {
    retainTerminal('sess-1');
    appendChunk('sess-1', 'npm install\ncompiling module graph\n');
    renderTab();

    // Idle: buffered bytes exist but the tail stays hidden.
    expect(screen.queryByText('▌ live')).toBeNull();

    act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'activity', state: 'thinking', reason: { kind: 'turn-active' } },
      });
    });
    expect(screen.getByText('▌ live')).toBeTruthy();
    expect(screen.getByText('npm install')).toBeTruthy();
    expect(screen.getByText('compiling module graph')).toBeTruthy();

    act(() => {
      useActivityStore.getState().applyActivityEvent({
        kind: 'activity',
        sessionId: 'sess-1',
        taskId: 'task-1',
        payload: { type: 'activity', state: 'idle', reason: { kind: 'idle' } },
      });
    });
    expect(screen.queryByText('▌ live')).toBeNull();
  });

  it('renders the permission card when a prompt is awaited', () => {
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'permission', promptId: 'sess-1:tool-1', pending: true },
    });
    renderTab();

    expect(screen.getByText('Permission requested')).toBeTruthy();
    expect(screen.getByTestId('permission-approve')).toBeTruthy();
    expect(screen.getByTestId('permission-deny')).toBeTruthy();
    // The body shows the located tool_use's full command (the tool-call
    // cell's summary shows the same text, hence getAllByText).
    expect(screen.getAllByText('npm run lint').length).toBeGreaterThan(0);
  });

  it('renders the generic prompt state when the awaited tool_use is not in the transcript yet', () => {
    useActivityStore.getState().applyActivityEvent({
      kind: 'activity',
      sessionId: 'sess-1',
      taskId: 'task-1',
      payload: { type: 'permission', promptId: 'sess-1:tool-unknown', pending: true },
    });
    renderTab();

    expect(screen.getByText('Permission requested')).toBeTruthy();
    expect(screen.getByText('Waiting for prompt details')).toBeTruthy();
  });
});
