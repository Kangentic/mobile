import React from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { OctagonX } from 'lucide-react-native';
import { MonoText, Row, Text, useTheme } from '@/components';
import { arrowKeySequence, CTRL_C, ENTER, ESCAPE, SLASH, TAB, type ArrowKeyDirection } from '@/terminal/keySequences';
import { useTerminalUiStore } from '@/state/terminalUiStore';
import { writeTerminal } from '@/connection/actions';

export interface QuickKeyBarProps {
  sessionId: string;
}

interface QuickKey {
  id: string;
  label: string;
  accessibilityLabel: string;
  /** Fixed byte sequence; arrows use `arrow` instead so DECCKM picks CSI vs SS3 at press time. */
  sequence?: string;
  arrow?: ArrowKeyDirection;
  /** Arrow glyphs read small at label size; render them larger. */
  glyph?: boolean;
}

const QUICK_KEYS: QuickKey[] = [
  { id: 'esc', label: 'Esc', accessibilityLabel: 'Escape', sequence: ESCAPE },
  { id: 'tab', label: 'Tab', accessibilityLabel: 'Tab', sequence: TAB },
  { id: 'up', label: '↑', accessibilityLabel: 'Arrow up', arrow: 'up', glyph: true },
  { id: 'down', label: '↓', accessibilityLabel: 'Arrow down', arrow: 'down', glyph: true },
  { id: 'left', label: '←', accessibilityLabel: 'Arrow left', arrow: 'left', glyph: true },
  { id: 'right', label: '→', accessibilityLabel: 'Arrow right', arrow: 'right', glyph: true },
  { id: 'enter', label: 'Enter', accessibilityLabel: 'Enter', sequence: ENTER },
  { id: 'slash', label: '/', accessibilityLabel: 'Slash', sequence: SLASH },
];

const KEY_LABEL_FONT_SIZE = 15;
const KEY_GLYPH_FONT_SIZE = 22;

/**
 * The terminal quick-key row: the control keys a phone keyboard cannot type,
 * each writing its raw byte sequence to the desktop PTY. Arrows respect the
 * session's DECCKM state (reported by the xterm pane) so full-screen
 * programs in application cursor mode get SS3 instead of CSI. Failures are
 * dropped silently (the connection banner is the surface for that state).
 */
export function QuickKeyBar({ sessionId }: QuickKeyBarProps): React.JSX.Element {
  const theme = useTheme();
  const applicationCursorMode = useTerminalUiStore(
    (state) => state.applicationCursorModeBySessionId[sessionId] ?? false,
  );
  return (
    <Row gap="xs" style={styles.bar}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always" style={styles.scroll}>
        <Row gap="xs">
          {QUICK_KEYS.map((quickKey) => (
          <Pressable
            key={quickKey.id}
            testID={`quick-key-${quickKey.id}`}
            accessibilityRole="button"
            accessibilityLabel={quickKey.accessibilityLabel}
            onPress={() => {
              const sequence = quickKey.arrow ? arrowKeySequence(quickKey.arrow, applicationCursorMode) : (quickKey.sequence ?? '');
              void writeTerminal(sessionId, sequence).catch(() => undefined);
            }}
            style={({ pressed }) => [
              styles.key,
              {
                minWidth: theme.minTouchSize,
                minHeight: theme.minTouchSize,
                borderRadius: theme.radii.sm,
                backgroundColor: theme.colors.surfaceRaised,
                paddingHorizontal: theme.spacing.sm,
                opacity: pressed ? 0.7 : 1,
              },
            ]}
          >
            <MonoText
              color="primary"
              style={{
                fontSize: quickKey.glyph ? KEY_GLYPH_FONT_SIZE : KEY_LABEL_FONT_SIZE,
                lineHeight: quickKey.glyph ? KEY_GLYPH_FONT_SIZE : KEY_LABEL_FONT_SIZE + 2,
                fontWeight: '600',
              }}
              >
                {quickKey.label}
              </MonoText>
            </Pressable>
          ))}
        </Row>
      </ScrollView>
      {/* Ctrl+C by name: an unlabeled red ^C says nothing to most users.
          'Stop' says exactly what it does - interrupt the running agent.
          Pinned outside the scroll so the safety control is always visible. */}
      <Pressable
        testID="quick-key-ctrl-c"
        accessibilityRole="button"
        accessibilityLabel="Stop the running agent (Ctrl+C)"
        onPress={() => {
          void writeTerminal(sessionId, CTRL_C).catch(() => undefined);
        }}
        style={({ pressed }) => [
          styles.key,
          styles.stopKey,
          {
            minHeight: theme.minTouchSize,
            borderRadius: theme.radii.sm,
            backgroundColor: theme.colors.surfaceRaised,
            borderColor: theme.colors.danger,
            paddingHorizontal: theme.spacing.md,
            gap: theme.spacing.xs,
            opacity: pressed ? 0.7 : 1,
          },
        ]}
      >
        <OctagonX size={16} color={theme.colors.danger} />
        <Text variant="caption" color="danger">
          Stop
        </Text>
      </Pressable>
    </Row>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
  },
  scroll: {
    flex: 1,
  },
  key: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  stopKey: {
    flexDirection: 'row',
    borderWidth: StyleSheet.hairlineWidth,
  },
});
