import React from 'react';
import { StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, useTheme } from '@/components';
import { ComposerBar } from '@/components/composer/ComposerBar';
import { QuickKeyBar } from '@/components/terminal/QuickKeyBar';
import { SessionModeToggle, type SessionMode } from './SessionModeToggle';

export interface SessionInputBarProps {
  sessionId: string | null;
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  chatAttention: boolean;
}

/**
 * The session's ONE mode-aware footer, anchored by the surface switcher as
 * the LAST row in every mode - toggling never moves it. Above it sits one
 * mode row of matching height: the quick keys in terminal, the composer
 * (which owns chat's send and dictation) in chat, nothing in changes - so a
 * terminal-chat switch swaps equal-height rows and the whole panel keeps its
 * geometry. Typing in terminal happens directly in the terminal (tap it to
 * raise the keyboard).
 */
export function SessionInputBar({ sessionId, mode, onModeChange, chatAttention }: SessionInputBarProps): React.JSX.Element | null {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  if (sessionId === null) return null;
  return (
    <Stack
      gap="sm"
      testID="session-input-bar"
      style={{
        backgroundColor: theme.colors.surface,
        borderTopWidth: StyleSheet.hairlineWidth,
        borderTopColor: theme.colors.border,
        paddingHorizontal: theme.spacing.sm,
        paddingTop: theme.spacing.xs,
        // The session screen has no tab bar beneath: the footer owns the
        // gesture-nav inset so the segment labels never sit under the
        // pill - but only the clearance actually needed, or the full inset
        // reads as a dead band under the labels.
        paddingBottom: Math.max(theme.spacing.xs, insets.bottom - theme.spacing.sm),
      }}
    >
      {mode === 'terminal' ? <QuickKeyBar sessionId={sessionId} /> : null}
      {mode === 'chat' ? <ComposerBar sessionId={sessionId} /> : null}
      <SessionModeToggle mode={mode} onModeChange={onModeChange} chatAttention={chatAttention} />
    </Stack>
  );
}
