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

/**
 * Every key visible at once, no scrolling. The selection rule is what the
 * FLOW needs, not which keys the keyboard happens to lack: this bar exists so
 * the common terminal interactions complete without ever raising the
 * keyboard, since terminal mode does not raise it until you tap the terminal.
 *
 * That is why Enter is here even though the soft keyboard has a Return key.
 * Both arrow flows are navigate-then-commit - move the selection in one of
 * the agent's numbered prompts and confirm, or recall a previous command and
 * run it - so arrows without Enter would leave the user at a choice they
 * cannot take, having to raise the keyboard anyway. The arrows and Enter earn
 * their slots together or not at all.
 *
 * Left/right are omitted: they move the cursor INSIDE an input line, which is
 * text editing you would do with the keyboard up regardless. Six keys also
 * keeps every target at roughly 53dp on a 360dp phone, comfortably over the
 * 44pt minimum, where eight shares would have left 40dp.
 *
 * Ctrl+C is deliberately a HARDCODED combo rather than the sticky Ctrl
 * modifier Blink and Termius use for the control space generally. It is the
 * interrupt for a running agent, so it has to be one tap - and a sticky
 * modifier would need the keyboard raised to press the letter, defeating the
 * point. TeamViewer makes the same exception for Ctrl+Alt+Del: one
 * combination important enough to hardcode. It is labelled literally rather
 * than "Stop", because "Stop" hid what it actually sends (the interrupt
 * character, SIGINT), and it is marked by a danger TINT rather than extra
 * width - colour makes it findable without stealing size from its neighbours.
 */
const QUICK_KEYS: QuickKey[] = [
  { id: 'esc', label: 'Esc', accessibilityLabel: 'Escape', sequence: ESCAPE },
  { id: 'tab', label: 'Tab', accessibilityLabel: 'Tab', sequence: TAB },
  { id: 'up', label: '↑', accessibilityLabel: 'Arrow up', arrow: 'up', glyph: true },
  { id: 'down', label: '↓', accessibilityLabel: 'Arrow down', arrow: 'down', glyph: true },
  { id: 'enter', label: 'Enter', accessibilityLabel: 'Enter', sequence: ENTER },
  {
    id: 'ctrl-c',
    label: 'Ctrl+C',
    accessibilityLabel: 'Interrupt the running agent (Ctrl+C)',
    sequence: CTRL_C,
    danger: true,
  },
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
              flex: 1,
              minHeight: theme.minTouchSize,
              borderRadius: theme.radii.sm,
              // The interrupt is tinted, not just red-lettered: it is the one
              // destructive key here and has to be findable without reading.
              backgroundColor: quickKey.danger ? theme.colors.dangerMuted : theme.colors.surfaceRaised,
              opacity: pressed ? 0.7 : 1,
            },
          ]}
        >
          {quickKey.danger ? (
            <Text variant="caption" color="danger" style={styles.dangerLabel} numberOfLines={1}>
              {quickKey.label}
            </Text>
          ) : (
            <MonoText
              color="primary"
              numberOfLines={1}
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
    alignItems: 'center',
    justifyContent: 'center',
  },
  dangerLabel: {
    fontWeight: '600',
  },
});
