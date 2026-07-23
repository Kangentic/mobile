import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { ThemeProvider } from '@/components';
import { AskUserQuestionCard } from '@/components/conversation/AskUserQuestionCard';
import { answerPermissionPrompt } from '@/connection/actions';
import type { PendingPromptDescriptor } from '@/conversation/transcriptCells';
import { useTerminalUiStore } from '@/state/terminalUiStore';

jest.mock('@/connection/actions', () => ({
  answerPermissionPrompt: jest.fn(),
}));

jest.mock('expo-haptics', () => ({
  impactAsync: jest.fn().mockResolvedValue(undefined),
  notificationAsync: jest.fn().mockResolvedValue(undefined),
  selectionAsync: jest.fn().mockResolvedValue(undefined),
  ImpactFeedbackStyle: { Light: 'light', Medium: 'medium', Heavy: 'heavy' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning', Error: 'error' },
}));

const mockAnswerPermissionPrompt = jest.mocked(answerPermissionPrompt);
const mockImpactAsync = jest.mocked(Haptics.impactAsync);

const questionPrompt: PendingPromptDescriptor = {
  promptId: 'sess-1:tool-9',
  sessionId: 'sess-1',
  toolUseId: 'tool-9',
  toolName: 'AskUserQuestion',
  input: {
    questions: [
      {
        question: 'Which approach should I take?',
        header: 'Approach',
        multiSelect: false,
        options: [
          { label: 'Refactor in place', description: 'Smaller diff' },
          { label: 'Rewrite the module' },
        ],
      },
    ],
  },
  options: null,
};

function renderCard(prompt: PendingPromptDescriptor = questionPrompt): void {
  render(
    <ThemeProvider>
      <AskUserQuestionCard sessionId="sess-1" prompt={prompt} />
    </ThemeProvider>,
  );
}

describe('AskUserQuestionCard', () => {
  beforeEach(() => {
    mockAnswerPermissionPrompt.mockReset();
    mockAnswerPermissionPrompt.mockResolvedValue(undefined);
    mockImpactAsync.mockClear();
    useTerminalUiStore.setState({ requestedModeBySessionId: {}, focusKeyboardRequestBySessionId: {} });
  });

  it('renders the first question with its header and options', () => {
    renderCard();
    expect(screen.getByText('Approach')).toBeTruthy();
    expect(screen.getByText('Which approach should I take?')).toBeTruthy();
    expect(screen.getByText('Refactor in place')).toBeTruthy();
    expect(screen.getByText('Smaller diff')).toBeTruthy();
    expect(screen.getByText('Rewrite the module')).toBeTruthy();
  });

  it('sends the digit keystroke for the tapped option', () => {
    renderCard();
    fireEvent.press(screen.getByTestId('ask-option-0-1'));
    expect(mockAnswerPermissionPrompt).toHaveBeenCalledWith('sess-1', 'sess-1:tool-9', '2');
  });

  it('fires the promptAnswered haptic when an option is tapped', () => {
    renderCard();
    fireEvent.press(screen.getByTestId('ask-option-0-0'));
    expect(mockImpactAsync).toHaveBeenCalledTimes(1);
    expect(mockImpactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
  });

  it('falls back to the generic permission card on malformed input', () => {
    renderCard({ ...questionPrompt, input: { unexpected: 'shape' } });
    expect(screen.getByText('Permission requested')).toBeTruthy();
    expect(screen.getByTestId('permission-approve')).toBeTruthy();
  });

  it('warns on multi-select but still allows single-select taps', () => {
    renderCard({
      ...questionPrompt,
      input: {
        questions: [
          {
            question: 'Pick all that apply',
            multiSelect: true,
            options: [{ label: 'Option one' }, { label: 'Option two' }],
          },
        ],
      },
    });
    expect(screen.getByText('Multi-select question - answer in the Terminal tab for full control')).toBeTruthy();
    fireEvent.press(screen.getByTestId('ask-option-0-0'));
    expect(mockAnswerPermissionPrompt).toHaveBeenCalledWith('sess-1', 'sess-1:tool-9', '1');
  });

  it('notes when more questions follow', () => {
    renderCard({
      ...questionPrompt,
      input: {
        questions: [
          { question: 'First question?', options: [{ label: 'Yes' }] },
          { question: 'Second question?', options: [{ label: 'No' }] },
        ],
      },
    });
    expect(screen.getByText('More questions follow on the desktop after this one')).toBeTruthy();
  });

  it('"Type your own answer..." flips the lens and requests keyboard focus, sending no keystrokes', () => {
    renderCard();
    fireEvent.press(screen.getByTestId('ask-answer-in-terminal'));

    expect(useTerminalUiStore.getState().requestedModeBySessionId['sess-1']).toBe('terminal');
    expect(useTerminalUiStore.getState().focusKeyboardRequestBySessionId['sess-1']).toBe(true);
    // The invariant: free text is NEVER sent as a keystroke into the
    // numbered select.
    expect(mockAnswerPermissionPrompt).not.toHaveBeenCalled();
  });
});
