import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Row, Stack, useTheme } from '@/components';
import { ComposerBar } from '@/components/composer/ComposerBar';
import { QuickKeyBar } from '@/components/terminal/QuickKeyBar';
import { TerminalInputRow } from '@/components/terminal/TerminalInputRow';
import { SessionModeToggle, type SessionMode } from './SessionModeToggle';

export interface SessionInputBarProps {
  sessionId: string | null;
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  chatAttention: boolean;
}

/**
 * The session's ONE mode-aware footer. The bottom row is identical in both
 * modes - compact mode pill at the left, the input beside it - so toggling
 * the lens never shifts what the thumb is resting on. Terminal mode adds
 * the quick-key strip ABOVE that row (additive: the bottom row itself
 * never moves); chat mode simply has no strip and gives the height back
 * to the conversation.
 */
export function SessionInputBar({ sessionId, mode, onModeChange, chatAttention }: SessionInputBarProps): React.JSX.Element | null {
  const theme = useTheme();
  if (sessionId === null) return null;
  return (
    <Stack
      gap="xs"
      testID="session-input-bar"
      style={{
        backgroundColor: theme.colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border,
        paddingHorizontal: theme.spacing.sm,
        paddingTop: theme.spacing.xs,
        paddingBottom: theme.spacing.xs,
      }}
    >
      {mode === 'terminal' ? <QuickKeyBar sessionId={sessionId} /> : null}
      <Row gap="sm" style={styles.inputRow}>
        <SessionModeToggle mode={mode} onModeChange={onModeChange} chatAttention={chatAttention} />
        <View style={styles.flex}>
          {mode === 'terminal' ? <TerminalInputRow sessionId={sessionId} /> : <ComposerBar sessionId={sessionId} />}
        </View>
      </Row>
    </Stack>
  );
}

const styles = StyleSheet.create({
  inputRow: {
    alignItems: 'flex-end',
  },
  flex: {
    flex: 1,
  },
});
