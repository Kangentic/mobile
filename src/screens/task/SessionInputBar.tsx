import React from 'react';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Stack, Text, useTheme } from '@/components';
import { ComposerBar } from '@/components/composer/ComposerBar';
import { QuickKeyBar } from '@/components/terminal/QuickKeyBar';
import { SessionModeToggle, type SessionMode } from './SessionModeToggle';

export interface SessionInputBarProps {
  sessionId: string | null;
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  chatAttention: boolean;
  /**
   * True while the footer is held on a session that has ended and its
   * successor has not bound (SessionScreen's quiet swap window). The mode row
   * stays exactly as it looked - no dimming, nothing new to read - but takes
   * no touches and leaves the accessibility tree: a key to a dead PTY is
   * silently swallowed and the composer would show an error. The mode pill
   * stays live in every case; it is the way out to Changes.
   */
  suspended?: boolean;
  /**
   * True in the swap window's waiting phase (past the quiet deadline with no
   * successor bound): the footer is the switcher alone, in every mode. Keys
   * and messages have nowhere to go, and the switcher is what keeps the
   * transcript and the diff one tap away from the wait, and the way back
   * from them.
   */
  switcherOnly?: boolean;
  /**
   * True while the terminal lens shows the Resume panel (a paused session):
   * the quick keys go, since there is no live session to type into. Chat's
   * composer and the switcher are unaffected.
   */
  quickKeysHidden?: boolean;
  /**
   * A one-line notice above everything else in the footer: a failed Resume's
   * line ("Session could not be resumed."), which the terminal lens shows in
   * its Resume panel and every other lens would otherwise not show at all.
   * Muted caption, as the desktop draws that line (TaskDetailBody.tsx's
   * `text-xs text-fg-muted`), and as the Resume panel does. Null draws nothing.
   */
  notice?: string | null;
}

/**
 * The session's ONE mode-aware footer, anchored by the surface switcher as
 * the LAST row in every mode - toggling never moves it. Above it sits one
 * mode row of matching height: the quick keys in terminal, the composer
 * (which owns chat's send and dictation) in chat, nothing in changes - so a
 * terminal-chat switch swaps equal-height rows and the whole panel keeps its
 * geometry. Typing in terminal happens directly in the terminal (tap it to
 * raise the keyboard).
 *
 * With no session (a paused task the desktop cleared `session_id` from, or a
 * first start before its agent exists) the footer is the switcher alone, as
 * in the swap window's waiting phase: there is nothing to type into, but the
 * task's diff and its Resume panel are a lens away, and a screen that opened
 * on a remembered Chat lens (which reads "No active session" there) has no
 * other way back to them.
 */
export function SessionInputBar({
  sessionId,
  mode,
  onModeChange,
  chatAttention,
  suspended = false,
  switcherOnly = false,
  quickKeysHidden = false,
  notice = null,
}: SessionInputBarProps): React.JSX.Element {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const modeRowShown = mode !== 'changes' && !switcherOnly && !(mode === 'terminal' && quickKeysHidden);
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
      {notice !== null ? (
        <Text variant="caption" color="muted" style={{ paddingHorizontal: theme.spacing.xs }} testID="session-footer-notice">
          {notice}
        </Text>
      ) : null}
      {/* Rendered only when a mode row exists: an empty wrapper would add a
          `gap` slot above the pill in changes mode, and past the end of the
          session the pill is the whole footer. */}
      {sessionId !== null && modeRowShown ? (
        <View
          testID="session-input-row"
          pointerEvents={suspended ? 'none' : 'auto'}
          accessibilityElementsHidden={suspended}
          importantForAccessibility={suspended ? 'no-hide-descendants' : 'auto'}
        >
          {mode === 'terminal' ? <QuickKeyBar sessionId={sessionId} /> : null}
          {mode === 'chat' ? <ComposerBar sessionId={sessionId} /> : null}
        </View>
      ) : null}
      <SessionModeToggle mode={mode} onModeChange={onModeChange} chatAttention={chatAttention} />
    </Stack>
  );
}
