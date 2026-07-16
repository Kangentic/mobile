import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { Badge, Card, Stack, Text, useTheme } from '@/components';
import type { PendingPromptDescriptor } from '@/conversation/transcriptCells';
import { parseAskUserQuestionInput } from '@/conversation/pendingPromptSummary';
import { askUserQuestionOptionKeystrokes } from '@/conversation/promptKeystrokes';
import { PermissionPromptCard } from './PermissionPromptCard';
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
          {firstQuestion.options.map((option, optionIndex) => {
            const selectable = optionIndex <= MAX_SELECTABLE_OPTION_INDEX;
            return (
              <Pressable
                key={optionIndex}
                accessibilityRole="button"
                accessibilityState={{ disabled: optionsDisabled || !selectable }}
                testID={`ask-option-0-${optionIndex}`}
                disabled={optionsDisabled || !selectable}
                onPress={() => submit(askUserQuestionOptionKeystrokes(optionIndex))}
                style={({ pressed }) => [
                  styles.optionRow,
                  {
                    minHeight: theme.minTouchSize,
                    backgroundColor: theme.colors.surfaceRaised,
                    borderColor: theme.colors.border,
                    borderRadius: theme.radii.sm,
                    padding: theme.spacing.sm,
                    opacity: optionsDisabled || !selectable ? 0.5 : pressed ? 0.7 : 1,
                  },
                ]}
              >
                <Text variant="bodyStrong" color="primary">
                  {option.label}
                </Text>
                {option.description !== null ? (
                  <Text variant="caption" color="secondary">
                    {option.description}
                  </Text>
                ) : null}
              </Pressable>
            );
          })}
          {parsedInput.questions.length > 1 ? (
            <Text variant="caption" color="muted">
              More questions follow on the desktop after this one
            </Text>
          ) : null}
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

const styles = StyleSheet.create({
  optionRow: {
    borderWidth: StyleSheet.hairlineWidth,
    justifyContent: 'center',
  },
});
