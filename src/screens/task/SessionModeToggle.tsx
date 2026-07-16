import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Icon, MonoText, Row, StatusDot, Text, useTheme } from '@/components';
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

/**
 * The session's mode pill: one session, two lenses. Docked in the input bar
 * (adjacent to the input row it re-programs, thumb-reachable with the
 * keyboard open); active segment fill + the input row transforming + the
 * pane slide are the three reinforcing mode signals. Tap-only: swipe
 * belongs to the terminal's pan gesture.
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
        minHeight: theme.minTouchSize,
        borderRadius: theme.radii.md,
        paddingHorizontal: theme.spacing.md,
        backgroundColor: isActive ? theme.colors.surfaceRaised : 'transparent',
      },
    ];
  }

  return (
    <Row
      gap="xs"
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
        <Row gap="xs" style={styles.segmentContent}>
          <MonoText size="caption" color={mode === 'terminal' ? 'accent' : 'secondary'}>
            {'>_'}
          </MonoText>
          <Text variant="caption" color={mode === 'terminal' ? 'accent' : 'secondary'}>
            Terminal
          </Text>
        </Row>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ selected: mode === 'chat' }}
        accessibilityLabel="Chat view"
        testID="session-mode-chat"
        onPress={() => selectMode('chat')}
        style={segmentStyle('chat')}
      >
        <Row gap="xs" style={styles.segmentContent}>
          <Icon name="chatbubble-outline" size={14} color={mode === 'chat' ? 'accent' : 'secondary'} />
          <Text variant="caption" color={mode === 'chat' ? 'accent' : 'secondary'}>
            Chat
          </Text>
          {chatAttention ? <StatusDot variant="needs-you" testID="session-mode-chat-attention" /> : null}
        </Row>
      </Pressable>
    </Row>
  );
}

const styles = StyleSheet.create({
  pill: {
    alignSelf: 'flex-start',
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
  },
  segment: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  segmentContent: {
    alignItems: 'center',
  },
});
