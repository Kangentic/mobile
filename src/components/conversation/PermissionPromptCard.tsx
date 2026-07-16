import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { isRecord, type JsonValue } from '@kangentic/protocol';
import { Badge, Button, Card, Icon, MarkdownBlock, MonoText, Row, Stack, Text, useTheme } from '@/components';
import { triggerHaptic } from '@/lib/haptics';
import { buildUnifiedDiffLines } from '@/diff/diffLines';
import type { PendingPromptDescriptor } from '@/conversation/transcriptCells';
import { approvePermissionKeystrokes, denyPermissionKeystrokes } from '@/conversation/promptKeystrokes';
import { useTerminalUiStore } from '@/state/terminalUiStore';
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
 * moment rather than a form: an amber-railed card with a framing line
 * ("The agent wants to run this command"), the exact grant as the body,
 * a full-width Approve, and a deliberately quieter Deny (denying is the
 * escape hatch, not a co-equal call to action). Answers ride the
 * interactive-terminal keystroke path and disable once in flight.
 */
export function PermissionPromptCard({ sessionId, prompt }: PermissionPromptCardProps): React.JSX.Element {
  const theme = useTheme();
  const { answering, answeredNote, errorNote, submit } = usePromptAnswer(sessionId, prompt.promptId);
  const buttonsDisabled = answering || answeredNote !== null;

  return (
    <View style={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }}>
      <Card testID="permission-prompt-card" style={{ borderColor: theme.colors.accentMuted, borderWidth: 1 }}>
        <Row gap="sm" style={styles.promptBody}>
          <View style={[styles.attentionRail, { backgroundColor: theme.colors.accent, borderRadius: theme.radii.sm }]} />
          <Stack gap="sm" style={styles.flex}>
            <Row gap="sm" style={styles.headerRow}>
              <Icon name="shield-half" color="accent" size={18} />
              <Text variant="bodyStrong" color="accent" style={styles.flex}>
                Permission requested
              </Text>
              {prompt.toolName !== null ? <Badge label={prompt.toolName} color="secondary" /> : null}
            </Row>
            {prompt.toolName === null ? (
              <Text variant="body" color="secondary">
                Waiting for prompt details
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
            </Row>
            {/* The agent-agnostic escape hatch: some dialogs carry options
                this card cannot see ("always allow", free text). One tap
                lands the user at the real prompt in the terminal lens. */}
            <Button
              label="More options in terminal"
              variant="ghost"
              testID="permission-answer-in-terminal"
              disabled={answering}
              onPress={() => useTerminalUiStore.getState().requestSessionMode(sessionId, 'terminal')}
            />
          </Stack>
        </Row>
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  promptBody: {
    alignItems: 'stretch',
  },
  attentionRail: {
    width: 4,
    alignSelf: 'stretch',
  },
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
