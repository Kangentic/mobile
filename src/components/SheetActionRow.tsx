import React from 'react';
import { Pressable, StyleSheet } from 'react-native';
import { Row } from './Row';
import { Stack } from './Stack';
import { Text, type TextColorRole } from './Text';
import { sheetRowSurface } from './sheetRowSurface';
import { useTheme } from './theme/ThemeProvider';

export interface SheetActionRowProps {
  label: string;
  /** The row's leading glyph: an `Icon`, or a brand mark (the stop control on a terminal's Stop). */
  glyph: React.ReactNode;
  onPress: () => void;
  disabled: boolean;
  testID: string;
  /** `danger` for a destructive action (Delete, Stop terminal). */
  color?: TextColorRole;
  caption?: string | null;
  /** A glyph at the row's end, for a row that leaves the app (a link's open-in-browser mark). */
  trailing?: React.ReactNode;
  /** One line for the label, truncating: peer-supplied names (a link's) can run long. */
  singleLineLabel?: boolean;
  /** The role a screen reader announces: `link` for a row that opens a web page rather than acting on the task. */
  accessibilityRole?: 'button' | 'link';
}

/**
 * One action in a long-press sheet: a raised row (sheetRowSurface) with a
 * leading glyph, the action's label and an optional one-line caption under it.
 * Shared by the task actions hub and a Command Terminal's long-press sheet
 * (design change 19), so the two read as one family.
 */
export function SheetActionRow({
  label,
  glyph,
  onPress,
  disabled,
  testID,
  color = 'primary',
  caption = null,
  trailing = null,
  singleLineLabel = false,
  accessibilityRole = 'button',
}: SheetActionRowProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole={accessibilityRole}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      testID={testID}
      style={[
        styles.actionRow,
        sheetRowSurface(theme),
        {
          minHeight: theme.minTouchSize,
          paddingHorizontal: theme.spacing.md,
          opacity: disabled ? 0.4 : 1,
        },
      ]}
    >
      <Row gap="sm" style={styles.actionRowContent}>
        {glyph}
        <Stack gap="xs" style={styles.flex}>
          <Text variant="body" color={color} numberOfLines={singleLineLabel ? 1 : undefined}>
            {label}
          </Text>
          {caption ? (
            <Text variant="caption" color="muted" numberOfLines={singleLineLabel ? 1 : undefined}>
              {caption}
            </Text>
          ) : null}
        </Stack>
        {trailing}
      </Row>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  actionRow: {
    justifyContent: 'center',
    paddingVertical: 8,
  },
  actionRowContent: {
    alignItems: 'center',
  },
  flex: {
    flex: 1,
  },
});
