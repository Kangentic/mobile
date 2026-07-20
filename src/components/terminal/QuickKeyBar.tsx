import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { MonoText, Row, Text, useTheme } from '@/components';
import { arrowKeySequence, CTRL_C, ENTER, ESCAPE, TAB, type ArrowKeyDirection } from '@/terminal/keySequences';
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
  /** Danger treatment (the interrupt). */
  danger?: boolean;
}

// Every key visible at once, no scrolling: only keys the soft keyboard
// CANNOT type. The interrupt is labeled literally - Ctrl+C - because
// "Stop" hid what it actually sends (the interrupt character, SIGINT).
const QUICK_KEYS: QuickKey[] = [
  { id: 'esc', label: 'Esc', accessibilityLabel: 'Escape', sequence: ESCAPE },
  { id: 'tab', label: 'Tab', accessibilityLabel: 'Tab', sequence: TAB },
  { id: 'up', label: '↑', accessibilityLabel: 'Arrow up', arrow: 'up', glyph: true },
  { id: 'down', label: '↓', accessibilityLabel: 'Arrow down', arrow: 'down', glyph: true },
  { id: 'left', label: '←', accessibilityLabel: 'Arrow left', arrow: 'left', glyph: true },
  { id: 'right', label: '→', accessibilityLabel: 'Arrow right', arrow: 'right', glyph: true },
  { id: 'enter', label: 'Enter', accessibilityLabel: 'Enter', sequence: ENTER },
  { id: 'ctrl-c', label: 'Ctrl+C', accessibilityLabel: 'Interrupt the running agent (Ctrl+C)', sequence: CTRL_C, danger: true },
];

const KEY_LABEL_FONT_SIZE = 13;
const KEY_GLYPH_FONT_SIZE = 20;

/**
 * The terminal quick-key row: the control keys a phone keyboard cannot
 * type, each writing its raw byte sequence to the desktop PTY. All keys
 * share one flex-distributed row so everything usable is always visible.
 * Arrows respect the session's DECCKM state (reported by the xterm pane)
 * so full-screen programs in application cursor mode get SS3 instead of
 * CSI. Failures are dropped silently (the connection banner is the
 * surface for that state).
 */
export function QuickKeyBar({ sessionId }: QuickKeyBarProps): React.JSX.Element {
  const theme = useTheme();
  const applicationCursorMode = useTerminalUiStore(
    (state) => state.applicationCursorModeBySessionId[sessionId] ?? false,
  );
  return (
    <Row gap="xs" style={styles.bar}>
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
              minHeight: theme.minTouchSize,
              borderRadius: theme.radii.sm,
              backgroundColor: theme.colors.surfaceRaised,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          {quickKey.danger ? (
            <Text variant="caption" color="danger" style={styles.dangerLabel} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
              {quickKey.label}
            </Text>
          ) : (
            <MonoText
              color="primary"
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              style={{
                fontSize: quickKey.glyph ? KEY_GLYPH_FONT_SIZE : KEY_LABEL_FONT_SIZE,
                lineHeight: quickKey.glyph ? KEY_GLYPH_FONT_SIZE : KEY_LABEL_FONT_SIZE + 2,
                fontWeight: '600',
              }}
            >
              {quickKey.label}
            </MonoText>
          )}
        </Pressable>
      ))}
    </Row>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignItems: 'center',
  },
  key: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerLabel: {
    fontWeight: '600',
  },
});
