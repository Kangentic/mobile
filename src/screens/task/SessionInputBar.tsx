import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Stack, useTheme } from '@/components';
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
 * The session's ONE mode-aware footer: the mode pill sits directly above the
 * input row it re-programs. Terminal mode = quick keys + the PTY line
 * composer (interactive-terminal); Chat mode = the agent message composer
 * (send-user-message). Same spot, behavior follows the mode.
 */
export function SessionInputBar({ sessionId, mode, onModeChange, chatAttention }: SessionInputBarProps): React.JSX.Element | null {
  const theme = useTheme();
  if (sessionId === null) return null;
  return (
    <Stack
      gap="xs"
      style={{
        backgroundColor: theme.colors.surface,
        paddingHorizontal: theme.spacing.sm,
        paddingTop: theme.spacing.xs,
      }}
    >
      <View style={styles.toggleRow} testID="session-input-bar">
        <SessionModeToggle mode={mode} onModeChange={onModeChange} chatAttention={chatAttention} />
      </View>
      {mode === 'terminal' ? (
        <Stack gap="xs">
          <QuickKeyBar sessionId={sessionId} />
          <TerminalInputRow sessionId={sessionId} />
        </Stack>
      ) : (
        <ComposerBar sessionId={sessionId} />
      )}
    </Stack>
  );
}

const styles = StyleSheet.create({
  toggleRow: {
    flexDirection: 'row',
  },
});
