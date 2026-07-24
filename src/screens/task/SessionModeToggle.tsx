import React from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ArrowLeftRight, GitCompareArrows, MessagesSquare, SquareTerminal } from 'lucide-react-native';
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
  /** Opens the move-to-column sheet. Move is an action, not a persistent surface - it never becomes the active segment. */
  onMove: () => void;
}

const SEGMENT_ICON_SIZE = 18;

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

interface SegmentProps {
  Icon: typeof SquareTerminal;
  label: string;
  accessibilityLabel: string;
  testID: string;
  isActive: boolean;
  showAttentionDot: boolean;
  onPress: () => void;
}

/** One shared render path for every segment (the three surfaces and Move), so the group's look can never drift between them. */
function Segment({ Icon, label, accessibilityLabel, testID, isActive, showAttentionDot, onPress }: SegmentProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: isActive }}
      accessibilityLabel={accessibilityLabel}
      testID={testID}
      onPress={onPress}
      style={[
        styles.segment,
        {
          // The WHOLE segment tints when active, not just the icon:
          // one glance says which surface is on.
          backgroundColor: isActive ? theme.colors.accentSubtle : 'transparent',
          borderRadius: theme.radii.lg - theme.spacing.xs / 2,
          paddingVertical: theme.spacing.xs,
          // Hold the shared segment at the 44pt touch floor; the token math
          // otherwise lands a hair under it for all four segments.
          minHeight: theme.minTouchSize,
        },
      ]}
    >
      <View style={styles.iconHolder}>
        <Icon
          size={SEGMENT_ICON_SIZE}
          color={isActive ? theme.colors.accent : theme.colors.textMuted}
          strokeWidth={isActive ? 2.4 : 1.8}
        />
        {showAttentionDot ? (
          <View style={styles.attentionDot}>
            <StatusDot variant="needs-you" testID="session-mode-chat-attention" />
          </View>
        ) : null}
      </View>
      <Text variant="caption" color={isActive ? 'accent' : 'muted'} style={styles.label}>
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * The session's surface switcher: one session, three surfaces - Terminal,
 * Chat, Changes - plus Move, an action (not a surface) that opens the
 * move-to-column sheet instead of paging. Full-width flexed segments
 * (large thumb targets) in the app tab bar's visual language: icon in an
 * amber stadium pill + accent label when active. Tap-only: swipe belongs
 * to the terminal's pan gesture. The row keeps identical geometry in
 * every mode.
 */
export function SessionModeToggle({ mode, onModeChange, chatAttention, onMove }: SessionModeToggleProps): React.JSX.Element {
  const theme = useTheme();

  function selectMode(nextMode: SessionMode): void {
    if (nextMode === mode) return;
    triggerHaptic('modeToggled');
    onModeChange(nextMode);
  }

  function selectMove(): void {
    triggerHaptic('modeToggled');
    onMove();
  }

  return (
    <Row
      style={[
        styles.bar,
        {
          backgroundColor: theme.colors.surfaceRaised,
          borderRadius: theme.radii.lg,
          padding: theme.spacing.xs / 2,
        },
      ]}
    >
      {SEGMENTS.map((segment) => (
        <Segment
          key={segment.mode}
          Icon={segment.Icon}
          label={segment.label}
          accessibilityLabel={segment.accessibilityLabel}
          testID={`session-mode-${segment.mode}`}
          isActive={mode === segment.mode}
          showAttentionDot={segment.mode === 'chat' && chatAttention}
          onPress={() => selectMode(segment.mode)}
        />
      ))}
      <Segment
        Icon={ArrowLeftRight}
        label="Move"
        accessibilityLabel="Move task to another column"
        testID="session-mode-move"
        isActive={false}
        showAttentionDot={false}
        onPress={selectMove}
      />
    </Row>
  );
}

const styles = StyleSheet.create({
  // The tinted fill binds the segments into one visible toggle group
  // without a hard outline - a full hairline box on top of the footer's
  // own top border read as two stacked borders ("sticky"/heavy).
  // No flex here: as a column child it stretches to full width on its own,
  // and flexBasis 0 would crush the row's height.
  bar: {},
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
