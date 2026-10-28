import React from 'react';
import { StyleSheet, View } from 'react-native';
import { Text, useTheme } from '@/components';

export interface FigureCellSpec {
  key: string;
  label: string;
  /** The figure itself: plain text, or a node for a value drawn in parts (Changes' two colors). */
  value: React.ReactNode;
  accessibilityLabel: string;
}

/**
 * A row of label-over-figure cells split evenly, a hairline between each: the
 * desktop header strip's cell (an 11 px muted label over a 15 px semibold
 * figure), at the phone's caption and bodyStrong sizes. The strip and the
 * Usage row both draw with it, so the two read as one style.
 */
export function FigureRow({ cells, testID }: { cells: FigureCellSpec[]; testID?: string }): React.JSX.Element {
  const theme = useTheme();
  return (
    <View testID={testID} style={styles.row}>
      {cells.map((cell, index) => (
        <View
          key={cell.key}
          testID={testID !== undefined ? `${testID}-${cell.key}` : undefined}
          accessible
          accessibilityLabel={cell.accessibilityLabel}
          style={[
            styles.cell,
            { paddingRight: theme.spacing.xs },
            index > 0
              ? { borderLeftWidth: StyleSheet.hairlineWidth, borderLeftColor: theme.colors.border, paddingLeft: theme.spacing.sm }
              : null,
          ]}
        >
          <Text variant="caption" color="muted" numberOfLines={1}>
            {cell.label}
          </Text>
          <Text variant="bodyStrong" numberOfLines={1} style={styles.figure}>
            {cell.value}
          </Text>
        </View>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
  },
  cell: {
    flex: 1,
    minWidth: 0,
    gap: 2,
  },
  figure: {
    fontVariant: ['tabular-nums'],
  },
});
