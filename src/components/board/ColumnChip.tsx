import React from 'react';
import { Pressable, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import type { BoardColumnWire } from '@kangentic/protocol';
import { Badge, Row, Text, useTheme } from '@/components';
import { getColumnIcon } from './columnIcons';

export interface ColumnChipProps {
  label: string;
  /**
   * The board column the chip stands for, which supplies its icon and colour.
   * Null for a destination that is not a column (the New task sheet's
   * Backlog), which draws the name alone.
   */
  column: BoardColumnWire | null;
  active: boolean;
  onPress: () => void;
  testID: string;
  /** `tab` on the Board's navigator, `radio` in a picker. */
  accessibilityRole: 'tab' | 'radio';
  accessibilityLabel?: string;
  /** A trailing task count; no badge when omitted or zero. */
  count?: number;
  onLayout?: (event: LayoutChangeEvent) => void;
}

const CHIP_DOT_SIZE = 8;
const CHIP_ICON_SIZE = 14;

/**
 * One column chip, as the Board's column navigator draws it: the desktop's
 * column icon in the column's colour, the name, and an optional count. The
 * active chip takes the raised fill, the muted accent outline and accent ink.
 * Shared so every place that names a column (the Board's chip bar, the New
 * task sheet's destination picker) draws it the same way.
 */
export function ColumnChip({
  label,
  column,
  active,
  onPress,
  testID,
  accessibilityRole,
  accessibilityLabel,
  count,
  onLayout,
}: ColumnChipProps): React.JSX.Element {
  const theme = useTheme();
  return (
    <Pressable
      testID={testID}
      accessibilityRole={accessibilityRole}
      accessibilityState={{ selected: active }}
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      onLayout={onLayout}
      style={[
        styles.chip,
        {
          minHeight: theme.minTouchSize,
          borderRadius: theme.radii.md,
          paddingHorizontal: theme.spacing.md,
          backgroundColor: active ? theme.colors.surfaceRaised : 'transparent',
          borderColor: active ? theme.colors.accentMuted : theme.colors.border,
        },
      ]}
    >
      <Row gap="sm" style={styles.chipContent}>
        <Row gap="xs" style={styles.chipIdentity}>
          {column !== null ? columnGlyph(column) : null}
          <Text variant="caption" color={active ? 'accent' : 'secondary'}>
            {label}
          </Text>
        </Row>
        {/* The count reads as a neutral tally, not a second accented element -
            active state is already carried by the chip's border and the name's
            color, so the pill stays flat and unbordered (no double hairline
            against the chip's own). An empty column shows no pill at all: a
            row of "0"s on a fresh board is noise, and the bare chip already
            reads as empty. */}
        {count !== undefined && count > 0 ? <Badge label={String(count)} color="muted" shape="pill" outlined={false} /> : null}
      </Row>
    </Pressable>
  );
}

/**
 * The desktop's column icon (its own icon picker, tinted with the column's
 * color), falling back to a plain color dot for a column with neither a custom
 * icon nor a matching role default - never a fill, always a small tinted glyph.
 *
 * A plain function, not a component, for the reason ColumnStrip's
 * `columnMarker` gives: the glyph is a stable registry entry, but the React
 * Compiler's static-components rule cannot see that through a function call.
 */
function columnGlyph(column: BoardColumnWire): React.JSX.Element | null {
  const ColumnIcon = getColumnIcon(column);
  if (ColumnIcon !== null) return <ColumnIcon size={CHIP_ICON_SIZE} color={column.color} strokeWidth={2} />;
  if (column.color) return <View style={[styles.colorDot, { backgroundColor: column.color }]} />;
  return null;
}

const styles = StyleSheet.create({
  chip: {
    justifyContent: 'center',
    borderWidth: StyleSheet.hairlineWidth,
  },
  chipContent: {
    alignItems: 'center',
  },
  chipIdentity: {
    alignItems: 'center',
  },
  colorDot: {
    width: CHIP_DOT_SIZE,
    height: CHIP_DOT_SIZE,
    borderRadius: CHIP_DOT_SIZE / 2,
  },
});
