import React from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';
import { MonoText, Row, useTheme } from '@/components';
import { arrowKeySequence, CTRL_C, ENTER, ESCAPE, SLASH, TAB } from '@/terminal/keySequences';
import { writeTerminal } from '@/connection/actions';

export interface QuickKeyBarProps {
  sessionId: string;
}

interface QuickKey {
  id: string;
  label: string;
  accessibilityLabel: string;
  sequence: string;
  danger?: boolean;
}

const QUICK_KEYS: QuickKey[] = [
  { id: 'esc', label: 'Esc', accessibilityLabel: 'Escape', sequence: ESCAPE },
  { id: 'tab', label: 'Tab', accessibilityLabel: 'Tab', sequence: TAB },
  { id: 'up', label: '↑', accessibilityLabel: 'Arrow up', sequence: arrowKeySequence('up') },
  { id: 'down', label: '↓', accessibilityLabel: 'Arrow down', sequence: arrowKeySequence('down') },
  { id: 'left', label: '←', accessibilityLabel: 'Arrow left', sequence: arrowKeySequence('left') },
  { id: 'right', label: '→', accessibilityLabel: 'Arrow right', sequence: arrowKeySequence('right') },
  { id: 'enter', label: 'Enter', accessibilityLabel: 'Enter', sequence: ENTER },
  { id: 'ctrl-c', label: '^C', accessibilityLabel: 'Control C', sequence: CTRL_C, danger: true },
  { id: 'slash', label: '/', accessibilityLabel: 'Slash', sequence: SLASH },
];

/**
 * The terminal quick-key row: the control keys a phone keyboard cannot type,
 * each writing its raw byte sequence to the desktop PTY. Failures are dropped
 * silently (the connection banner is the surface for that state).
 */
export function QuickKeyBar({ sessionId }: QuickKeyBarProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="always">
      <Row gap="xs">
        {QUICK_KEYS.map((quickKey) => (
          <Pressable
            key={quickKey.id}
            testID={`quick-key-${quickKey.id}`}
            accessibilityRole="button"
            accessibilityLabel={quickKey.accessibilityLabel}
            onPress={() => {
              void writeTerminal(sessionId, quickKey.sequence).catch(() => undefined);
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
            <MonoText size="caption" color={quickKey.danger ? 'danger' : 'primary'}>
              {quickKey.label}
            </MonoText>
          </Pressable>
        ))}
      </Row>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  key: {
    alignItems: 'center',
    justifyContent: 'center',
  },
});
