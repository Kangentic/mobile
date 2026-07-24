import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as Haptics from 'expo-haptics';
import { ThemeProvider } from '@/components';
import { PermissionPromptCard } from '@/components/conversation/PermissionPromptCard';
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
    useTerminalUiStore.setState({ requestedModeBySessionId: {}, focusKeyboardRequestBySessionId: {} });
  });

  it('renders the full Bash command being approved', () => {
    renderCard();
    expect(screen.getByText('Permission requested')).toBeTruthy();
    expect(screen.getByText('Bash')).toBeTruthy();
    expect(screen.getByText('npm run lint\nnpm run test:unit')).toBeTruthy();
  });

  /**
   * Live on a Pixel against a real desktop: an AskUserQuestion ("1 Red /
   * 2 Blue / 3 Type something") reaches the phone in exactly this shape -
   * no tool_use in the transcript yet (the agent blocks at a pre-execution
   * gate) and no published option labels. The card used to claim
   * "Permission requested" and offer Approve, whose '1\r' would have
   * silently selected "Red". An unidentified prompt must not offer a
   * grant-shaped action.
   */
  it('offers no blind action when the prompt kind is unknown - only the terminal', () => {
    renderCard({ ...bashPrompt, toolUseId: null, toolName: null, input: null, options: null });

    // Approve would send '1\r' and could answer "Red" to a question.
    expect(screen.queryByTestId('permission-approve')).toBeNull();
    // Dismissing is equally blind: it might cancel something the user would
    // have accepted. Neither belongs on a prompt the app cannot describe.
    expect(screen.queryByTestId('permission-deny')).toBeNull();
    expect(screen.queryByText('Permission requested')).toBeNull();
    expect(screen.getByText('The agent needs you')).toBeTruthy();
    expect(screen.getByText('Open in terminal')).toBeTruthy();
  });

  it('still shows the waiting-for-details state when the tool is unknown but options were published', () => {
    renderCard({ ...bashPrompt, toolUseId: null, toolName: null, input: null, options: ['Yes', 'No'] });
    expect(screen.getByText('Waiting for prompt details')).toBeTruthy();
    expect(screen.getByTestId('permission-approve')).toBeTruthy();
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

  it('"More options in terminal" flips the lens and requests keyboard focus, sending no keystrokes', () => {
    renderCard();
    fireEvent.press(screen.getByTestId('permission-answer-in-terminal'));

    expect(useTerminalUiStore.getState().requestedModeBySessionId['sess-1']).toBe('terminal');
    expect(useTerminalUiStore.getState().focusKeyboardRequestBySessionId['sess-1']).toBe(true);
    // The invariant: the escape hatch never sends free text (or anything
    // else) as a numbered-select keystroke.
    expect(mockAnswerPermissionPrompt).not.toHaveBeenCalled();
  });
});
