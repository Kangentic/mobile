import React from 'react';
import { View } from 'react-native';
import { Badge, Card, Stack, Text, useTheme } from '@/components';
import { triggerHaptic } from '@/lib/haptics';
import type { PendingPromptDescriptor } from '@/conversation/transcriptCells';
import { parseAskUserQuestionInput } from '@/conversation/pendingPromptSummary';
import { askUserQuestionOptionKeystrokes } from '@/conversation/promptKeystrokes';
import { useTerminalUiStore } from '@/state/terminalUiStore';
import { PermissionPromptCard } from './PermissionPromptCard';
import { PromptOptionRow } from './PromptOptionRow';
import { usePromptAnswer } from './usePromptAnswer';

export interface AskUserQuestionCardProps {
  sessionId: string;
  prompt: PendingPromptDescriptor;
}

/** The TUI digit select covers options 1-9, so only the first 9 options are tappable here. */
const MAX_SELECTABLE_OPTION_INDEX = 8;

/**
 * The pending AskUserQuestion as tappable option rows. Renders the FIRST
 * question only (the desktop walks any follow-ups); a tap sends the option's
 * digit keystroke. Malformed input falls back to the generic permission
 * card so the prompt always stays answerable.
 */
export function AskUserQuestionCard({ sessionId, prompt }: AskUserQuestionCardProps): React.JSX.Element {
  const theme = useTheme();
  const { answering, answeredNote, errorNote, submit } = usePromptAnswer(sessionId, prompt.promptId);

  const parsedInput = prompt.input === null ? null : parseAskUserQuestionInput(prompt.input);
  if (parsedInput === null) {
    return <PermissionPromptCard sessionId={sessionId} prompt={prompt} />;
  }

  const firstQuestion = parsedInput.questions[0];
  const optionsDisabled = answering || answeredNote !== null;

  return (
    <View style={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }}>
      <Card testID="ask-user-question-card" style={{ borderColor: theme.colors.warning, borderWidth: 1 }}>
        <Stack gap="sm">
          {firstQuestion.header !== null ? <Badge label={firstQuestion.header} color="warning" /> : null}
          <Text variant="bodyStrong" color="primary">
            {firstQuestion.question}
          </Text>
          {firstQuestion.multiSelect ? (
            <Text variant="caption" color="warning">
              Multi-select question - answer in the Terminal tab for full control
            </Text>
          ) : null}
          <Stack gap="xs">
            {firstQuestion.options.map((option, optionIndex) => {
              const selectable = optionIndex <= MAX_SELECTABLE_OPTION_INDEX;
              return (
                <PromptOptionRow
                  key={optionIndex}
                  label={option.label}
                  description={option.description ?? undefined}
                  testID={`ask-option-0-${optionIndex}`}
                  disabled={optionsDisabled || !selectable}
                  onPress={() => {
                    triggerHaptic('promptAnswered');
                    submit(askUserQuestionOptionKeystrokes(optionIndex));
                  }}
                />
              );
            })}
          </Stack>
          {parsedInput.questions.length > 1 ? (
            <Text variant="caption" color="muted">
              More questions follow on the desktop after this one
            </Text>
          ) : null}
          {/* The agent-agnostic escape hatch for the TUI's implicit "type
              your own answer" option (and multi-select): one tap lands the
              user at the real prompt in the terminal lens. Free text is
              NEVER sent as keystrokes into a numbered select. */}
          <PromptOptionRow
            label="Type your own answer..."
            description="Opens the terminal at this prompt"
            muted
            testID="ask-answer-in-terminal"
            disabled={optionsDisabled}
            onPress={() => useTerminalUiStore.getState().requestSessionMode(sessionId, 'terminal', { focusKeyboard: true })}
          />
          {answeredNote !== null ? (
            <Text variant="caption" color="secondary">
              {answeredNote}
            </Text>
          ) : null}
          {errorNote !== null ? (
            <Text variant="caption" color="danger">
              {errorNote}
            </Text>
          ) : null}
        </Stack>
      </Card>
    </View>
  );
}

