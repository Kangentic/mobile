import React from 'react';
import { ScrollView, View } from 'react-native';
import { isRecord, type JsonValue } from '@kangentic/protocol';
import { Badge, Button, Card, MarkdownBlock, MonoText, Row, Stack, Text, useTheme } from '@/components';
import { triggerHaptic } from '@/lib/haptics';
import { buildUnifiedDiffLines } from '@/diff/diffLines';
import type { PendingPromptDescriptor } from '@/conversation/transcriptCells';
import { approvePermissionKeystrokes, denyPermissionKeystrokes } from '@/conversation/promptKeystrokes';
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

/**
 * The pending permission prompt as a warning-bordered card. The body shows
 * exactly what approving grants; Approve/Deny answer over the interactive
 * terminal keystroke path and stay disabled once an answer is in flight.
 */
export function PermissionPromptCard({ sessionId, prompt }: PermissionPromptCardProps): React.JSX.Element {
  const theme = useTheme();
  const { answering, answeredNote, errorNote, submit } = usePromptAnswer(sessionId, prompt.promptId);
  const buttonsDisabled = answering || answeredNote !== null;

  return (
    <View style={{ paddingHorizontal: theme.spacing.md, paddingVertical: theme.spacing.sm }}>
      <Card testID="permission-prompt-card" style={{ borderColor: theme.colors.warning, borderWidth: 1 }}>
        <Stack gap="sm">
          <Row gap="sm">
            <Text variant="bodyStrong" color="warning">
              Permission requested
            </Text>
            {prompt.toolName !== null ? <Badge label={prompt.toolName} color="warning" /> : null}
          </Row>
          {prompt.toolName === null ? (
            <Text variant="body" color="secondary">
              Waiting for prompt details
            </Text>
          ) : (
            <PermissionPromptBody toolName={prompt.toolName} input={prompt.input} />
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
          <Row gap="sm">
            <Button
              label="Approve"
              variant="primary"
              testID="permission-approve"
              disabled={buttonsDisabled}
              onPress={() => {
                triggerHaptic('promptAnswered');
                submit(approvePermissionKeystrokes());
              }}
            />
            <Button
              label="Deny"
              variant="danger"
              testID="permission-deny"
              disabled={buttonsDisabled}
              onPress={() => {
                triggerHaptic('promptAnswered');
                submit(denyPermissionKeystrokes());
              }}
            />
          </Row>
        </Stack>
      </Card>
    </View>
  );
}
