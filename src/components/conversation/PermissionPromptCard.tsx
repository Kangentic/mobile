import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { isRecord, type JsonValue } from '@kangentic/protocol';
import { Badge, Button, Card, Icon, MarkdownBlock, MonoText, Row, Stack, Text, useTheme } from '@/components';
import { triggerHaptic } from '@/lib/haptics';
import { buildUnifiedDiffLines } from '@/diff/diffLines';
import type { PendingPromptDescriptor } from '@/conversation/transcriptCells';
import { approvePermissionKeystrokes, denyPermissionKeystrokes, permissionOptionKeystrokes } from '@/conversation/promptKeystrokes';
import { useTerminalUiStore } from '@/state/terminalUiStore';
import { PromptOptionRow } from './PromptOptionRow';
import { InlineDiff } from './InlineDiff';
import { MonoBlock } from './MonoBlock';
import { usePromptAnswer } from './usePromptAnswer';

export interface PermissionPromptCardProps {
  sessionId: string;
  prompt: PendingPromptDescriptor;
}

const BODY_MAX_HEIGHT = 300;
const WRITE_PREVIEW_LINE_COUNT = 20;

function stringInputField(input: JsonValue | null, fieldName: string): string | null {
  if (input === null || !isRecord(input)) {
    return null;
  }
  const fieldValue = input[fieldName];
  return typeof fieldValue === 'string' ? fieldValue : null;
}

/** Renders EXACTLY what approving grants: the command, the diff, the file content, or the plan. */
function PermissionPromptBody({ toolName, input }: { toolName: string; input: JsonValue | null }): React.JSX.Element {
  const theme = useTheme();

  if (toolName === 'Bash') {
    const command = stringInputField(input, 'command');
    if (command !== null) {
      return <MonoBlock text={command} size="body" />;
    }
  }

  if (toolName === 'Edit') {
    const oldString = stringInputField(input, 'old_string');
    const newString = stringInputField(input, 'new_string');
    if (oldString !== null && newString !== null) {
      const filePath = stringInputField(input, 'file_path');
      return (
        <Stack gap="xs">
          {filePath !== null ? (
            <MonoText size="caption" color="secondary" numberOfLines={1}>
              {filePath}
            </MonoText>
          ) : null}
          <InlineDiff lines={buildUnifiedDiffLines(oldString, newString)} />
        </Stack>
      );
    }
  }

  if (toolName === 'Write') {
    const content = stringInputField(input, 'content');
    if (content !== null) {
      const filePath = stringInputField(input, 'file_path');
      const contentLines = content.split('\n');
      const previewText = contentLines.slice(0, WRITE_PREVIEW_LINE_COUNT).join('\n');
      return (
        <Stack gap="xs">
          {filePath !== null ? (
            <MonoText size="caption" color="secondary" numberOfLines={1}>
              {filePath}
            </MonoText>
          ) : null}
          <MonoBlock text={contentLines.length > WRITE_PREVIEW_LINE_COUNT ? `${previewText}\n...` : previewText} />
        </Stack>
      );
    }
  }

  if (toolName === 'ExitPlanMode') {
    const plan = stringInputField(input, 'plan');
    return (
      <Stack gap="xs">
        <Text variant="body" color="secondary">
          The agent wants to exit plan mode and start implementing.
        </Text>
        {plan !== null ? (
          <ScrollView
            style={{
              maxHeight: BODY_MAX_HEIGHT,
              backgroundColor: theme.colors.codeBackground,
              borderRadius: theme.radii.sm,
              padding: theme.spacing.sm,
            }}
            nestedScrollEnabled
          >
            <MarkdownBlock markdown={plan} testID="permission-plan-markdown" />
          </ScrollView>
        ) : null}
      </Stack>
    );
  }

  return <MonoBlock text={JSON.stringify(input, null, 2)} maxHeight={BODY_MAX_HEIGHT} color="secondary" />;
}

/** The Claude-Code-style framing line: say what approving actually does. */
function framingLineForTool(toolName: string): string {
  switch (toolName) {
    case 'Bash':
      return 'The agent wants to run this command';
    case 'Edit':
      return 'The agent wants to make this edit';
    case 'Write':
    case 'NotebookEdit':
      return 'The agent wants to write this file';
    case 'Read':
      return 'The agent wants to read this file';
    case 'ExitPlanMode':
      return 'The agent finished planning';
    default:
      return `The agent wants to use ${toolName}`;
  }
}

/**
 * The pending permission prompt, styled like the desktop's own prompt
 * moment rather than a form: an amber-bordered card (no rails - the
 * design avoids left accent bars) with a framing line ("The agent wants
 * to run this command"), the exact grant as the body, a full-width
 * Approve, and a deliberately quieter Deny (denying is the escape hatch,
 * not a co-equal call to action). Answers ride the interactive-terminal
 * keystroke path and disable once in flight.
 */
export function PermissionPromptCard({ sessionId, prompt }: PermissionPromptCardProps): React.JSX.Element {
  const theme = useTheme();
  const { answering, answeredNote, errorNote, submit } = usePromptAnswer(sessionId, prompt.promptId);
  const buttonsDisabled = answering || answeredNote !== null;
  // Bind the array (not just a boolean) so the render below stays narrowed.
  const publishedOptions = prompt.options !== null && prompt.options.length >= 2 ? prompt.options : null;
  /**
   * Nothing identifies this prompt: no tool (the agent blocks at a
   * pre-execution gate, so its tool_use is not in the transcript yet) and no
   * published option labels. It may not be a permission request at all - a
   * live AskUserQuestion ("1 Red / 2 Blue / 3 Type something") arrives in
   * exactly this shape. Approve sends '1\r', which would silently pick the
   * FIRST ANSWER of a question rather than granting anything, so the card
   * must not offer it here: name the uncertainty and route to the terminal.
   */
  const kindUnknown = prompt.toolName === null && publishedOptions === null;

  return (
    <View style={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }}>
      <Card testID="permission-prompt-card" style={{ borderColor: theme.colors.accentMuted, borderWidth: 1 }}>
        <Stack gap="sm">
            <Row gap="sm" style={styles.headerRow}>
              <Icon name={kindUnknown ? 'agent' : 'shield-half'} color="accent" size={18} />
              <Text variant="bodyStrong" color="accent" style={styles.flex}>
                {kindUnknown ? 'The agent needs you' : 'Permission requested'}
              </Text>
              {prompt.toolName !== null ? <Badge label={prompt.toolName} color="secondary" /> : null}
            </Row>
            {prompt.toolName === null ? (
              <Text variant="body" color="secondary">
                {kindUnknown ? 'Open the terminal to see what it is asking.' : 'Waiting for prompt details'}
              </Text>
            ) : (
              <>
                <Text variant="caption" color="secondary">
                  {framingLineForTool(prompt.toolName)}
                </Text>
                <PermissionPromptBody toolName={prompt.toolName} input={prompt.input} />
              </>
            )}
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
            {publishedOptions !== null ? (
              // FULL-FIDELITY MODE: the desktop's PTY probe published the
              // dialog's actual numbered options; render every one as an
              // identical outlined row (no primary emphasis - the choice is
              // the user's, none is blessed). Option 1 keeps the approve
              // testID for flow continuity.
              <Stack gap="xs">
                {publishedOptions.map((optionLabel, optionIndex) => (
                  <PromptOptionRow
                    key={optionIndex}
                    label={optionLabel}
                    testID={optionIndex === 0 ? 'permission-approve' : `permission-option-${optionIndex}`}
                    disabled={buttonsDisabled || optionIndex > 8}
                    onPress={() => {
                      triggerHaptic('promptAnswered');
                      submit(permissionOptionKeystrokes(optionIndex));
                    }}
                  />
                ))}
              </Stack>
            ) : kindUnknown ? (
              // UNKNOWN PROMPT: no blind actions at all. A digit could answer
              // the wrong question, and dismissing is equally blind - it might
              // cancel something the user would have said yes to. The only
              // honest move is to go look, so the terminal row below is the
              // sole action.
              null
            ) : (
              // Equal-weight pair: approving and denying are both one tap on
              // a known permission request, so they share the row evenly.
              <Row gap="sm" style={styles.actionRow}>
                <View style={styles.flex}>
                  <Button
                    label={answering ? 'Approving...' : 'Approve'}
                    variant="primary"
                    testID="permission-approve"
                    disabled={buttonsDisabled}
                    onPress={() => {
                      triggerHaptic('promptAnswered');
                      submit(approvePermissionKeystrokes());
                    }}
                  />
                </View>
                <View style={styles.flex}>
                  <Button
                    label="Deny"
                    variant="ghost"
                    testID="permission-deny"
                    disabled={buttonsDisabled}
                    onPress={() => {
                      triggerHaptic('promptAnswered');
                      submit(denyPermissionKeystrokes());
                    }}
                  />
                </View>
              </Row>
            )}
            {/* The agent-agnostic escape hatch: some dialogs carry options
                this card cannot see ("always allow", free text). One tap
                lands the user at the real prompt in the terminal lens. When
                the prompt is unidentified this is not a fallback - it is the
                only way to answer correctly, so it stops being muted. */}
            <PromptOptionRow
              label={kindUnknown ? 'Open in terminal' : 'More options in terminal'}
              description={kindUnknown ? 'See the prompt and answer it' : 'Opens the terminal at this prompt'}
              muted={!kindUnknown}
              testID="permission-answer-in-terminal"
              disabled={answering}
              onPress={() => useTerminalUiStore.getState().requestSessionMode(sessionId, 'terminal', { focusKeyboard: true })}
            />
        </Stack>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    alignItems: 'center',
  },
  actionRow: {
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
});
