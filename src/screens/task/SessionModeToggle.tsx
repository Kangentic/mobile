import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { GitCompareArrows, MessagesSquare, SquareTerminal } from 'lucide-react-native';
import { Row, StatusDot, Text, useTheme } from '@/components';
import { triggerHaptic } from '@/lib/haptics';

export type SessionMode = 'terminal' | 'chat' | 'changes';

export interface SessionModeToggleProps {
  mode: SessionMode;
  onModeChange: (mode: SessionMode) => void;
  /**
   * True when something on the chat side needs the user (a pending
   * permission/question) while another surface is showing: the Chat
   * segment grows a needs-you dot. Never auto-switches.
   */
  chatAttention: boolean;
}

const SEGMENT_ICON_SIZE = 20;

interface SegmentVisual {
  mode: SessionMode;
  label: string;
  accessibilityLabel: string;
  Icon: typeof SquareTerminal;
}

const SEGMENTS: SegmentVisual[] = [
  { mode: 'terminal', label: 'Terminal', accessibilityLabel: 'Terminal view', Icon: SquareTerminal },
  { mode: 'chat', label: 'Chat', accessibilityLabel: 'Chat view', Icon: MessagesSquare },
  { mode: 'changes', label: 'Changes', accessibilityLabel: 'Changes view', Icon: GitCompareArrows },
];

/**
 * The session's surface switcher: one session, three surfaces - Terminal,
 * Chat, Changes. Full-width flexed segments (large thumb targets) in the
 * app tab bar's visual language: icon in an amber stadium pill + accent
 * label when active. Tap-only: swipe belongs to the terminal's pan
 * gesture. The row keeps identical geometry in every mode.
 */
export function SessionModeToggle({ mode, onModeChange, chatAttention }: SessionModeToggleProps): React.JSX.Element {
  const theme = useTheme();

  function selectMode(nextMode: SessionMode): void {
    if (nextMode === mode) return;
    triggerHaptic('modeToggled');
    onModeChange(nextMode);
  }

  return (
    <Row
      style={[
        styles.bar,
        {
          borderColor: theme.colors.border,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.xs / 2,
        },
      ]}
    >
      {SEGMENTS.map((segment) => {
        const isActive = mode === segment.mode;
        return (
          <Pressable
            key={segment.mode}
            accessibilityRole="button"
            accessibilityState={{ selected: isActive }}
            accessibilityLabel={segment.accessibilityLabel}
            testID={`session-mode-${segment.mode}`}
            onPress={() => selectMode(segment.mode)}
            style={[
              styles.segment,
              {
                // The WHOLE segment tints when active, not just the icon:
                // one glance says which surface is on.
                backgroundColor: isActive ? theme.colors.accentSubtle : 'transparent',
                borderRadius: theme.radii.lg - theme.spacing.xs / 2,
                paddingVertical: theme.spacing.xs,
              },
            ]}
          >
            <View style={styles.iconHolder}>
              <segment.Icon
                size={SEGMENT_ICON_SIZE}
                color={isActive ? theme.colors.accent : theme.colors.textMuted}
                strokeWidth={isActive ? 2.4 : 1.8}
              />
              {segment.mode === 'chat' && chatAttention ? (
                <View style={styles.attentionDot}>
                  <StatusDot variant="needs-you" testID="session-mode-chat-attention" />
                </View>
              ) : null}
            </View>
            <Text variant="caption" color={isActive ? 'accent' : 'muted'} style={styles.label}>
              {segment.label}
            </Text>
          </Pressable>
        );
      })}
    </Row>
  );
}

const styles = StyleSheet.create({
  // The outline binds the three segments into one visible toggle group.
  // No flex here: as a column child it stretches to full width on its own,
  // and flexBasis 0 would crush the row's height.
  bar: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  segment: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  iconHolder: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  attentionDot: {
    position: 'absolute',
    right: -10,
    top: -2,
  },
  label: {
    fontWeight: '600',
    marginTop: 1,
  },
});
