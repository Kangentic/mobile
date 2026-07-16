import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { MessagesSquare, SquareTerminal } from 'lucide-react-native';
import { Row, StatusDot, useTheme } from '@/components';
import { triggerHaptic } from '@/lib/haptics';

export type SessionMode = 'terminal' | 'chat';

export interface SessionModeToggleProps {
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  /**
   * True when something on the chat side needs the user (a pending
   * permission/question) while the terminal side is showing: the Chat
   * segment grows a needs-you dot. Never auto-switches.
   */
  chatAttention: boolean;
}

const SEGMENT_ICON_SIZE = 18;

/**
 * The session's mode pill: one session, two lenses. Compact icon-only
 * segments docked at the left edge of the input row (thumb-reachable with
 * the keyboard open, adjacent to the input it re-programs) so the bottom
 * row keeps identical geometry in both modes. Active segment fill + the
 * input row transforming + the pane slide are the three reinforcing mode
 * signals. Tap-only: swipe belongs to the terminal's pan gesture.
 */
export function SessionModeToggle({ mode, onModeChange, chatAttention }: SessionModeToggleProps): React.JSX.Element {
  const theme = useTheme();

  function selectMode(nextMode: SessionMode): void {
    if (nextMode === mode) return;
    triggerHaptic('modeToggled');
    onModeChange(nextMode);
  }

  function segmentStyle(segment: SessionMode): object[] {
    const isActive = mode === segment;
    return [
      styles.segment,
      {
        width: theme.minTouchSize,
        height: theme.minTouchSize,
        borderRadius: theme.radii.md,
        backgroundColor: isActive ? theme.colors.surfaceRaised : 'transparent',
      },
    ];
  }

  return (
    <Row
      style={[
        styles.pill,
        {
          borderColor: theme.colors.border,
          borderRadius: theme.radii.md,
          backgroundColor: theme.colors.surface,
        },
      ]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: mode === 'terminal' }}
        accessibilityLabel="Terminal view"
        testID="session-mode-terminal"
        onPress={() => selectMode('terminal')}
        style={segmentStyle('terminal')}
      >
        <SquareTerminal
          size={SEGMENT_ICON_SIZE}
          color={mode === 'terminal' ? theme.colors.accent : theme.colors.textSecondary}
        />
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: mode === 'chat' }}
        accessibilityLabel="Chat view"
        testID="session-mode-chat"
        onPress={() => selectMode('chat')}
        style={segmentStyle('chat')}
      >
        <MessagesSquare
          size={SEGMENT_ICON_SIZE}
          color={mode === 'chat' ? theme.colors.accent : theme.colors.textSecondary}
        />
        {chatAttention ? (
          <View style={styles.attentionDot}>
            <StatusDot variant="needs-you" testID="session-mode-chat-attention" />
          </View>
        ) : null}
      </Pressable>
    </Row>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'visible',
  },
  segment: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  attentionDot: {
    position: 'absolute',
    top: 6,
    right: 6,
  },
});
