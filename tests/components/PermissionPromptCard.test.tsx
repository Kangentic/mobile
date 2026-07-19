import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { ThemeProvider } from '@/components';
import { PermissionPromptCard } from '@/components/conversation/PermissionPromptCard';
import { answerPermissionPrompt } from '@/connection/actions';
import type { PendingPromptDescriptor } from '@/conversation/transcriptCells';

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

const bashPrompt: PendingPromptDescriptor = {
  promptId: 'sess-1:tool-1',
  sessionId: 'sess-1',
  toolUseId: 'tool-1',
  toolName: 'Bash',
  input: { command: 'npm run lint\nnpm run test:unit' },
  options: null,
};

function renderCard(prompt: PendingPromptDescriptor = bashPrompt): void {
  render(
    <ThemeProvider>
      <PermissionPromptCard sessionId="sess-1" prompt={prompt} />
    </ThemeProvider>,
  );
}

describe('PermissionPromptCard', () => {
  beforeEach(() => {
    mockAnswerPermissionPrompt.mockReset();
    mockAnswerPermissionPrompt.mockResolvedValue(undefined);
    mockImpactAsync.mockClear();
  });

  it('renders the full Bash command being approved', () => {
    renderCard();
    expect(screen.getByText('Permission requested')).toBeTruthy();
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('npm run lint\nnpm run test:unit')).toBeTruthy();
  });

  it('renders the generic state when the tool_use has not been located yet', () => {
    renderCard({ ...bashPrompt, toolUseId: null, toolName: null, input: null });
    expect(screen.getByText('Waiting for prompt details')).toBeTruthy();
  });

  it('approve answers with the approve keystrokes', () => {
    renderCard();
    fireEvent.press(screen.getByTestId('permission-approve'));
    expect(mockAnswerPermissionPrompt).toHaveBeenCalledWith('sess-1', 'sess-1:tool-1', '1\r');
  });

  it('deny answers with escape', () => {
    renderCard();
    fireEvent.press(screen.getByTestId('permission-deny'));
    expect(mockAnswerPermissionPrompt).toHaveBeenCalledWith('sess-1', 'sess-1:tool-1', '\u001b');
  });

  it('renders every probed option as a digit button when options are present', () => {
    renderCard({
      ...bashPrompt,
      options: ['Yes', "Yes, and don't ask again for this command", 'No, and tell Claude what to do differently'],
    });
    // Option 1 keeps the approve identity; the rest are numbered options.
    expect(screen.getByText('Yes')).toBeTruthy();
    fireEvent.press(screen.getByTestId('permission-option-1'));
    expect(mockAnswerPermissionPrompt).toHaveBeenCalledWith('sess-1', 'sess-1:tool-1', '2\r');
    // The binary Deny is replaced by the dialog's own reject option.
    expect(screen.queryByTestId('permission-deny')).toBeNull();
  });

  it('option 1 keeps the approve identity and its digit keystrokes', () => {
    renderCard({ ...bashPrompt, options: ['Yes', 'No'] });
    fireEvent.press(screen.getByTestId('permission-approve'));
    expect(mockAnswerPermissionPrompt).toHaveBeenCalledWith('sess-1', 'sess-1:tool-1', '1\r');
  });

  it('fires the promptAnswered haptic on approve', () => {
    renderCard();
    fireEvent.press(screen.getByTestId('permission-approve'));
    expect(mockImpactAsync).toHaveBeenCalledTimes(1);
    expect(mockImpactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
  });

  it('fires the promptAnswered haptic on deny', () => {
    renderCard();
    fireEvent.press(screen.getByTestId('permission-deny'));
    expect(mockImpactAsync).toHaveBeenCalledTimes(1);
    expect(mockImpactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);
  });

  it('disables both buttons while the answer is pending', () => {
    mockAnswerPermissionPrompt.mockReturnValue(new Promise<void>(() => undefined));
    renderCard();
    fireEvent.press(screen.getByTestId('permission-approve'));
    expect(screen.getByTestId('permission-approve').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('permission-deny').props.accessibilityState.disabled).toBe(true);
  });

  it('stays disabled after a successful answer', async () => {
    renderCard();
    fireEvent.press(screen.getByTestId('permission-approve'));
    await waitFor(() =>
      expect(screen.getByTestId('permission-approve').props.accessibilityState.disabled).toBe(true),
    );
  });

  it('shows the already-answered note on a stale-prompt rejection and stays disabled', async () => {
    mockAnswerPermissionPrompt.mockRejectedValue(
      new Error('Prompt sess-1:tool-1 does not match the awaited prompt'),
    );
    renderCard();
    fireEvent.press(screen.getByTestId('permission-approve'));
    expect(await screen.findByText('Already answered on the desktop')).toBeTruthy();
    expect(screen.getByTestId('permission-approve').props.accessibilityState.disabled).toBe(true);
    expect(screen.getByTestId('permission-deny').props.accessibilityState.disabled).toBe(true);
  });

  it('re-enables and shows the message on any other error', async () => {
    mockAnswerPermissionPrompt.mockRejectedValue(new Error('Relay unreachable'));
    renderCard();
    fireEvent.press(screen.getByTestId('permission-approve'));
    expect(await screen.findByText('Relay unreachable')).toBeTruthy();
    expect(screen.getByTestId('permission-approve').props.accessibilityState.disabled).toBe(false);
  });
});
