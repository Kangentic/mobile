import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Row, Stack, useTheme } from '@/components';
import { ComposerBar } from '@/components/composer/ComposerBar';
import { QuickKeyBar } from '@/components/terminal/QuickKeyBar';
import { TerminalMicButton } from '@/components/terminal/TerminalMicButton';
import { SessionModeToggle, type SessionMode } from './SessionModeToggle';

export interface SessionInputBarProps {
  sessionId: string | null;
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  chatAttention: boolean;
}

/** The reserved right-slot width: the switcher keeps identical geometry whether or not a mic is showing. */
const RIGHT_SLOT_WIDTH = 52;

/**
 * The session's ONE mode-aware footer. The switcher row is UNIFORM across
 * every mode - full-width flexed segments on the left, a hairline
 * separator, and a reserved right slot that holds the PTY dictation mic
 * in terminal mode (chat's mic lives in the composer row with the input
 * and send; changes needs no input at all). Terminal adds the quick-key
 * strip above; chat adds the composer row below. Typing in terminal
 * happens directly in the terminal - tap it to raise the keyboard.
 */
export function SessionInputBar({ sessionId, mode, onModeChange, chatAttention }: SessionInputBarProps): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
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
        // The session screen has no tab bar beneath: the footer owns the
        // gesture-nav inset so the segment labels never sit under the pill.
        paddingBottom: insets.bottom + theme.spacing.xs,
      }}
    >
      {mode === 'terminal' ? <QuickKeyBar sessionId={sessionId} /> : null}
      <Row gap="sm" style={styles.switcherRow}>
        <SessionModeToggle mode={mode} onModeChange={onModeChange} chatAttention={chatAttention} />
        <View style={[styles.separator, { backgroundColor: theme.colors.border }]} />
        <View style={styles.rightSlot}>{mode === 'terminal' ? <TerminalMicButton sessionId={sessionId} /> : null}</View>
      </Row>
      {mode === 'chat' ? <ComposerBar sessionId={sessionId} /> : null}
    </Stack>
  );
}

const styles = StyleSheet.create({
  switcherRow: {
    alignItems: 'center',
  },
  separator: {
    alignSelf: 'stretch',
    marginVertical: 6,
    width: StyleSheet.hairlineWidth,
  },
  rightSlot: {
    alignItems: 'center',
    justifyContent: 'center',
    width: RIGHT_SLOT_WIDTH,
  },
});
