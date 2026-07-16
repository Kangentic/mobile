import React from 'react';
import { render, screen } from '@testing-library/react-native';
import { ThemeProvider } from '@/components';
import { NeedsYouCard } from '@/screens/home/NeedsYouCard';
import type { SessionActivityEntry } from '@/state/activityStore';
import { useBoardStore } from '@/state/boardStore';

jest.mock('expo-router', () => ({
  useRouter: () => ({ replace: jest.fn(), back: jest.fn(), push: jest.fn() }),
}));

const mockPeekAwaitedPrompt = jest.fn();
jest.mock('@/connection/actions', () => ({
  peekAwaitedPrompt: (sessionId: string, promptId: string) => mockPeekAwaitedPrompt(sessionId, promptId),
  answerPermissionPrompt: jest.fn().mockResolvedValue(undefined),
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
    mockPeekAwaitedPrompt.mockReset();
    useBoardStore.getState().reset();
  });

  it('renders the generic answerable state while the peek is unresolved', async () => {
    mockPeekAwaitedPrompt.mockResolvedValue(null);
    renderCard(entryFixture());
    expect(await screen.findByText('Waiting for your approval')).toBeTruthy();
    expect(screen.getByTestId('permission-approve')).toBeTruthy();
    expect(screen.getByTestId('permission-deny')).toBeTruthy();
  });

  it('upgrades to the specific permission card when the peek resolves a tool', async () => {
    mockPeekAwaitedPrompt.mockResolvedValue({
      toolUseId: 'tool-1',
      name: 'Bash',
      input: { command: 'npm run lint' },
    });
    renderCard(entryFixture());
    // The specific card shows the exact command; the generic one-line
    // summary retires once the peek resolves (no duplicated content).
    expect(await screen.findByText('npm run lint')).toBeTruthy();
    expect(screen.queryByText('Waiting for your approval')).toBeNull();
  });

  it('renders the question card when the peek resolves an AskUserQuestion', async () => {
    mockPeekAwaitedPrompt.mockResolvedValue({
      toolUseId: 'tool-1',
      name: 'AskUserQuestion',
      input: {
        questions: [
          {
            question: 'Which auth method should the fix use?',
            header: 'Auth',
            multiSelect: false,
            options: [
              { label: 'OAuth', description: 'The hosted flow.' },
              { label: 'JWT', description: 'Self-managed tokens.' },
            ],
          },
        ],
      },
    });
    renderCard(entryFixture());
    expect(await screen.findByText('Which auth method should the fix use?')).toBeTruthy();
    expect(screen.getByText('OAuth')).toBeTruthy();
  });
});
