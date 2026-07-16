import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { NeedsYouCard } from '@/screens/home/NeedsYouCard';
import type { SessionActivityEntry } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';

const mockPush = jest.fn();
jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: mockPush }),
}));

const mockPeekAwaitedPrompt = jest.fn();
jest.mock('@/connection/actions', () => ({
  peekAwaitedPrompt: (sessionId: string, promptId: string) => mockPeekAwaitedPrompt(sessionId, promptId),
}));

function entryFixture(overrides: Partial<SessionActivityEntry> = {}): SessionActivityEntry {
  return {
    sessionId: 'sess-1',
    taskId: 'task-1',
    projectId: 'project-1',
    state: 'permission',
    reason: { kind: 'permission' },
    usage: null,
    awaitedPromptId: 'sess-1:tool-1',
    lastEventAt: 0,
    unreadCount: 0,
    feedStatus: 'live',
    ...overrides,
  };
}

function renderCard(entry: SessionActivityEntry): void {
  render(
    <ThemeProvider>
      <NeedsYouCard entry={entry} />
    </ThemeProvider>,
  );
}

describe('NeedsYouCard', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPeekAwaitedPrompt.mockResolvedValue(null);
    useBoardStore.getState().reset();
  });

  it('teases the decision without any inline answer controls', async () => {
    renderCard(entryFixture());
    expect(await screen.findByText('Waiting for your approval')).toBeTruthy();
    expect(screen.getByText('Review and approve')).toBeTruthy();
    // Answering happens IN the session, never from Home.
    expect(screen.queryByTestId('permission-approve')).toBeNull();
    expect(screen.queryByTestId('permission-deny')).toBeNull();
  });

  it('upgrades the summary to the exact command when the peek resolves', async () => {
    mockPeekAwaitedPrompt.mockResolvedValue({
      toolUseId: 'tool-1',
      name: 'Bash',
      input: { command: 'npm run lint' },
    });
    renderCard(entryFixture());
    expect(await screen.findByText('Approve: npm run lint')).toBeTruthy();
  });

  it('labels question prompts as answerable in the session', async () => {
    mockPeekAwaitedPrompt.mockResolvedValue({
      toolUseId: 'tool-1',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Which auth method should the fix use?',
            header: 'Auth',
            multiSelect: false,
            options: [{ label: 'OAuth', description: 'The hosted flow.' }],
          },
        ],
      },
    });
    renderCard(entryFixture());
    expect(await screen.findByText('Which auth method should the fix use?')).toBeTruthy();
    expect(screen.getByText('Answer in session')).toBeTruthy();
  });

  it('opens the task in chat mode on tap', () => {
    renderCard(entryFixture());
    fireEvent.press(screen.getByTestId('needs-you-card-sess-1'));
    expect(mockPush).toHaveBeenCalledWith({
      pathname: '/task/[taskId]',
      params: { taskId: 'task-1', sessionId: 'sess-1', projectId: 'project-1', mode: 'chat' },
    });
  });
});
