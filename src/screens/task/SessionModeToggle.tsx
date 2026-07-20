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
/** Same fixed stadium geometry as the app tab bar's active indicator. */
const SEGMENT_PILL_HEIGHT = 30;

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
    <Row style={styles.bar}>
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
            style={styles.segment}
          >
            <View
              style={[
                styles.iconPill,
                {
                  borderRadius: SEGMENT_PILL_HEIGHT / 2,
                  paddingHorizontal: theme.spacing.lg,
                  backgroundColor: isActive ? theme.colors.accentSubtle : 'transparent',
                },
              ]}
            >
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
  bar: {
    flex: 1,
  },
  segment: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  iconPill: {
    alignItems: 'center',
    height: SEGMENT_PILL_HEIGHT,
    justifyContent: 'center',
  },
  attentionDot: {
    position: 'absolute',
    right: 6,
    top: 0,
  },
  label: {
    fontWeight: '600',
    marginTop: 1,
  },
});
